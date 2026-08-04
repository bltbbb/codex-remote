import Foundation

public struct ConnectionState: Codable, Equatable {
    public var phase: ConnectionPhase
    public var message: String

    public init(phase: ConnectionPhase = .offline, message: String = "尚未连接") {
        self.phase = phase
        self.message = message
    }
}

public struct RemoteState: Codable, Equatable {
    public var connection: ConnectionState
    public var threads: [String: RemoteThread]
    public var threadOrder: [String]
    public var activeThreadID: String?
    public var nextThreadCursor: String?
    public var approvals: [String: ApprovalRequest]
    public var processExpanded: [String: Bool]
    public var manualExpansion: [String: Bool]
    public var lastSequence: Int64
    public var seenEventIDs: [String: Bool]
    public var lastError: String?

    public init(
        connection: ConnectionState = ConnectionState(),
        threads: [String: RemoteThread] = [:],
        threadOrder: [String] = [],
        activeThreadID: String? = nil,
        nextThreadCursor: String? = nil,
        approvals: [String: ApprovalRequest] = [:],
        processExpanded: [String: Bool] = [:],
        manualExpansion: [String: Bool] = [:],
        lastSequence: Int64 = 0,
        seenEventIDs: [String: Bool] = [:],
        lastError: String? = nil
    ) {
        self.connection = connection
        self.threads = threads
        self.threadOrder = threadOrder
        self.activeThreadID = activeThreadID
        self.nextThreadCursor = nextThreadCursor
        self.approvals = approvals
        self.processExpanded = processExpanded
        self.manualExpansion = manualExpansion
        self.lastSequence = lastSequence
        self.seenEventIDs = seenEventIDs
        self.lastError = lastError
    }

    public var currentThread: RemoteThread? {
        guard let activeThreadID else { return nil }
        return threads[activeThreadID]
    }
}

public enum RemoteReducer {
    public static func createInitialState() -> RemoteState {
        RemoteState()
    }

    public static func apply(_ message: WireMessage, to current: RemoteState) -> RemoteState {
        switch message {
        case let .event(envelope):
            return apply(envelope, to: current)
        case .request:
            return current
        case let .response(response):
            guard !response.ok, let error = response.error else { return current }
            var next = current
            next.lastError = error.message
            return next
        case .unknown:
            return current
        }
    }

    public static func apply(_ envelope: EventEnvelope, to current: RemoteState) -> RemoteState {
        guard envelope.kind == .event else { return current }
        guard !current.seenEventIDs.keys.contains(envelope.eventID), envelope.sequence > current.lastSequence else {
            return current
        }

        var next = current
        next.seenEventIDs[envelope.eventID] = true
        if next.seenEventIDs.count > 5_000 {
            let countToRemove = next.seenEventIDs.count - 5_000
            for eventID in next.seenEventIDs.keys.sorted().prefix(countToRemove) {
                next.seenEventIDs.removeValue(forKey: eventID)
            }
        }
        next.lastSequence = envelope.sequence

        switch envelope.event {
        case let .connectionStatus(value):
            next = setConnection(next, phase: value.phase, message: value.message ?? "")
        case let .threadListSnapshot(value):
            next = mergeThreadList(value.threads, nextCursor: value.nextCursor, append: value.append == true, into: next)
        case let .threadSnapshot(value):
            next = mergeThread(value.thread, into: next)
        case let .threadUpsert(value):
            next.threads[value.thread.id] = mergedThread(summary: value.thread, existing: next.threads[value.thread.id])
            next.threadOrder = [value.thread.id] + next.threadOrder.filter { $0 != value.thread.id }
        case let .threadRemoved(value):
            next.threads.removeValue(forKey: value.threadID)
            next.threadOrder.removeAll { $0 == value.threadID }
            if next.activeThreadID == value.threadID {
                next.activeThreadID = nil
            }
        case let .turnStarted(value):
            var thread = thread(for: value.threadID, in: next)
            var turn = value.turn
            if let previous = thread.turns[turn.id], turn.diff == nil {
                turn.diff = previous.diff
            }
            thread.turns[turn.id] = turn
            appendTurnID(turn.id, to: &thread)
            thread.status = "active"
            next.threads[thread.id] = thread
            next.processExpanded[turn.id] = true
        case let .turnCompleted(value):
            var thread = thread(for: value.threadID, in: next)
            var turn = value.turn
            if let previous = thread.turns[turn.id], turn.diff == nil {
                turn.diff = previous.diff
            }
            thread.turns[turn.id] = turn
            appendTurnID(turn.id, to: &thread)
            thread.status = "idle"
            next.threads[thread.id] = thread
            if next.manualExpansion[turn.id] == nil {
                next.processExpanded[turn.id] = false
            }
        case let .itemUpsert(value):
            applyItemUpsert(value, to: &next)
        case let .itemDelta(value):
            applyItemDelta(value, to: &next)
        case let .turnDiffUpdated(value):
            applyDiff(value, to: &next)
        case let .approvalRequested(value):
            next.approvals[value.approval.id] = value.approval
        case let .approvalResolved(value):
            next.approvals.removeValue(forKey: value.approvalID)
        case let .error(value):
            next.lastError = value.message
        case let .semantic(value):
            applySemantic(value, to: &next)
        case .raw, .unknown:
            break
        }

        return next
    }

    public static func setActiveThread(_ state: RemoteState, threadID: String?) -> RemoteState {
        var next = state
        next.activeThreadID = threadID
        return next
    }

    public static func setConnection(_ state: RemoteState, phase: ConnectionPhase, message: String) -> RemoteState {
        var next = state
        next.connection = ConnectionState(phase: phase, message: message)
        return next
    }

    public static func resetEventCursor(_ state: RemoteState) -> RemoteState {
        var next = state
        next.lastSequence = 0
        next.seenEventIDs.removeAll()
        return next
    }

    /// 将请求响应里的线程列表合并进状态；它不推进远程事件序号。
    public static func mergeThreadList(
        _ summaries: [RemoteThreadSummary],
        nextCursor: String?,
        append: Bool,
        into current: RemoteState
    ) -> RemoteState {
        var next = current
        next.nextThreadCursor = nextCursor
        for summary in summaries {
            next.threads[summary.id] = mergedThread(summary: summary, existing: next.threads[summary.id])
        }

        let incoming = summaries.map(\.id)
        if append {
            next.threadOrder.append(contentsOf: incoming.filter { !next.threadOrder.contains($0) })
        } else {
            next.threadOrder = incoming
        }
        return next
    }

    /// 将请求响应里的完整线程合并进状态；它不伪造远程事件序号。
    public static func mergeThread(_ thread: RemoteThread, into current: RemoteState) -> RemoteState {
        var next = current
        let merged = mergedThread(snapshot: thread, existing: next.threads[thread.id])
        next.threads[thread.id] = merged
        for turnID in merged.turnIDs {
            guard let turn = merged.turns[turnID] else { continue }
            if isTerminal(turn.status) {
                if next.manualExpansion[turnID] == nil {
                    next.processExpanded[turnID] = false
                }
            } else {
                next.processExpanded[turnID] = true
            }
        }
        if !next.threadOrder.contains(thread.id) {
            next.threadOrder.insert(thread.id, at: 0)
        }
        return next
    }

    /// 将 turn.start 的响应先合并进状态，后续实时事件仍由 apply 负责去重和推进序号。
    public static func mergeTurn(_ turn: RemoteTurn, threadID: String, into current: RemoteState) -> RemoteState {
        var next = current
        var thread = thread(for: threadID, in: next)
        var mergedTurn = turn
        if let previous = thread.turns[turn.id] {
            mergedTurn.itemIDs = previous.itemIDs + turn.itemIDs.filter { !previous.itemIDs.contains($0) }
            mergedTurn.startedAt = mergedTurn.startedAt ?? previous.startedAt
            mergedTurn.completedAt = mergedTurn.completedAt ?? previous.completedAt
            mergedTurn.durationMs = mergedTurn.durationMs ?? previous.durationMs
            mergedTurn.error = mergedTurn.error ?? previous.error
            mergedTurn.diff = mergedTurn.diff ?? previous.diff
            if isTerminal(previous.status), !isTerminal(mergedTurn.status) {
                mergedTurn.status = previous.status
            }
        }
        thread.turns[mergedTurn.id] = mergedTurn
        appendTurnID(mergedTurn.id, to: &thread)
        thread.status = isRunning(mergedTurn.status) ? "active" : "idle"
        next.threads[thread.id] = thread
        if !isTerminal(mergedTurn.status) {
            next.processExpanded[mergedTurn.id] = true
        }
        return next
    }

    public static func setTurnExpanded(_ state: RemoteState, turnID: String, expanded: Bool) -> RemoteState {
        var next = state
        next.processExpanded[turnID] = expanded
        next.manualExpansion[turnID] = expanded
        return next
    }

    private static func placeholderThread(id: String) -> RemoteThread {
        RemoteThread(
            id: id,
            sessionID: "",
            title: "正在加载...",
            preview: "",
            cwd: "",
            modelProvider: "",
            createdAt: 0,
            updatedAt: 0,
            status: "unknown",
            isPinned: false,
            source: nil
        )
    }

    private static func thread(for id: String, in state: RemoteState) -> RemoteThread {
        state.threads[id] ?? placeholderThread(id: id)
    }

    private static func mergedThread(summary: RemoteThreadSummary, existing: RemoteThread?) -> RemoteThread {
        var thread = existing ?? RemoteThread(summary: summary)
        thread.id = summary.id
        thread.sessionID = summary.sessionID
        thread.title = summary.title
        thread.preview = summary.preview
        thread.cwd = summary.cwd
        thread.modelProvider = summary.modelProvider
        thread.createdAt = summary.createdAt
        thread.updatedAt = summary.updatedAt
        thread.status = summary.status
        thread.isPinned = summary.isPinned
        thread.source = summary.source
        return thread
    }

    /// 完整快照可能与正在到达的实时事件交错。快照负责提供历史顺序，
    /// 但不能删除快照请求发出后才收到的回合、条目或更长的流式正文。
    private static func mergedThread(snapshot: RemoteThread, existing: RemoteThread?) -> RemoteThread {
        guard let existing else { return snapshot }

        var merged = snapshot
        for turnID in existing.turnIDs where !merged.turnIDs.contains(turnID) {
            merged.turnIDs.append(turnID)
        }

        for (turnID, liveTurn) in existing.turns {
            guard var snapshotTurn = merged.turns[turnID] else {
                merged.turns[turnID] = liveTurn
                continue
            }
            snapshotTurn.itemIDs.append(contentsOf: liveTurn.itemIDs.filter { !snapshotTurn.itemIDs.contains($0) })
            snapshotTurn.startedAt = snapshotTurn.startedAt ?? liveTurn.startedAt
            snapshotTurn.completedAt = snapshotTurn.completedAt ?? liveTurn.completedAt
            snapshotTurn.durationMs = snapshotTurn.durationMs ?? liveTurn.durationMs
            snapshotTurn.error = snapshotTurn.error ?? liveTurn.error
            snapshotTurn.diff = snapshotTurn.diff ?? liveTurn.diff
            if isTerminal(liveTurn.status), !isTerminal(snapshotTurn.status) {
                snapshotTurn.status = liveTurn.status
            }
            merged.turns[turnID] = snapshotTurn
        }

        for (itemID, liveItem) in existing.items {
            if let snapshotItem = merged.items[itemID] {
                merged.items[itemID] = mergedItem(snapshot: snapshotItem, live: liveItem)
            } else {
                merged.items[itemID] = liveItem
            }
        }
        return merged
    }

    private static func mergedItem(snapshot: RemoteItem, live: RemoteItem) -> RemoteItem {
        var merged = snapshot
        if (live.text?.count ?? 0) > (merged.text?.count ?? 0) {
            merged.text = live.text
        }
        if live.summary.joined().count > merged.summary.joined().count {
            merged.summary = live.summary
        }
        if live.content.joined().count > merged.content.joined().count {
            merged.content = live.content
        }
        if live.output.count > merged.output.count {
            merged.output = live.output
        }
        if live.patch.count > merged.patch.count {
            merged.patch = live.patch
        }
        if merged.changes.isEmpty, !live.changes.isEmpty {
            merged.changes = live.changes
        }
        merged.exitCode = merged.exitCode ?? live.exitCode
        merged.durationMs = merged.durationMs ?? live.durationMs
        merged.success = merged.success ?? live.success
        if isTerminal(live.status), !isTerminal(merged.status) {
            merged.status = live.status
        }
        return merged
    }

    private static func appendTurnID(_ turnID: String, to thread: inout RemoteThread) {
        if !thread.turnIDs.contains(turnID) {
            thread.turnIDs.append(turnID)
        }
    }

    private static func isTerminal(_ status: TurnStatus) -> Bool {
        switch status {
        case .completed, .failed, .interrupted:
            return true
        case .notStarted, .inProgress, .unknown(_):
            return false
        }
    }

    private static func isTerminal(_ status: ItemStatus) -> Bool {
        switch status {
        case .completed, .failed, .declined:
            return true
        case .pending, .inProgress, .unknown(_):
            return false
        }
    }

    private static func isRunning(_ status: TurnStatus) -> Bool {
        switch status {
        case .notStarted, .inProgress:
            return true
        case .completed, .failed, .interrupted, .unknown(_):
            return false
        }
    }

    private static func applyItemUpsert(_ value: ItemUpsertEvent, to state: inout RemoteState) {
        var thread = thread(for: value.threadID, in: state)
        var turn = thread.turns[value.turnID] ?? RemoteTurn(id: value.turnID, status: .inProgress)
        if !turn.itemIDs.contains(value.item.id) {
            turn.itemIDs.append(value.item.id)
        }
        thread.turns[turn.id] = turn
        appendTurnID(turn.id, to: &thread)
        thread.items[value.item.id] = value.item
        state.threads[thread.id] = thread
    }

    private static func applyItemDelta(_ value: ItemDeltaEvent, to state: inout RemoteState) {
        guard var thread = state.threads[value.threadID], var item = thread.items[value.itemID] else { return }
        switch value.target {
        case .agentMessage:
            guard item.type == .agentMessage else { return }
            item.text = appendBounded(item.text ?? "", value.delta)
        case .reasoningSummary:
            guard item.type == .reasoning else { return }
            if item.summary.isEmpty {
                item.summary = [String(value.delta.prefix(300_000))]
            } else {
                let last = item.summary.removeLast()
                item.summary.append(appendBounded(last, value.delta, limit: 300_000))
            }
        case .reasoningText:
            guard item.type == .reasoning else { return }
            if item.content.isEmpty {
                item.content = [String(value.delta.prefix(500_000))]
            } else {
                let last = item.content.removeLast()
                item.content.append(appendBounded(last, value.delta, limit: 500_000))
            }
        case .plan:
            guard item.type == .plan else { return }
            item.text = appendBounded(item.text ?? "", value.delta, limit: 300_000)
        case .commandOutput:
            guard item.type == .commandExecution else { return }
            item.output = appendBounded(item.output, value.delta)
        case .filePatch:
            guard item.type == .fileChange else { return }
            if !value.delta.isEmpty {
                item.patch = appendBounded("", value.delta, limit: 2_000_000)
            }
        case .toolOutput:
            guard item.type == .toolCall else { return }
            let prefix = item.output.isEmpty ? "" : "\n"
            item.output = appendBounded(item.output + prefix, value.delta)
        case .unknown:
            return
        }
        thread.items[item.id] = item
        state.threads[thread.id] = thread
    }

    private static func applyDiff(_ value: TurnDiffUpdatedEvent, to state: inout RemoteState) {
        var thread = thread(for: value.threadID, in: state)
        var turn = thread.turns[value.turnID] ?? RemoteTurn(id: value.turnID, status: .inProgress)
        turn.diff = value.diff
        thread.turns[turn.id] = turn
        appendTurnID(turn.id, to: &thread)
        state.threads[thread.id] = thread
    }

    private static func applySemantic(_ value: RemoteSemanticEvent, to state: inout RemoteState) {
        switch value.name {
        case .toolProgress:
            if let event = try? value.params.decode(ItemDeltaEvent.self) {
                applyItemDelta(event, to: &state)
            }
        case .turnPlanUpdated:
            if let event = try? value.params.decode(ItemUpsertEvent.self) {
                applyItemUpsert(event, to: &state)
            }
        case .turnAttachment:
            break
        case .turnFailed:
            if let event = try? value.params.decode(TurnCompletedEvent.self) {
                var thread = thread(for: event.threadID, in: state)
                var turn = event.turn
                if let previous = thread.turns[turn.id], turn.diff == nil {
                    turn.diff = previous.diff
                }
                thread.turns[turn.id] = turn
                appendTurnID(turn.id, to: &thread)
                thread.status = "idle"
                state.threads[thread.id] = thread
                if state.manualExpansion[turn.id] == nil {
                    state.processExpanded[turn.id] = false
                }
            }
        case .threadListSnapshot, .turnDiffUpdated, .approvalRequested:
            break
        }
    }

    private static func appendBounded(_ current: String, _ delta: String, limit: Int = 1_000_000) -> String {
        let next = current + delta
        guard next.count > limit else { return next }
        let head = Int(Double(limit) * 0.72)
        let tail = limit - head
        return "\(next.prefix(head))\n... 中间输出已截断 ...\n\(next.suffix(tail))"
    }
}

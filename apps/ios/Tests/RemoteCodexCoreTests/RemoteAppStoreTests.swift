import Foundation
import XCTest
@testable import RemoteCodexCore

@MainActor
final class RemoteAppStoreTests: XCTestCase {
    func testConnectionCallbacksAndEventsUpdateState() async throws {
        let context = makeStore()
        try await connectAndResume(context)

        XCTAssertEqual(context.store.state.connection.phase, .online)

        let summary = makeSummary()
        context.socket.emit(.event(EventEnvelope(
            sequence: 1,
            eventID: "thread-list",
            event: .threadListSnapshot(ThreadListSnapshotEvent(threads: [summary], nextCursor: nil))
        )))
        await waitUntil { context.store.state.threadOrder == [summary.id] }

        XCTAssertEqual(context.store.state.threads[summary.id]?.title, "线程 A")
    }

    func testLoadThreadsMergesResponseAndSendsExpectedParams() async throws {
        let context = makeStore()
        try await connectAndResume(context)

        let summary = makeSummary(id: "thread-search")
        let response = JSONValue.object([
            "threads": .array([try jsonValue(summary)]),
            "nextCursor": .string("next-cursor")
        ])

        let loadTask = Task {
            await context.store.loadThreads(limit: 25, searchTerm: "搜索", cursor: "cursor-1")
        }
        await waitUntil { self.requests(in: context, method: .threadList).count == 1 }
        let request = try XCTUnwrap(requests(in: context, method: .threadList).first)

        XCTAssertEqual(request.params.objectValue?["limit"]?.intValue, 25)
        XCTAssertEqual(request.params.objectValue?["searchTerm"]?.stringValue, "搜索")
        XCTAssertEqual(request.params.objectValue?["cursor"]?.stringValue, "cursor-1")

        context.socket.emit(.response(ServerResponseEnvelope(id: request.id, ok: true, result: response)))
        let result = await loadTask.value

        XCTAssertEqual(result?.threads.map(\.id), ["thread-search"])
        XCTAssertEqual(result?.nextCursor, "next-cursor")
        XCTAssertEqual(context.store.state.threadOrder, ["thread-search"])
    }

    func testLoadThreadAcceptsLoadingAckWithoutRecordingError() async throws {
        let context = makeStore()
        try await connectAndResume(context)

        let loadTask = Task {
            await context.store.loadThread("thread-loading")
        }
        await waitUntil { self.requests(in: context, method: .threadRead).count == 1 }
        let request = try XCTUnwrap(requests(in: context, method: .threadRead).first)

        context.socket.emit(.response(ServerResponseEnvelope(
            id: request.id,
            ok: true,
            result: .object([
                "threadId": .string("thread-loading"),
                "delivered": .bool(false),
                "loading": .bool(true)
            ])
        )))
        let thread = await loadTask.value

        XCTAssertNil(thread)
        XCTAssertEqual(context.store.state.activeThreadID, "thread-loading")
        XCTAssertNil(context.store.state.lastError)
    }

    func testCreateThreadAndInterruptCurrentTurnRequests() async throws {
        var activeThread = makeThread(id: "thread-active")
        let activeTurn = RemoteTurn(id: "turn-active", status: .inProgress)
        activeThread.turnIDs = [activeTurn.id]
        activeThread.turns[activeTurn.id] = activeTurn
        activeThread.status = "active"

        var state = RemoteReducer.createInitialState()
        state = RemoteReducer.mergeThread(activeThread, into: state)
        state = RemoteReducer.setActiveThread(state, threadID: activeThread.id)
        let context = makeStore(initialState: state)
        try await connectAndResume(context)

        let interruptTask = Task {
            await context.store.interruptCurrentTurn()
        }
        await waitUntil { self.requests(in: context, method: .turnInterrupt).count == 1 }
        let interruptRequest = try XCTUnwrap(requests(in: context, method: .turnInterrupt).first)
        XCTAssertEqual(interruptRequest.params.objectValue?["threadId"]?.stringValue, "thread-active")
        XCTAssertEqual(interruptRequest.params.objectValue?["turnId"]?.stringValue, "turn-active")
        context.socket.emit(.response(ServerResponseEnvelope(
            id: interruptRequest.id,
            ok: true,
            result: .object(["interrupted": .bool(true)])
        )))
        let interrupted = await interruptTask.value
        XCTAssertEqual(interrupted, true)

        let createTask = Task {
            await context.store.createThread(cwd: "E:\\myproject\\codex-remote")
        }
        await waitUntil { self.requests(in: context, method: .threadCreate).count == 1 }
        let createRequest = try XCTUnwrap(requests(in: context, method: .threadCreate).first)
        XCTAssertEqual(createRequest.params.objectValue?["cwd"]?.stringValue, "E:\\myproject\\codex-remote")
        let createdThread = makeThread(id: "thread-created")
        context.socket.emit(.response(ServerResponseEnvelope(
            id: createRequest.id,
            ok: true,
            result: .object(["thread": try jsonValue(createdThread)])
        )))
        let created = await createTask.value
        XCTAssertEqual(created?.id, "thread-created")
        XCTAssertEqual(context.store.state.activeThreadID, "thread-created")
    }

    func testSendTurnReusesClientRequestIDAfterFailure() async throws {
        var state = RemoteReducer.createInitialState()
        let thread = makeThread(id: "thread-send")
        state = RemoteReducer.mergeThread(thread, into: state)
        state = RemoteReducer.setActiveThread(state, threadID: thread.id)
        let context = makeStore(initialState: state)
        try await connectAndResume(context)

        let firstTask = Task {
            await context.store.sendTurn(text: "继续")
        }
        await waitUntil { self.requests(in: context, method: .turnStart).count == 1 }
        let firstRequest = try XCTUnwrap(requests(in: context, method: .turnStart).first)
        let firstClientRequestID = try XCTUnwrap(firstRequest.params.objectValue?["clientRequestId"]?.stringValue)

        context.socket.emit(.response(ServerResponseEnvelope(
            id: firstRequest.id,
            ok: false,
            error: ResponseError(code: "temporary", message: "暂时失败")
        )))
        let firstResult = await firstTask.value
        XCTAssertNil(firstResult)
        XCTAssertEqual(context.store.state.lastError, "[temporary] 暂时失败")

        let secondTask = Task {
            await context.store.sendTurn(text: "继续")
        }
        await waitUntil { self.requests(in: context, method: .turnStart).count == 2 }
        let secondRequest = try XCTUnwrap(requests(in: context, method: .turnStart).last)
        XCTAssertEqual(secondRequest.params.objectValue?["clientRequestId"]?.stringValue, firstClientRequestID)

        let turn = RemoteTurn(id: "turn-send", status: .inProgress)
        context.socket.emit(.response(ServerResponseEnvelope(
            id: secondRequest.id,
            ok: true,
            result: .object(["turn": try jsonValue(turn)])
        )))
        let started = await secondTask.value

        XCTAssertEqual(started?.id, "turn-send")
        XCTAssertEqual(context.store.state.threads[thread.id]?.turnIDs, ["turn-send"])
    }

    func testResolveApprovalRemovesApprovalFromState() async throws {
        let approval = ApprovalRequest(
            id: "approval-1",
            method: "item/permissions/requestApproval",
            threadID: "thread-approval",
            turnID: "turn-approval",
            itemID: "item-approval",
            title: "允许命令",
            description: "需要确认",
            availableDecisions: ["accept", "decline"]
        )
        var state = RemoteReducer.createInitialState()
        state.approvals[approval.id] = approval
        let context = makeStore(initialState: state)
        try await connectAndResume(context)

        let resolveTask = Task {
            await context.store.resolveApproval(approval.id, decision: "accept")
        }
        await waitUntil { self.requests(in: context, method: .approvalResolve).count == 1 }
        let request = try XCTUnwrap(requests(in: context, method: .approvalResolve).first)

        context.socket.emit(.response(ServerResponseEnvelope(
            id: request.id,
            ok: true,
            result: .object([
                "approvalId": .string(approval.id),
                "decision": .string("accept")
            ])
        )))
        let resolved = await resolveTask.value

        XCTAssertEqual(resolved, true)
        XCTAssertNil(context.store.state.approvals[approval.id])
    }

    private func makeStore(initialState: RemoteState = RemoteReducer.createInitialState()) -> StoreTestContext {
        let socket = StoreFakeRemoteWebSocket()
        let scheduler = StoreManualRemoteTransportScheduler()
        let store = RemoteAppStore(
            endpoint: RemoteWebSocketEndpoint(url: URL(string: "ws://bridge.example/ws")!, deviceToken: "test-token"),
            scheduler: scheduler,
            socketFactory: { _ in socket },
            requestTimeout: 15,
            ackDebounce: 0.1,
            clientID: "store-client",
            initialSequence: initialState.lastSequence,
            initialState: initialState
        )
        return StoreTestContext(store: store, socket: socket, scheduler: scheduler)
    }

    private func connectAndResume(_ context: StoreTestContext) async throws {
        await context.store.connect()
        await waitUntil { self.requests(in: context, method: .eventsResume).count == 1 }
        let request = try XCTUnwrap(requests(in: context, method: .eventsResume).first)
        context.socket.emit(.response(ServerResponseEnvelope(
            id: request.id,
            ok: true,
            result: .object([
                "events": .array([]),
                "latestSequence": .number(Double(context.store.state.lastSequence)),
                "resetRequired": .bool(false)
            ])
        )))
        await waitUntil { context.store.state.connection.phase == .online }
    }

    private func requests(in context: StoreTestContext, method: ClientMethod) -> [ClientRequestEnvelope] {
        context.socket.requests.filter { $0.method == method }
    }

    private func waitUntil(_ condition: @escaping () async -> Bool) async {
        for _ in 0..<100 {
            if await condition() { return }
            await Task.yield()
        }
    }

    private func makeSummary(id: String = "thread-a") -> RemoteThreadSummary {
        RemoteThreadSummary(
            id: id,
            sessionID: "session-\(id)",
            title: "线程 A",
            preview: "预览",
            cwd: "E:\\myproject\\codex-remote",
            modelProvider: "custom",
            createdAt: 1,
            updatedAt: 2,
            status: "idle",
            isPinned: false
        )
    }

    private func makeThread(id: String = "thread-a") -> RemoteThread {
        RemoteThread(
            id: id,
            sessionID: "session-\(id)",
            title: "线程 A",
            preview: "预览",
            cwd: "E:\\myproject\\codex-remote",
            modelProvider: "custom",
            createdAt: 1,
            updatedAt: 2,
            status: "idle",
            isPinned: false
        )
    }

    private func jsonValue<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
}

private struct StoreTestContext {
    let store: RemoteAppStore
    let socket: StoreFakeRemoteWebSocket
    let scheduler: StoreManualRemoteTransportScheduler
}

private final class StoreFakeRemoteWebSocket: RemoteWebSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((Result<RemoteSocketMessage, Error>) -> Void)?
    var onClose: ((Error?) -> Void)?
    var sentMessages: [RemoteSocketMessage] = []
    var closeCount = 0

    var requests: [ClientRequestEnvelope] {
        sentMessages.compactMap { message in
            guard case let .text(text) = message else { return nil }
            guard let data = text.data(using: .utf8) else { return nil }
            guard let wireMessage = try? JSONDecoder().decode(WireMessage.self, from: data),
                  case let .request(request) = wireMessage else { return nil }
            return request
        }
    }

    func connect() {
        onOpen?()
    }

    func send(_ message: RemoteSocketMessage) async throws {
        sentMessages.append(message)
    }

    func close() {
        closeCount += 1
        onClose?(nil)
    }

    func emit(_ message: WireMessage) {
        let data = try! JSONEncoder().encode(message)
        onMessage?(.success(.text(String(decoding: data, as: UTF8.self))))
    }
}

private final class StoreManualScheduledTask: RemoteTransportScheduledTask {
    private(set) var isCancelled = false

    func cancel() {
        isCancelled = true
    }
}

private final class StoreManualRemoteTransportScheduler: RemoteTransportScheduler {
    private struct Entry {
        let delay: TimeInterval
        let task: StoreManualScheduledTask
        let operation: () -> Void
    }

    private var entries: [Entry] = []

    @discardableResult
    func schedule(after delay: TimeInterval, operation: @escaping () -> Void) -> any RemoteTransportScheduledTask {
        let task = StoreManualScheduledTask()
        entries.append(Entry(delay: delay, task: task, operation: operation))
        return task
    }
}

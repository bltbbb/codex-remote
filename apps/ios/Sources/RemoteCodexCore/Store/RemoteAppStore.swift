import Foundation

#if canImport(Combine)
import Combine

public typealias RemoteAppStoreObservableObject = ObservableObject
#else
public protocol RemoteAppStoreObservableObject: AnyObject {}
#endif

public struct RemoteAppStoreCallbacks {
    public let onEvent: RemoteEventHandler
    public let onSequenceReset: () -> Void
    public let onConnectionChange: RemoteConnectionHandler

    public init(
        onEvent: @escaping RemoteEventHandler,
        onSequenceReset: @escaping () -> Void,
        onConnectionChange: @escaping RemoteConnectionHandler
    ) {
        self.onEvent = onEvent
        self.onSequenceReset = onSequenceReset
        self.onConnectionChange = onConnectionChange
    }
}

public typealias RemoteAppStoreClientFactory = (RemoteAppStoreCallbacks) -> RemoteWebSocketClient

public enum RemoteAppStoreError: Error, Equatable, LocalizedError {
    case invalidInput(String)
    case invalidResponse(method: ClientMethod, detail: String)
    case encodingFailed(method: ClientMethod, detail: String)
    case missingActiveThread
    case missingActiveTurn

    public var errorDescription: String? {
        switch self {
        case let .invalidInput(message):
            return message
        case let .invalidResponse(method, detail):
            return "\(method.rawValue) 响应格式无效：\(detail)"
        case let .encodingFailed(method, detail):
            return "\(method.rawValue) 请求编码失败：\(detail)"
        case .missingActiveThread:
            return "请先选择线程"
        case .missingActiveTurn:
            return "当前线程没有可中断的回合"
        }
    }
}

public struct RemoteThreadListResult: Codable, Equatable {
    public let threads: [RemoteThreadSummary]
    public let nextCursor: String?

    public init(threads: [RemoteThreadSummary], nextCursor: String?) {
        self.threads = threads
        self.nextCursor = nextCursor
    }
}

@MainActor
public final class RemoteAppStore: RemoteAppStoreObservableObject {
    #if canImport(Combine)
    @Published
    #endif
    public private(set) var state: RemoteState

    private let client: RemoteWebSocketClient
    private let callbackBridge: RemoteAppStoreCallbackBridge
    private var pendingTurnSubmission: PendingTurnSubmission?

    public var connectionPhase: ConnectionPhase {
        state.connection.phase
    }

    public var lastErrorMessage: String? {
        state.lastError
    }

    public var currentThread: RemoteThread? {
        state.currentThread
    }

    public init(
        initialState: RemoteState = RemoteReducer.createInitialState(),
        clientFactory: @escaping RemoteAppStoreClientFactory
    ) {
        let bridge = RemoteAppStoreCallbackBridge()
        let callbacks = RemoteAppStoreCallbacks(
            onEvent: { [weak bridge] event in
                bridge?.receive(event: event)
            },
            onSequenceReset: { [weak bridge] in
                bridge?.receiveSequenceReset()
            },
            onConnectionChange: { [weak bridge] phase, message in
                bridge?.receiveConnectionChange(phase: phase, message: message)
            }
        )

        self.state = initialState
        self.callbackBridge = bridge
        self.client = clientFactory(callbacks)
        bridge.store = self
    }

    public convenience init(
        endpoint: RemoteWebSocketEndpoint,
        scheduler: any RemoteTransportScheduler = DispatchRemoteTransportScheduler(),
        socketFactory: @escaping RemoteWebSocketFactory = { URLSessionRemoteWebSocket(endpoint: $0) },
        requestTimeout: TimeInterval = 15,
        ackDebounce: TimeInterval = 0.1,
        clientID: String = RemoteProtocol.makeRequestID(),
        initialSequence: Int64? = nil,
        initialState: RemoteState = RemoteReducer.createInitialState()
    ) {
        let factory: RemoteAppStoreClientFactory = { callbacks in
            RemoteWebSocketClient(
                endpoint: endpoint,
                scheduler: scheduler,
                socketFactory: socketFactory,
                requestTimeout: requestTimeout,
                ackDebounce: ackDebounce,
                clientID: clientID,
                initialSequence: initialSequence ?? initialState.lastSequence,
                onEvent: callbacks.onEvent,
                onSequenceReset: callbacks.onSequenceReset,
                onConnectionChange: callbacks.onConnectionChange
            )
        }
        self.init(initialState: initialState, clientFactory: factory)
    }

    public func connect() async {
        await client.connect()
    }

    public func close() async {
        await client.close()
    }

    public func clearError() {
        var next = state
        next.lastError = nil
        state = next
    }

    public func selectThread(_ threadID: String?) {
        state = RemoteReducer.setActiveThread(state, threadID: threadID)
    }

    @discardableResult
    public func sendRequest(_ method: ClientMethod, params: JSONValue = .object([:])) async -> JSONValue? {
        await performRequest(method, params: params)
    }

    @discardableResult
    public func loadThreads(
        limit: Int = 100,
        searchTerm: String? = nil,
        cursor: String? = nil
    ) async -> RemoteThreadListResult? {
        var object: [String: JSONValue] = [
            "limit": .number(Double(max(1, limit)))
        ]
        if let searchTerm {
            object["searchTerm"] = .string(searchTerm)
        }
        if let cursor {
            object["cursor"] = .string(cursor)
        }

        guard let result = await performRequest(.threadList, params: .object(object)) else { return nil }
        guard let response = decodeResult(result, method: .threadList, as: ThreadListResponse.self) else { return nil }

        state = RemoteReducer.mergeThreadList(
            response.threads,
            nextCursor: response.nextCursor,
            append: cursor != nil,
            into: state
        )
        return RemoteThreadListResult(threads: response.threads, nextCursor: response.nextCursor)
    }

    @discardableResult
    public func loadThread(_ threadID: String) async -> RemoteThread? {
        guard !threadID.isEmpty else {
            recordError(RemoteAppStoreError.invalidInput("线程 ID 不能为空"))
            return nil
        }

        state = RemoteReducer.setActiveThread(state, threadID: threadID)
        guard let result = await performRequest(
            .threadRead,
            params: .object(["threadId": .string(threadID)])
        ) else { return nil }
        guard let response = decodeResult(result, method: .threadRead, as: ThreadReadResponse.self) else { return nil }
        guard let thread = response.thread else {
            if response.loading == true { return nil }
            recordError(RemoteAppStoreError.invalidResponse(method: .threadRead, detail: "缺少 thread"))
            return nil
        }

        state = RemoteReducer.mergeThread(thread, into: state)
        state = RemoteReducer.setActiveThread(state, threadID: thread.id)
        return thread
    }

    @discardableResult
    public func createThread(cwd: String) async -> RemoteThread? {
        guard !cwd.isEmpty else {
            recordError(RemoteAppStoreError.invalidInput("工作目录不能为空"))
            return nil
        }

        guard let result = await performRequest(
            .threadCreate,
            params: .object(["cwd": .string(cwd)])
        ) else { return nil }
        guard let response = decodeResult(result, method: .threadCreate, as: ThreadResponse.self) else { return nil }

        state = RemoteReducer.mergeThread(response.thread, into: state)
        state = RemoteReducer.setActiveThread(state, threadID: response.thread.id)
        return response.thread
    }

    @discardableResult
    public func sendTurn(text: String, attachments: [RemoteAttachment] = []) async -> RemoteTurn? {
        guard let threadID = state.activeThreadID, !threadID.isEmpty else {
            recordError(RemoteAppStoreError.missingActiveThread)
            return nil
        }
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty else {
            recordError(RemoteAppStoreError.invalidInput("消息内容不能为空"))
            return nil
        }

        let pending = pendingTurnSubmission
        let clientRequestID = pending?.matches(threadID: threadID, text: text, attachments: attachments) == true
            ? pending?.clientRequestID ?? RemoteProtocol.makeRequestID()
            : RemoteProtocol.makeRequestID()
        pendingTurnSubmission = PendingTurnSubmission(
            threadID: threadID,
            text: text,
            attachments: attachments,
            clientRequestID: clientRequestID
        )
        let parameters = TurnStartParameters(
            threadID: threadID,
            text: text,
            clientRequestID: clientRequestID,
            attachments: attachments
        )
        guard let params = encodeJSONValue(parameters, method: .turnStart) else { return nil }
        guard let result = await performRequest(.turnStart, params: params) else { return nil }
        guard let response = decodeResult(result, method: .turnStart, as: TurnStartResponse.self) else { return nil }

        if pendingTurnSubmission?.clientRequestID == clientRequestID {
            pendingTurnSubmission = nil
        }
        state = RemoteReducer.mergeTurn(response.turn, threadID: threadID, into: state)
        return response.turn
    }

    @discardableResult
    public func interruptCurrentTurn() async -> Bool? {
        guard let threadID = state.activeThreadID, !threadID.isEmpty else {
            recordError(RemoteAppStoreError.missingActiveThread)
            return nil
        }
        guard let thread = state.threads[threadID] else {
            recordError(RemoteAppStoreError.missingActiveThread)
            return nil
        }
        guard let turnID = interruptibleTurnID(in: thread) else {
            recordError(RemoteAppStoreError.missingActiveTurn)
            return nil
        }

        let params = JSONValue.object([
            "threadId": .string(threadID),
            "turnId": .string(turnID)
        ])
        guard let result = await performRequest(.turnInterrupt, params: params) else { return nil }
        guard let response = decodeResult(result, method: .turnInterrupt, as: InterruptResponse.self) else { return nil }
        return response.interrupted
    }

    @discardableResult
    public func resolveApproval(_ approvalID: String, decision: String) async -> Bool? {
        guard !approvalID.isEmpty, !decision.isEmpty else {
            recordError(RemoteAppStoreError.invalidInput("审批 ID 和决策不能为空"))
            return nil
        }

        let params = JSONValue.object([
            "approvalId": .string(approvalID),
            "decision": .string(decision)
        ])
        guard let result = await performRequest(.approvalResolve, params: params) else { return nil }
        guard let response = decodeResult(result, method: .approvalResolve, as: ApprovalResolveResponse.self) else { return nil }
        if response.approvalID == approvalID {
            var next = state
            next.approvals.removeValue(forKey: approvalID)
            state = next
        }
        return response.approvalID == approvalID && response.decision == decision
    }

    private func performRequest(_ method: ClientMethod, params: JSONValue) async -> JSONValue? {
        do {
            return try await client.sendRequest(method, params: params)
        } catch {
            recordError(error)
            return nil
        }
    }

    private func decodeResult<T: Decodable>(
        _ result: JSONValue?,
        method: ClientMethod,
        as type: T.Type
    ) -> T? {
        guard let result else {
            recordError(RemoteAppStoreError.invalidResponse(method: method, detail: "缺少 result"))
            return nil
        }
        do {
            return try result.decode(type)
        } catch {
            recordError(RemoteAppStoreError.invalidResponse(method: method, detail: error.localizedDescription))
            return nil
        }
    }

    private func encodeJSONValue<T: Encodable>(_ value: T, method: ClientMethod) -> JSONValue? {
        do {
            let data = try JSONEncoder().encode(value)
            return try JSONDecoder().decode(JSONValue.self, from: data)
        } catch {
            recordError(RemoteAppStoreError.encodingFailed(method: method, detail: error.localizedDescription))
            return nil
        }
    }

    private func recordError(_ error: Error) {
        var next = state
        next.lastError = error.localizedDescription
        state = next
    }

    private func receive(event: EventEnvelope) {
        state = RemoteReducer.apply(event, to: state)
    }

    private func receiveSequenceReset() {
        state = RemoteReducer.resetEventCursor(state)
    }

    private func receiveConnectionChange(phase: ConnectionPhase, message: String) {
        var next = RemoteReducer.setConnection(state, phase: phase, message: message)
        if phase == .error {
            next.lastError = message
        }
        state = next
    }

    private func interruptibleTurnID(in thread: RemoteThread) -> String? {
        let turns = thread.turnIDs.reversed().compactMap { thread.turns[$0] }
        if let active = turns.first(where: { $0.status == .inProgress }) {
            return active.id
        }
        return turns.first(where: { $0.status == .notStarted })?.id
    }
}

private struct ThreadListResponse: Codable {
    let threads: [RemoteThreadSummary]
    let nextCursor: String?
}

private struct ThreadResponse: Codable {
    let thread: RemoteThread
}

private struct ThreadReadResponse: Codable {
    let thread: RemoteThread?
    let loading: Bool?
}

private struct TurnStartResponse: Codable {
    let turn: RemoteTurn
    let deduplicated: Bool?
}

private struct InterruptResponse: Codable {
    let interrupted: Bool
}

private struct ApprovalResolveResponse: Codable {
    let approvalID: String
    let decision: String

    private enum CodingKeys: String, CodingKey {
        case approvalID = "approvalId"
        case decision
    }
}

private struct PendingTurnSubmission: Equatable {
    let threadID: String
    let text: String
    let attachments: [RemoteAttachment]
    let clientRequestID: String

    func matches(threadID: String, text: String, attachments: [RemoteAttachment]) -> Bool {
        self.threadID == threadID && self.text == text && self.attachments == attachments
    }
}

private final class RemoteAppStoreCallbackBridge: @unchecked Sendable {
    weak var store: RemoteAppStore?

    func receive(event: EventEnvelope) {
        Task { @MainActor in
            self.store?.receive(event: event)
        }
    }

    func receiveSequenceReset() {
        Task { @MainActor in
            self.store?.receiveSequenceReset()
        }
    }

    func receiveConnectionChange(phase: ConnectionPhase, message: String) {
        Task { @MainActor in
            self.store?.receiveConnectionChange(phase: phase, message: message)
        }
    }
}

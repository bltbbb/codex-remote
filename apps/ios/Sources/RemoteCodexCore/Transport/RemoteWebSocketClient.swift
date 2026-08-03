import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum RemoteSocketMessage {
    case text(String)
    case data(Data)
}

public enum RemoteWebSocketClientError: Error, Equatable, LocalizedError {
    case notConnected
    case clientClosed
    case connectionClosed
    case requestTimedOut(method: String)
    case transport(String)
    case invalidMessage(String)
    case remote(code: String, message: String, details: JSONValue?)

    public var errorDescription: String? {
        switch self {
        case .notConnected:
            return "电脑尚未连接"
        case .clientClosed:
            return "客户端已关闭"
        case .connectionClosed:
            return "连接已关闭"
        case let .requestTimedOut(method):
            return "远程请求超时：\(method)"
        case let .transport(message):
            return message
        case let .invalidMessage(message):
            return "远程消息无效：\(message)"
        case let .remote(code, message, _):
            return code.isEmpty ? message : "[\(code)] \(message)"
        }
    }
}

public protocol RemoteWebSocket: AnyObject {
    var onOpen: (() -> Void)? { get set }
    var onMessage: ((Result<RemoteSocketMessage, Error>) -> Void)? { get set }
    var onClose: ((Error?) -> Void)? { get set }

    func connect()
    func send(_ message: RemoteSocketMessage) async throws
    func close()
}

public struct RemoteWebSocketEndpoint: Equatable {
    public let url: URL
    public let deviceToken: String?

    public init(url: URL, deviceToken: String? = nil) {
        self.url = url
        self.deviceToken = deviceToken
    }

    /// 与 Web 客户端保持一致：安全连接使用子协议，非安全连接才使用查询参数。
    public var requestURL: URL {
        guard let deviceToken, url.scheme?.lowercased() != "wss" else { return url }
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        var queryItems = components.queryItems ?? []
        if let index = queryItems.firstIndex(where: { $0.name == "token" }) {
            queryItems[index] = URLQueryItem(name: "token", value: deviceToken)
        } else {
            queryItems.append(URLQueryItem(name: "token", value: deviceToken))
        }
        components.queryItems = queryItems
        return components.url ?? url
    }

    public var subprotocols: [String] {
        var protocols = ["codex-remote"]
        guard let deviceToken, url.scheme?.lowercased() == "wss" else { return protocols }
        protocols.append("token.\(deviceToken)")
        return protocols
    }
}

public protocol RemoteTransportScheduledTask: AnyObject {
    func cancel()
}

public protocol RemoteTransportScheduler: AnyObject {
    @discardableResult
    func schedule(after delay: TimeInterval, operation: @escaping () -> Void) -> any RemoteTransportScheduledTask
}

private final class DispatchScheduledTask: RemoteTransportScheduledTask {
    private let workItem: DispatchWorkItem

    init(workItem: DispatchWorkItem) {
        self.workItem = workItem
    }

    func cancel() {
        workItem.cancel()
    }
}

public final class DispatchRemoteTransportScheduler: RemoteTransportScheduler {
    private let queue: DispatchQueue

    public init(queue: DispatchQueue = .main) {
        self.queue = queue
    }

    @discardableResult
    public func schedule(after delay: TimeInterval, operation: @escaping () -> Void) -> any RemoteTransportScheduledTask {
        let workItem = DispatchWorkItem(block: operation)
        queue.asyncAfter(deadline: .now() + max(0, delay), execute: workItem)
        return DispatchScheduledTask(workItem: workItem)
    }
}

public final class URLSessionRemoteWebSocket: NSObject, RemoteWebSocket, URLSessionWebSocketDelegate {
    public var onOpen: (() -> Void)?
    public var onMessage: ((Result<RemoteSocketMessage, Error>) -> Void)?
    public var onClose: ((Error?) -> Void)?

    private let endpoint: RemoteWebSocketEndpoint
    private let configuration: URLSessionConfiguration
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var closeNotified = false

    public init(endpoint: RemoteWebSocketEndpoint, configuration: URLSessionConfiguration = .default) {
        self.endpoint = endpoint
        self.configuration = configuration
    }

    public func connect() {
        guard task == nil else { return }
        closeNotified = false
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: endpoint.requestURL, protocols: endpoint.subprotocols)
        self.session = session
        self.task = task
        task.resume()
    }

    public func send(_ message: RemoteSocketMessage) async throws {
        guard let task else { throw RemoteWebSocketClientError.notConnected }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            task.send(message.urlSessionMessage) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    public func close() {
        guard task != nil || session != nil else { return }
        task?.cancel(with: .normalClosure, reason: nil)
        finish(error: nil)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard task === webSocketTask else { return }
        onOpen?()
        receiveNext(from: webSocketTask)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard task === webSocketTask else { return }
        finish(error: RemoteWebSocketClientError.connectionClosed)
    }

    private func receiveNext(from task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self, self.task === task else { return }
            switch result {
            case let .success(message):
                switch message {
                case let .string(text):
                    self.onMessage?(.success(.text(text)))
                case let .data(data):
                    self.onMessage?(.success(.data(data)))
                @unknown default:
                    self.onMessage?(.failure(RemoteWebSocketClientError.invalidMessage("未知 WebSocket 消息")))
                }
                self.receiveNext(from: task)
            case let .failure(error):
                self.onMessage?(.failure(error))
                self.finish(error: error)
            }
        }
    }

    private func finish(error: Error?) {
        guard !closeNotified else { return }
        closeNotified = true
        let session = self.session
        self.task = nil
        self.session = nil
        session?.invalidateAndCancel()
        onClose?(error)
    }
}

private extension RemoteSocketMessage {
    var urlSessionMessage: URLSessionWebSocketTask.Message {
        switch self {
        case let .text(text): return .string(text)
        case let .data(data): return .data(data)
        }
    }
}

public typealias RemoteWebSocketFactory = (RemoteWebSocketEndpoint) -> any RemoteWebSocket
public typealias RemoteEventHandler = (EventEnvelope) -> Void
public typealias RemoteConnectionHandler = (ConnectionPhase, String) -> Void

public actor RemoteWebSocketClient {
    private struct PendingRequest {
        let method: ClientMethod
        let timeoutTask: any RemoteTransportScheduledTask
        let continuation: CheckedContinuation<JSONValue?, Error>
    }

    private struct EventsResumeResult: Codable {
        var events: [EventEnvelope]?
        var latestSequence: Int64?
        var resetRequired: Bool?
    }

    private let endpoint: RemoteWebSocketEndpoint
    private let scheduler: any RemoteTransportScheduler
    private let socketFactory: RemoteWebSocketFactory
    private let requestTimeout: TimeInterval
    private let ackDebounce: TimeInterval
    private let onEvent: RemoteEventHandler
    private let onSequenceReset: () -> Void
    private let onConnectionChange: RemoteConnectionHandler

    private var socket: (any RemoteWebSocket)?
    private var connectionGeneration = 0
    private var resuming = false
    private var queuedEvents: [EventEnvelope] = []
    private var pending: [String: PendingRequest] = [:]
    private var ackTask: (any RemoteTransportScheduledTask)?
    private var seenEventIDs: [String: Int64] = [:]

    public let clientID: String
    public private(set) var phase: ConnectionPhase = .offline
    public private(set) var lastSequence: Int64

    public init(
        endpoint: RemoteWebSocketEndpoint,
        scheduler: any RemoteTransportScheduler = DispatchRemoteTransportScheduler(),
        socketFactory: @escaping RemoteWebSocketFactory = { URLSessionRemoteWebSocket(endpoint: $0) },
        requestTimeout: TimeInterval = 15,
        ackDebounce: TimeInterval = 0.1,
        clientID: String = RemoteProtocol.makeRequestID(),
        initialSequence: Int64 = 0,
        onEvent: @escaping (EventEnvelope) -> Void = { _ in },
        onSequenceReset: @escaping () -> Void = {},
        onConnectionChange: @escaping (ConnectionPhase, String) -> Void = { _, _ in }
    ) {
        self.endpoint = endpoint
        self.scheduler = scheduler
        self.socketFactory = socketFactory
        self.requestTimeout = requestTimeout
        self.ackDebounce = ackDebounce
        self.clientID = clientID
        self.lastSequence = initialSequence
        self.onEvent = onEvent
        self.onSequenceReset = onSequenceReset
        self.onConnectionChange = onConnectionChange
    }

    public func connect() {
        guard socket == nil, phase != .connecting, phase != .online else { return }

        connectionGeneration += 1
        let generation = connectionGeneration
        let nextSocket = socketFactory(endpoint)
        socket = nextSocket
        phase = .connecting
        onConnectionChange(.connecting, "正在连接电脑")

        nextSocket.onOpen = { [weak self] in
            Task { await self?.handleSocketOpen(generation: generation) }
        }
        nextSocket.onMessage = { [weak self] result in
            Task { await self?.handleSocketMessage(generation: generation, result: result) }
        }
        nextSocket.onClose = { [weak self] error in
            Task { await self?.handleSocketClose(generation: generation, error: error) }
        }
        nextSocket.connect()
    }

    public func close() {
        connectionGeneration += 1
        let previousSocket = socket
        socket = nil
        resuming = false
        queuedEvents.removeAll()
        cancelScheduledAck()
        failAllPending(with: RemoteWebSocketClientError.clientClosed)
        previousSocket?.close()
        phase = .offline
        onConnectionChange(.offline, "客户端已关闭")
    }

    public func sendRequest(
        _ method: ClientMethod,
        params: JSONValue = .object([:]),
        timeout: TimeInterval? = nil
    ) async throws -> JSONValue? {
        guard let socket, phase == .online else {
            throw RemoteWebSocketClientError.notConnected
        }

        let request = RemoteProtocol.makeRequest(method: method, params: params)
        let data = try JSONEncoder().encode(WireMessage.request(request))
        let outgoing = RemoteSocketMessage.text(String(decoding: data, as: UTF8.self))
        let timeoutValue = timeout ?? requestTimeout

        return try await withCheckedThrowingContinuation { continuation in
            let timeoutTask = scheduler.schedule(after: timeoutValue) { [weak self] in
                Task { await self?.timeoutRequest(id: request.id) }
            }
            pending[request.id] = PendingRequest(
                method: method,
                timeoutTask: timeoutTask,
                continuation: continuation
            )
            Task { [weak self, socket] in
                do {
                    try await socket.send(outgoing)
                } catch {
                    await self?.handleSendFailure(id: request.id, error: error)
                }
            }
        }
    }

    private func handleSocketOpen(generation: Int) {
        guard generation == connectionGeneration, socket != nil else { return }
        phase = .online
        resuming = true
        Task { [weak self] in
            await self?.resumeEvents(generation: generation)
        }
    }

    private func resumeEvents(generation: Int) async {
        let params = JSONValue.object([
            "afterSequence": .number(Double(lastSequence)),
            "clientId": .string(clientID)
        ])

        do {
            if let result = try await sendRequest(.eventsResume, params: params) {
                let response = try result.decode(EventsResumeResult.self)
                if response.resetRequired == true || (response.latestSequence ?? lastSequence) < lastSequence {
                    resetSequence()
                } else {
                    queuedEvents.append(contentsOf: response.events ?? [])
                }
            }
        } catch {
            // 旧 Bridge 可能没有重放能力；实时事件仍应继续交给上层。
        }

        guard generation == connectionGeneration, socket != nil, phase == .online else { return }
        resuming = false
        flushQueuedEvents()
        onConnectionChange(.online, "电脑已连接")
    }

    private func handleSocketMessage(generation: Int, result: Result<RemoteSocketMessage, Error>) {
        guard generation == connectionGeneration, socket != nil else { return }
        do {
            let message = try decode(result)
            switch message {
            case let .response(response):
                resolve(response)
            case let .event(event):
                if resuming {
                    queuedEvents.append(event)
                } else {
                    acceptEvent(event)
                }
            case .request, .unknown:
                break
            }
        } catch {
            handleSocketFailure(generation: generation, error: error)
        }
    }

    private func handleSocketClose(generation: Int, error: Error?) {
        guard generation == connectionGeneration else { return }
        socket = nil
        resuming = false
        queuedEvents.removeAll()
        cancelScheduledAck()
        failAllPending(with: RemoteWebSocketClientError.connectionClosed)
        phase = .offline
        let message = error?.localizedDescription ?? "连接已关闭"
        onConnectionChange(.offline, message)
    }

    private func handleSocketFailure(generation: Int, error: Error) {
        guard generation == connectionGeneration else { return }
        let previousSocket = socket
        socket = nil
        connectionGeneration += 1
        resuming = false
        queuedEvents.removeAll()
        cancelScheduledAck()
        failAllPending(with: RemoteWebSocketClientError.transport(error.localizedDescription))
        phase = .error
        onConnectionChange(.error, error.localizedDescription)
        previousSocket?.close()
    }

    private func decode(_ result: Result<RemoteSocketMessage, Error>) throws -> WireMessage {
        let message: RemoteSocketMessage
        switch result {
        case let .success(value): message = value
        case let .failure(error): throw error
        }

        let data: Data
        switch message {
        case let .text(text): data = Data(text.utf8)
        case let .data(value): data = value
        }
        do {
            return try JSONDecoder().decode(WireMessage.self, from: data)
        } catch {
            throw RemoteWebSocketClientError.invalidMessage(error.localizedDescription)
        }
    }

    private func resolve(_ response: ServerResponseEnvelope) {
        guard let request = pending.removeValue(forKey: response.id) else { return }
        request.timeoutTask.cancel()
        if response.ok {
            request.continuation.resume(returning: response.result)
        } else if let error = response.error {
            request.continuation.resume(throwing: RemoteWebSocketClientError.remote(
                code: error.code,
                message: error.message,
                details: error.details
            ))
        } else {
            request.continuation.resume(throwing: RemoteWebSocketClientError.remote(
                code: "unknown",
                message: "远程请求失败",
                details: nil
            ))
        }
    }

    private func handleSendFailure(id: String, error: Error) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.timeoutTask.cancel()
        request.continuation.resume(throwing: RemoteWebSocketClientError.transport(error.localizedDescription))
    }

    private func timeoutRequest(id: String) {
        guard let request = pending.removeValue(forKey: id) else { return }
        request.continuation.resume(throwing: RemoteWebSocketClientError.requestTimedOut(method: request.method.rawValue))
    }

    private func failAllPending(with error: Error) {
        let requests = pending.values
        pending.removeAll()
        for request in requests {
            request.timeoutTask.cancel()
            request.continuation.resume(throwing: error)
        }
    }

    private func cancelScheduledAck() {
        ackTask?.cancel()
        ackTask = nil
    }

    private func resetSequence() {
        lastSequence = 0
        seenEventIDs.removeAll()
        queuedEvents.removeAll()
        onSequenceReset()
    }

    private func flushQueuedEvents() {
        let events = queuedEvents.sorted {
            if $0.sequence == $1.sequence { return $0.eventID < $1.eventID }
            return $0.sequence < $1.sequence
        }
        queuedEvents.removeAll()
        for event in events {
            acceptEvent(event)
        }
    }

    private func acceptEvent(_ event: EventEnvelope) {
        guard event.kind == .event else { return }
        guard seenEventIDs[event.eventID] == nil, event.sequence > lastSequence else { return }
        lastSequence = event.sequence
        seenEventIDs[event.eventID] = event.sequence
        trimSeenEvents()
        onEvent(event)
        scheduleAck()
    }

    private func trimSeenEvents() {
        guard seenEventIDs.count > 5_000 else { return }
        let removeCount = seenEventIDs.count - 5_000
        let oldIDs = seenEventIDs
            .sorted { $0.value < $1.value }
            .prefix(removeCount)
            .map(\.key)
        for eventID in oldIDs {
            seenEventIDs.removeValue(forKey: eventID)
        }
    }

    private func scheduleAck() {
        guard ackTask == nil else { return }
        ackTask = scheduler.schedule(after: ackDebounce) { [weak self] in
            Task { await self?.sendAck() }
        }
    }

    private func sendAck() async {
        ackTask = nil
        guard phase == .online else { return }
        let params = JSONValue.object([
            "clientId": .string(clientID),
            "sequence": .number(Double(lastSequence))
        ])
        do {
            _ = try await sendRequest(.eventsAck, params: params)
        } catch {
            // ACK 失败不应影响已经投递给上层的事件。
        }
    }
}

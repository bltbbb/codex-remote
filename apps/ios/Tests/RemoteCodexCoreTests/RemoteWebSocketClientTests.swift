import Foundation
import XCTest
@testable import RemoteCodexCore

final class RemoteWebSocketClientTests: XCTestCase {
    func testEndpointKeepsTokenOutOfWSSQuery() {
        let secure = RemoteWebSocketEndpoint(
            url: URL(string: "wss://bridge.example/ws?client=ios")!,
            deviceToken: "device-token"
        )
        XCTAssertEqual(secure.requestURL.absoluteString, "wss://bridge.example/ws?client=ios")
        XCTAssertEqual(secure.subprotocols, ["codex-remote", "token.device-token"])

        let local = RemoteWebSocketEndpoint(
            url: URL(string: "ws://127.0.0.1:8080/ws?client=ios")!,
            deviceToken: "device-token"
        )
        XCTAssertEqual(local.requestURL.absoluteString, "ws://127.0.0.1:8080/ws?client=ios&token=device-token")
        XCTAssertEqual(local.subprotocols, ["codex-remote"])
    }

    func testRequestSuccessAndRemoteFailure() async throws {
        let context = makeClient()
        await connectAndResume(context)

        let successTask = Task {
            try await context.client.sendRequest(.threadList, params: .object(["limit": .number(10)]))
        }
        await waitUntil { context.socket.requests.contains { $0.method == .threadList } }
        let successRequest = try XCTUnwrap(context.socket.requests.first { $0.method == .threadList })
        context.socket.emit(.response(ServerResponseEnvelope(
            id: successRequest.id,
            ok: true,
            result: .object(["value": .string("ok")])
        )))
        let success = try await successTask.value
        XCTAssertEqual(success?.objectValue?["value"]?.stringValue, "ok")

        let failureTask = Task {
            try await context.client.sendRequest(.threadRead)
        }
        await waitUntil { context.socket.requests.contains { $0.method == .threadRead } }
        let failureRequest = try XCTUnwrap(context.socket.requests.first { $0.method == .threadRead })
        context.socket.emit(.response(ServerResponseEnvelope(
            id: failureRequest.id,
            ok: false,
            error: ResponseError(code: "not_found", message: "线程不存在", details: .object(["threadId": .string("missing")]))
        )))

        do {
            _ = try await failureTask.value
            XCTFail("失败响应应抛出错误")
        } catch let error as RemoteWebSocketClientError {
            XCTAssertEqual(error, .remote(
                code: "not_found",
                message: "线程不存在",
                details: .object(["threadId": .string("missing")])
            ))
        }

        await context.client.close()
    }

    func testRequestTimeoutRemovesPendingRequest() async throws {
        let context = makeClient()
        await connectAndResume(context)

        let requestTask = Task {
            try await context.client.sendRequest(.threadRead, timeout: 5)
        }
        await waitUntil { context.socket.requests.contains { $0.method == .threadRead } }
        context.scheduler.fireFirst(delay: 5)
        await drain()

        do {
            _ = try await requestTask.value
            XCTFail("请求超时应抛出错误")
        } catch let error as RemoteWebSocketClientError {
            XCTAssertEqual(error, .requestTimedOut(method: "thread.read"))
        }

        await context.client.close()
    }

    func testCloseFailsAllPendingRequests() async throws {
        let context = makeClient()
        await connectAndResume(context)

        let firstTask = Task { try await context.client.sendRequest(.threadList) }
        let secondTask = Task { try await context.client.sendRequest(.workspaceList) }
        await waitUntil {
            context.socket.requests.filter { $0.method == .threadList || $0.method == .workspaceList }.count == 2
        }

        await context.client.close()
        await assertFails(firstTask)
        await assertFails(secondTask)
        XCTAssertEqual(context.socket.closeCount, 1)
    }

    func testResumeSortsAndDeduplicatesRealtimeAndReplayEventsThenDebouncesAck() async throws {
        let collector = EventCollector()
        let context = makeClient(initialSequence: 1, collector: collector)
        await context.client.connect()
        await waitUntil { context.socket.requests.contains { $0.method == .eventsResume } }
        let resumeRequest = try XCTUnwrap(context.socket.requests.first { $0.method == .eventsResume })

        context.socket.emit(.event(makeEvent(sequence: 4, eventID: "event-4", message: "实时 4")))
        context.socket.emit(.event(makeEvent(sequence: 3, eventID: "event-3", message: "实时 3")))
        context.socket.emit(.event(makeEvent(sequence: 4, eventID: "event-4", message: "重复 4")))

        let replayEvents = [
            makeEvent(sequence: 2, eventID: "event-2", message: "重放 2"),
            makeEvent(sequence: 4, eventID: "event-4", message: "重放 4")
        ]
        context.socket.emit(.response(ServerResponseEnvelope(
            id: resumeRequest.id,
            ok: true,
            result: .object([
                "events": .array(try replayEvents.map { try jsonValue($0) }),
                "latestSequence": .number(4),
                "resetRequired": .bool(false)
            ])
        )))
        await waitUntil { collector.events.map(\.eventID) == ["event-2", "event-3", "event-4"] }
        await waitUntil { context.connection.phases.contains(.online) }

        XCTAssertEqual(collector.events.map(\.eventID), ["event-2", "event-3", "event-4"])
        XCTAssertEqual(collector.events.map(\.sequence), [2, 3, 4])
        XCTAssertEqual(context.scheduler.activeDelays.filter { abs($0 - 0.1) < 0.0001 }.count, 1)

        context.socket.emit(.event(makeEvent(sequence: 3, eventID: "event-3", message: "倒序 3")))
        await drain()
        XCTAssertEqual(collector.events.map(\.eventID), ["event-2", "event-3", "event-4"])

        context.scheduler.fireFirst(delay: 0.1)
        await waitUntil { context.socket.requests.contains { $0.method == .eventsAck } }
        let ackRequest = try XCTUnwrap(context.socket.requests.first { $0.method == .eventsAck })
        XCTAssertEqual(ackRequest.params.objectValue?["clientId"]?.stringValue, "client-test")
        XCTAssertEqual(ackRequest.params.objectValue?["sequence"]?.intValue, 4)
        XCTAssertEqual(context.socket.requests.filter { $0.method == .eventsAck }.count, 1)

        await context.client.close()
    }

    func testSocketCloseCancelsScheduledAckAndSchedulesReconnect() async throws {
        let collector = EventCollector()
        let context = makeClient(collector: collector)
        await connectAndResume(context)

        context.socket.emit(.event(makeEvent(sequence: 1, eventID: "event-1", message: "事件 1")))
        await waitUntil { context.scheduler.activeDelays.contains(where: { abs($0 - 0.1) < 0.0001 }) }

        context.socket.close()
        await waitUntil { context.connection.phases.last == .offline }

        XCTAssertFalse(context.scheduler.activeDelays.contains(where: { abs($0 - 0.1) < 0.0001 }))
        XCTAssertTrue(context.scheduler.activeDelays.contains(where: { abs($0 - 1) < 0.0001 }))

        context.scheduler.fireFirst(delay: 1)
        await waitUntil {
            context.socket.requests.filter { $0.method == .eventsResume }.count == 2
        }

        await context.client.close()
    }

    func testExplicitReconnectReplacesOnlineSocketAndResumesEvents() async throws {
        let context = makeClient()
        await connectAndResume(context)
        context.socket.emit(.event(makeEvent(sequence: 7, eventID: "event-7", message: "事件 7")))
        await waitUntil { await context.client.lastSequence == 7 }

        await context.client.reconnect()
        await waitUntil { context.socket.connectCount == 2 }
        await waitUntil {
            context.socket.requests.filter { $0.method == .eventsResume }.count == 2
        }
        let resumeRequest = try XCTUnwrap(
            context.socket.requests.filter { $0.method == .eventsResume }.last
        )
        XCTAssertEqual(resumeRequest.params.objectValue?["afterSequence"]?.intValue, 7)

        context.socket.emit(.response(ServerResponseEnvelope(
            id: resumeRequest.id,
            ok: true,
            result: .object([
                "events": .array([]),
                "latestSequence": .number(7),
                "resetRequired": .bool(false)
            ])
        )))
        await waitUntil { context.connection.phases.last == .online }

        await context.client.close()
    }

    private func makeClient(initialSequence: Int64 = 0, collector: EventCollector? = nil) -> TestContext {
        let socket = FakeRemoteWebSocket()
        let scheduler = ManualRemoteTransportScheduler()
        let eventCollector = collector ?? EventCollector()
        let connection = ConnectionCollector()
        let client = RemoteWebSocketClient(
            endpoint: RemoteWebSocketEndpoint(url: URL(string: "ws://bridge.example/ws")!, deviceToken: "test-token"),
            scheduler: scheduler,
            socketFactory: { _ in socket },
            requestTimeout: 15,
            ackDebounce: 0.1,
            clientID: "client-test",
            initialSequence: initialSequence,
            onEvent: { eventCollector.events.append($0) },
            onConnectionChange: { phase, _ in connection.phases.append(phase) }
        )
        return TestContext(client: client, socket: socket, scheduler: scheduler, connection: connection)
    }

    private func connectAndResume(_ context: TestContext) async {
        await context.client.connect()
        await waitUntil { context.socket.requests.contains { $0.method == .eventsResume } }
        guard let request = context.socket.requests.first(where: { $0.method == .eventsResume }) else {
            XCTFail("建连后应发送 events.resume")
            return
        }
        context.socket.emit(.response(ServerResponseEnvelope(
            id: request.id,
            ok: true,
            result: .object([
                "events": .array([]),
                "latestSequence": .number(0),
                "resetRequired": .bool(false)
            ])
        )))
        await waitUntil { context.connection.phases.contains(.online) }
    }

    private func assertFails(_ task: Task<JSONValue?, Error>) async {
        do {
            _ = try await task.value
            XCTFail("连接关闭后 pending 请求应失败")
        } catch {
            XCTAssertTrue(error is RemoteWebSocketClientError)
        }
    }

    private func waitUntil(
        _ condition: @escaping () async -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<500 {
            if await condition() { return }
            try? await Task.sleep(nanoseconds: 10_000_000)
        }
        if await condition() { return }
        XCTFail("等待条件超时", file: file, line: line)
    }

    private func drain() async {
        for _ in 0..<12 {
            try? await Task.sleep(nanoseconds: 1_000_000)
        }
    }

    private func makeEvent(sequence: Int64, eventID: String, message: String) -> EventEnvelope {
        EventEnvelope(
            sequence: sequence,
            eventID: eventID,
            event: .error(RemoteErrorEvent(message: message))
        )
    }

    private func jsonValue<T: Encodable>(_ value: T) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
}

private struct TestContext {
    let client: RemoteWebSocketClient
    let socket: FakeRemoteWebSocket
    let scheduler: ManualRemoteTransportScheduler
    let connection: ConnectionCollector
}

private final class EventCollector {
    var events: [EventEnvelope] = []
}

private final class ConnectionCollector {
    var phases: [ConnectionPhase] = []
}

private final class FakeRemoteWebSocket: RemoteWebSocket {
    var onOpen: (() -> Void)?
    var onMessage: ((Result<RemoteSocketMessage, Error>) -> Void)?
    var onClose: ((Error?) -> Void)?
    var sentMessages: [RemoteSocketMessage] = []
    var closeCount = 0
    var connectCount = 0

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
        connectCount += 1
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

private final class ManualScheduledTask: RemoteTransportScheduledTask {
    private(set) var isCancelled = false

    func cancel() {
        isCancelled = true
    }
}

private final class ManualRemoteTransportScheduler: RemoteTransportScheduler {
    private struct Entry {
        let delay: TimeInterval
        let task: ManualScheduledTask
        let operation: () -> Void
    }

    private var entries: [Entry] = []

    var activeDelays: [TimeInterval] {
        entries.filter { !$0.task.isCancelled }.map(\.delay)
    }

    @discardableResult
    func schedule(after delay: TimeInterval, operation: @escaping () -> Void) -> any RemoteTransportScheduledTask {
        let task = ManualScheduledTask()
        entries.append(Entry(delay: delay, task: task, operation: operation))
        return task
    }

    func fireFirst(delay: TimeInterval) {
        guard let index = entries.firstIndex(where: { !$0.task.isCancelled && abs($0.delay - delay) < 0.0001 }) else {
            XCTFail("没有找到等待 \(delay) 秒的调度任务")
            return
        }
        let entry = entries.remove(at: index)
        entry.operation()
    }
}

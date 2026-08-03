import Foundation
import XCTest
@testable import RemoteCodexCore

@MainActor
final class RemoteMockE2ETests: XCTestCase {
    func testProtocolMockThreadListOpenAndStreamingTurn() async throws {
        guard ProcessInfo.processInfo.environment["REMOTE_CODEX_E2E"] == "1" else {
            throw XCTSkip("未启用协议模拟器端到端测试")
        }

        let urlString = ProcessInfo.processInfo.environment["REMOTE_CODEX_E2E_URL"]
            ?? "ws://127.0.0.1:18787/ws"
        let endpoint = RemoteWebSocketEndpoint(
            url: try XCTUnwrap(URL(string: urlString)),
            deviceToken: nil
        )
        let store = RemoteAppStore(
            endpoint: endpoint,
            requestTimeout: 10,
            ackDebounce: 0.05,
            clientID: "ios-e2e-client"
        )
        defer {
            Task {
                await store.close()
            }
        }

        await store.connect()
        await waitUntil { store.connectionPhase == .online }
        XCTAssertEqual(store.connectionPhase, .online)

        let loadedList = await store.loadThreads()
        let listResult = try XCTUnwrap(loadedList)
        XCTAssertEqual(
            Set(listResult.threads.map(\.id)),
            Set(["thread-active", "thread-history-2", "thread-history-3"])
        )

        let loadedThreadValue = await store.loadThread("thread-active")
        let loadedThread = try XCTUnwrap(loadedThreadValue)
        XCTAssertEqual(loadedThread.id, "thread-active")
        XCTAssertEqual(store.currentThread?.id, "thread-active")

        let startedTurnValue = await store.sendTurn(text: "请完成测试")
        let startedTurn = try XCTUnwrap(startedTurnValue)
        await waitUntil {
            store.currentThread?.turns[startedTurn.id]?.status == .completed
        }

        let currentThread = try XCTUnwrap(store.currentThread)
        let completedTurn = try XCTUnwrap(currentThread.turns[startedTurn.id])
        XCTAssertEqual(completedTurn.status, .completed)
        XCTAssertTrue(
            currentThread.items.values.contains {
                $0.turnID == startedTurn.id && $0.type == .reasoning
            }
        )
        let finalMessage = currentThread.items.values.first {
            $0.turnID == startedTurn.id &&
                $0.type == .agentMessage &&
                $0.phase == "final_answer" &&
                $0.status == .completed
        }
        XCTAssertEqual(finalMessage?.text, "任务已完成，当前会话状态和事件流均已同步。")
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
        XCTFail("等待端到端状态超时", file: file, line: line)
    }
}

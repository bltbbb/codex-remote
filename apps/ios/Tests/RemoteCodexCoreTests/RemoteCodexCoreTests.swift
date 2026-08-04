import Foundation
import XCTest
@testable import RemoteCodexCore

final class RemoteCodexCoreTests: XCTestCase {
    private let fixtureNames: [(String, FixtureKind)] = [
        ("thread-list.snapshot.json", .threadListSnapshot),
        ("turn.plan.updated.json", .turnPlanUpdated),
        ("tool.progress.json", .toolProgress),
        ("turn.diff.updated.json", .turnDiffUpdated),
        ("turn.attachment.json", .turnAttachment),
        ("approval.requested.json", .approvalRequested),
        ("turn.failed.json", .turnFailed)
    ]

    func testDecodesAllProtocolFixtures() throws {
        for (fileName, expectedKind) in fixtureNames {
            let message = try loadMessage(fileName)
            XCTAssertEqual(message.fixtureKind, expectedKind, fileName)
        }

        let attachmentMessage = try loadMessage("turn.attachment.json")
        guard case let .request(request) = attachmentMessage else {
            return XCTFail("turn.attachment fixture 应为 request")
        }
        XCTAssertEqual(request.turnStartParameters?.attachments.count ?? 0, 2)

        let noAttachmentData = Data(
            """
            {
              "kind": "request",
              "id": "turn-start-without-attachments",
              "method": "turn.start",
              "params": {
                "threadId": "thread-fixture",
                "text": "继续",
                "clientRequestId": "client-request-without-attachments"
              }
            }
            """.utf8
        )
        guard case let .request(noAttachmentRequest) = try JSONDecoder().decode(WireMessage.self, from: noAttachmentData) else {
            return XCTFail("turn.start 应解码为 request")
        }
        XCTAssertEqual(noAttachmentRequest.turnStartParameters?.attachments, [])
    }

    func testUnknownEventAndUnknownFieldsRemainDecodable() throws {
        let data = Data(
            """
            {
              "kind": "event",
              "sequence": 99,
              "eventId": "future-event",
              "futureEnvelopeField": {"enabled": true},
              "event": {
                "method": "future.event.v2",
                "futureEventField": "ignored-by-known-container",
                "params": {"known": "value", "newField": {"flag": true}}
              }
            }
            """.utf8
        )

        let message = try JSONDecoder().decode(WireMessage.self, from: data)
        guard case let .event(envelope) = message, case let .unknown(event) = envelope.event else {
            return XCTFail("未知事件应落到 unknown 分支")
        }
        XCTAssertEqual(event.method, "future.event.v2")
        XCTAssertEqual(envelope.rawFields["futureEnvelopeField"]?.objectValue?["enabled"]?.boolValue, true)
        XCTAssertEqual(event.params.objectValue?["newField"]?.objectValue?["flag"]?.boolValue, true)

        let knownEvent = Data(
            """
            {
              "kind": "event",
              "sequence": 100,
              "eventId": "known-with-extra",
              "futureEnvelopeField": "accepted",
              "event": {
                "method": "thread.list.snapshot",
                "futureEventField": 7,
                "params": {"threads": [], "nextCursor": null, "futureParamField": true}
              }
            }
            """.utf8
        )
        let decodedKnownEvent = try JSONDecoder().decode(WireMessage.self, from: knownEvent)
        XCTAssertEqual(decodedKnownEvent.fixtureKind, .threadListSnapshot)
        guard case let .event(knownEnvelope) = decodedKnownEvent,
              case let .threadListSnapshot(snapshot) = knownEnvelope.event else {
            return XCTFail("已知事件应保留类型化分支")
        }
        XCTAssertEqual(knownEnvelope.rawFields["futureEnvelopeField"]?.stringValue, "accepted")
        XCTAssertEqual(snapshot.rawFields["futureParamField"]?.boolValue, true)
        let roundTrippedKnownEvent = try JSONDecoder().decode(WireMessage.self, from: JSONEncoder().encode(decodedKnownEvent))
        guard case let .event(roundTripEnvelope) = roundTrippedKnownEvent,
              case let .threadListSnapshot(roundTripSnapshot) = roundTripEnvelope.event else {
            return XCTFail("已知事件 round-trip 后应保留类型化分支")
        }
        XCTAssertEqual(roundTripEnvelope.rawFields["futureEnvelopeField"]?.stringValue, "accepted")
        XCTAssertEqual(roundTripSnapshot.rawFields["futureParamField"]?.boolValue, true)

        let unknownItem = try JSONDecoder().decode(
            RemoteItem.self,
            from: Data("{\"type\":\"futureItem\",\"id\":\"future-1\",\"turnId\":\"turn-1\",\"status\":\"running\",\"futureField\":{\"enabled\":true}}".utf8)
        )
        XCTAssertEqual(unknownItem.type, .unknown("futureItem"))
        XCTAssertEqual(unknownItem.rawFields["futureField"]?.objectValue?["enabled"]?.boolValue, true)
    }

    func testReducerDeduplicatesAndAppliesBasicState() throws {
        let threadList = try loadMessage("thread-list.snapshot.json")
        let approval = try loadMessage("approval.requested.json")
        let diff = try loadMessage("turn.diff.updated.json")
        let plan = try loadMessage("turn.plan.updated.json")
        let failure = try loadMessage("turn.failed.json")

        var state = RemoteReducer.createInitialState()
        state = RemoteReducer.apply(threadList, to: state)
        state = RemoteReducer.apply(approval, to: state)
        state = RemoteReducer.apply(diff, to: state)
        state = RemoteReducer.apply(failure, to: state)
        state = RemoteReducer.apply(plan, to: state)

        XCTAssertEqual(state.threadOrder, ["thread-fixture"])
        XCTAssertEqual(state.approvals["approval-fixture"]?.availableDecisions, ["accept", "decline"])
        XCTAssertEqual(state.threads["thread-fixture"]?.turns["turn-fixture"]?.status, Optional(TurnStatus.failed))
        XCTAssertTrue(state.threads["thread-fixture"]?.turns["turn-fixture"]?.diff?.contains("export default") == true)
        XCTAssertEqual(state.threads["thread-fixture"]?.items["plan-turn-fixture"]?.type, Optional(RemoteItemType.plan))

        let repeated = RemoteReducer.apply(threadList, to: state)
        XCTAssertEqual(repeated, state)

        var dedupeState = RemoteReducer.createInitialState()
        dedupeState = RemoteReducer.apply(threadList, to: dedupeState)
        XCTAssertEqual(RemoteReducer.apply(threadList, to: dedupeState), dedupeState)
    }

    func testAttachmentRequestDoesNotEnterPersistentState() throws {
        let attachment = try loadMessage("turn.attachment.json")
        let state = RemoteReducer.createInitialState()

        XCTAssertEqual(RemoteReducer.apply(attachment, to: state), state)
    }

    func testToolProgressAndTurnExpansion() throws {
        var state = RemoteReducer.createInitialState()
        let tool = RemoteItem(
            type: .toolCall,
            id: "tool-fixture",
            turnID: "turn-fixture",
            status: .inProgress,
            tool: "example.tool"
        )
        let upsert = EventEnvelope(
            sequence: 1,
            eventID: "tool-upsert",
            event: .itemUpsert(ItemUpsertEvent(threadID: "thread-fixture", turnID: "turn-fixture", item: tool))
        )
        state = RemoteReducer.apply(upsert, to: state)

        let progress = try loadMessage("tool.progress.json")
        guard case let .event(progressEnvelope) = progress, case let .itemDelta(progressEvent) = progressEnvelope.event else {
            return XCTFail("tool.progress fixture 应为 item.delta")
        }
        let normalizedProgress = EventEnvelope(
            sequence: 2,
            eventID: "tool-progress",
            event: .itemDelta(progressEvent)
        )
        state = RemoteReducer.apply(normalizedProgress, to: state)
        XCTAssertEqual(state.threads["thread-fixture"]?.items["tool-fixture"]?.output ?? "", "仍在处理")

        let turn = RemoteTurn(id: "turn-expand", status: .inProgress)
        state = RemoteReducer.apply(
            EventEnvelope(sequence: 3, eventID: "turn-start", event: .turnStarted(TurnStartedEvent(threadID: "thread-fixture", turn: turn))),
            to: state
        )
        XCTAssertTrue(state.processExpanded["turn-expand"] == true)
        state = RemoteReducer.setTurnExpanded(state, turnID: "turn-expand", expanded: true)
        let completed = RemoteTurn(id: "turn-expand", status: .completed, completedAt: 4)
        state = RemoteReducer.apply(
            EventEnvelope(sequence: 4, eventID: "turn-complete", event: .turnCompleted(TurnCompletedEvent(threadID: "thread-fixture", turn: completed))),
            to: state
        )
        XCTAssertTrue(state.processExpanded["turn-expand"] == true)
    }

    func testThreadSnapshotKeepsRealtimeTurnThatArrivedDuringLoading() {
        var state = RemoteReducer.createInitialState()
        let liveItem = RemoteItem(
            type: .userMessage,
            id: "item-live",
            turnID: "turn-live",
            status: .completed,
            text: "刚刚发送的消息"
        )
        state = RemoteReducer.apply(
            EventEnvelope(
                sequence: 1,
                eventID: "item-live",
                event: .itemUpsert(ItemUpsertEvent(threadID: "thread-race", turnID: "turn-live", item: liveItem))
            ),
            to: state
        )

        let historicalTurn = RemoteTurn(id: "turn-old", status: .completed, itemIDs: ["item-old"])
        let historicalItem = RemoteItem(
            type: .userMessage,
            id: "item-old",
            turnID: "turn-old",
            status: .completed,
            text: "历史消息"
        )
        let snapshot = RemoteThread(
            id: "thread-race",
            sessionID: "session-race",
            title: "竞态会话",
            preview: "",
            cwd: "E:\\workspace",
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 2,
            status: "active",
            isPinned: false,
            turnIDs: [historicalTurn.id],
            turns: [historicalTurn.id: historicalTurn],
            items: [historicalItem.id: historicalItem]
        )

        state = RemoteReducer.mergeThread(snapshot, into: state)

        XCTAssertEqual(state.threads["thread-race"]?.turnIDs, ["turn-old", "turn-live"])
        XCTAssertEqual(state.threads["thread-race"]?.items["item-live"]?.text, "刚刚发送的消息")
    }

    func testThreadSnapshotDoesNotShortenStreamingItem() {
        let turn = RemoteTurn(id: "turn-stream", status: .inProgress, itemIDs: ["item-stream"])
        let liveItem = RemoteItem(
            type: .agentMessage,
            id: "item-stream",
            turnID: turn.id,
            status: .inProgress,
            text: "已经收到的较长流式内容"
        )
        var liveThread = RemoteThread(
            id: "thread-stream",
            sessionID: "session-stream",
            title: "流式会话",
            preview: "",
            cwd: "E:\\workspace",
            modelProvider: "openai",
            createdAt: 1,
            updatedAt: 2,
            status: "active",
            isPinned: false,
            turnIDs: [turn.id],
            turns: [turn.id: turn],
            items: [liveItem.id: liveItem]
        )
        var state = RemoteReducer.mergeThread(liveThread, into: RemoteReducer.createInitialState())

        var shorterItem = liveItem
        shorterItem.text = "较短内容"
        liveThread.items[liveItem.id] = shorterItem
        state = RemoteReducer.mergeThread(liveThread, into: state)

        XCTAssertEqual(state.threads[liveThread.id]?.items[liveItem.id]?.text, "已经收到的较长流式内容")
    }

    private func loadMessage(_ fileName: String) throws -> WireMessage {
        let fileURL = fixtureDirectory().appendingPathComponent(fileName)
        let data = try Data(contentsOf: fileURL)
        return try JSONDecoder().decode(WireMessage.self, from: data)
    }

    private func fixtureDirectory() -> URL {
        // SwiftPM 和迁移到 Xcode 后都沿用仓库布局；CI 若将 fixture 复制到资源目录，只需替换这里的根路径。
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("packages/protocol-mock/fixtures")
    }
}

import Foundation

/// 用于保存未知事件参数和未知字段的轻量 JSON 值。
public enum JSONValue: Codable, Equatable {
    case null
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
            return
        }
        if let value = try? container.decode(Bool.self) {
            self = .bool(value)
            return
        }
        if let value = try? container.decode(Int64.self) {
            self = .number(Double(value))
            return
        }
        if let value = try? container.decode(Double.self) {
            self = .number(value)
            return
        }
        if let value = try? container.decode(String.self) {
            self = .string(value)
            return
        }
        if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
            return
        }
        if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
            return
        }
        throw DecodingError.dataCorruptedError(in: container, debugDescription: "不是受支持的 JSON 值")
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .null:
            var container = encoder.singleValueContainer()
            try container.encodeNil()
        case let .string(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .number(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .bool(value):
            var container = encoder.singleValueContainer()
            try container.encode(value)
        case let .array(value):
            var container = encoder.unkeyedContainer()
            for item in value {
                try container.encode(item)
            }
        case let .object(value):
            var container = encoder.container(keyedBy: DynamicCodingKey.self)
            for (key, item) in value {
                try container.encode(item, forKey: DynamicCodingKey(key))
            }
        }
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(self)
        return try JSONDecoder().decode(type, from: data)
    }

    public var objectValue: [String: JSONValue]? {
        if case let .object(value) = self { return value }
        return nil
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var intValue: Int64? {
        guard case let .number(value) = self, value.isFinite, value.rounded() == value else { return nil }
        return Int64(value)
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }
}

private struct DynamicCodingKey: CodingKey, Hashable {
    let stringValue: String
    let intValue: Int?

    init(_ string: String) {
        stringValue = string
        intValue = nil
    }

    init?(stringValue: String) {
        self.init(stringValue)
    }

    init?(intValue: Int) {
        stringValue = String(intValue)
        self.intValue = intValue
    }
}

public enum MessageKind: String, Codable, Equatable {
    case request
    case response
    case event
}

public enum ConnectionPhase: Codable, Equatable {
    case connecting
    case online
    case offline
    case error
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "connecting": self = .connecting
        case "online": self = .online
        case "offline": self = .offline
        case "error": self = .error
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .connecting: return "connecting"
        case .online: return "online"
        case .offline: return "offline"
        case .error: return "error"
        case let .unknown(value): return value
        }
    }
}

public enum TurnStatus: Codable, Equatable {
    case notStarted
    case inProgress
    case completed
    case failed
    case interrupted
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "notStarted": self = .notStarted
        case "inProgress": self = .inProgress
        case "completed": self = .completed
        case "failed": self = .failed
        case "interrupted": self = .interrupted
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .notStarted: return "notStarted"
        case .inProgress: return "inProgress"
        case .completed: return "completed"
        case .failed: return "failed"
        case .interrupted: return "interrupted"
        case let .unknown(value): return value
        }
    }
}

public enum ItemStatus: Codable, Equatable {
    case pending
    case inProgress
    case completed
    case failed
    case declined
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "pending": self = .pending
        case "inProgress": self = .inProgress
        case "completed": self = .completed
        case "failed": self = .failed
        case "declined": self = .declined
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .pending: return "pending"
        case .inProgress: return "inProgress"
        case .completed: return "completed"
        case .failed: return "failed"
        case .declined: return "declined"
        case let .unknown(value): return value
        }
    }
}

public enum RemoteAttachmentKind: Codable, Equatable {
    case image
    case audio
    case file
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "image": self = .image
        case "audio": self = .audio
        case "file": self = .file
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .image: return "image"
        case .audio: return "audio"
        case .file: return "file"
        case let .unknown(value): return value
        }
    }
}

public enum RemoteItemType: Codable, Equatable {
    case userMessage
    case agentMessage
    case reasoning
    case plan
    case commandExecution
    case fileChange
    case toolCall
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "userMessage": self = .userMessage
        case "agentMessage": self = .agentMessage
        case "reasoning": self = .reasoning
        case "plan": self = .plan
        case "commandExecution": self = .commandExecution
        case "fileChange": self = .fileChange
        case "toolCall": self = .toolCall
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .userMessage: return "userMessage"
        case .agentMessage: return "agentMessage"
        case .reasoning: return "reasoning"
        case .plan: return "plan"
        case .commandExecution: return "commandExecution"
        case .fileChange: return "fileChange"
        case .toolCall: return "toolCall"
        case let .unknown(value): return value
        }
    }
}

public enum ItemDeltaTarget: Codable, Equatable {
    case agentMessage
    case reasoningSummary
    case reasoningText
    case plan
    case commandOutput
    case filePatch
    case toolOutput
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "agentMessage": self = .agentMessage
        case "reasoningSummary": self = .reasoningSummary
        case "reasoningText": self = .reasoningText
        case "plan": self = .plan
        case "commandOutput": self = .commandOutput
        case "filePatch": self = .filePatch
        case "toolOutput": self = .toolOutput
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .agentMessage: return "agentMessage"
        case .reasoningSummary: return "reasoningSummary"
        case .reasoningText: return "reasoningText"
        case .plan: return "plan"
        case .commandOutput: return "commandOutput"
        case .filePatch: return "filePatch"
        case .toolOutput: return "toolOutput"
        case let .unknown(value): return value
        }
    }
}

public enum ClientMethod: Codable, Equatable {
    case connectionInfo
    case workspaceList
    case threadList
    case threadRead
    case threadCreate
    case threadDelete
    case threadResume
    case turnStart
    case turnInterrupt
    case approvalResolve
    case eventsResume
    case eventsAck
    case pairingComplete
    case deviceList
    case deviceRevoke
    case mockFaultConfigure
    case mockFaultRelease
    case unknown(String)

    public init(from decoder: Decoder) throws {
        self = Self(rawValue: try String(from: decoder))
    }

    public func encode(to encoder: Encoder) throws {
        try rawValue.encode(to: encoder)
    }

    public init(rawValue: String) {
        switch rawValue {
        case "connection.info": self = .connectionInfo
        case "workspace.list": self = .workspaceList
        case "thread.list": self = .threadList
        case "thread.read": self = .threadRead
        case "thread.create": self = .threadCreate
        case "thread.delete": self = .threadDelete
        case "thread.resume": self = .threadResume
        case "turn.start": self = .turnStart
        case "turn.interrupt": self = .turnInterrupt
        case "approval.resolve": self = .approvalResolve
        case "events.resume": self = .eventsResume
        case "events.ack": self = .eventsAck
        case "pairing.complete": self = .pairingComplete
        case "device.list": self = .deviceList
        case "device.revoke": self = .deviceRevoke
        case "mock.fault.configure": self = .mockFaultConfigure
        case "mock.fault.release": self = .mockFaultRelease
        default: self = .unknown(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .connectionInfo: return "connection.info"
        case .workspaceList: return "workspace.list"
        case .threadList: return "thread.list"
        case .threadRead: return "thread.read"
        case .threadCreate: return "thread.create"
        case .threadDelete: return "thread.delete"
        case .threadResume: return "thread.resume"
        case .turnStart: return "turn.start"
        case .turnInterrupt: return "turn.interrupt"
        case .approvalResolve: return "approval.resolve"
        case .eventsResume: return "events.resume"
        case .eventsAck: return "events.ack"
        case .pairingComplete: return "pairing.complete"
        case .deviceList: return "device.list"
        case .deviceRevoke: return "device.revoke"
        case .mockFaultConfigure: return "mock.fault.configure"
        case .mockFaultRelease: return "mock.fault.release"
        case let .unknown(value): return value
        }
    }
}

public enum FixtureKind: String, Codable, Equatable {
    case threadListSnapshot = "thread-list.snapshot"
    case turnPlanUpdated = "turn.plan.updated"
    case toolProgress = "tool.progress"
    case turnDiffUpdated = "turn.diff.updated"
    case turnAttachment = "turn.attachment"
    case approvalRequested = "approval.requested"
    case turnFailed = "turn.failed"
}

public struct RemoteThreadSummary: Codable, Equatable {
    public var id: String
    public var sessionID: String
    public var title: String
    public var preview: String
    public var cwd: String
    public var modelProvider: String
    public var createdAt: Int64
    public var updatedAt: Int64
    public var status: String
    public var isPinned: Bool
    public var source: JSONValue?

    public init(
        id: String,
        sessionID: String,
        title: String,
        preview: String,
        cwd: String,
        modelProvider: String,
        createdAt: Int64,
        updatedAt: Int64,
        status: String,
        isPinned: Bool,
        source: JSONValue? = nil
    ) {
        self.id = id
        self.sessionID = sessionID
        self.title = title
        self.preview = preview
        self.cwd = cwd
        self.modelProvider = modelProvider
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.status = status
        self.isPinned = isPinned
        self.source = source
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case sessionID = "sessionId"
        case title
        case preview
        case cwd
        case modelProvider
        case createdAt
        case updatedAt
        case status
        case isPinned
        case source
    }
}

public struct RemoteTurn: Codable, Equatable {
    public var id: String
    public var status: TurnStatus
    public var itemIDs: [String]
    public var startedAt: Int64?
    public var completedAt: Int64?
    public var durationMs: Int64?
    public var error: String?
    public var diff: String?

    public init(
        id: String,
        status: TurnStatus,
        itemIDs: [String] = [],
        startedAt: Int64? = nil,
        completedAt: Int64? = nil,
        durationMs: Int64? = nil,
        error: String? = nil,
        diff: String? = nil
    ) {
        self.id = id
        self.status = status
        self.itemIDs = itemIDs
        self.startedAt = startedAt
        self.completedAt = completedAt
        self.durationMs = durationMs
        self.error = error
        self.diff = diff
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case status
        case itemIDs = "itemIds"
        case startedAt
        case completedAt
        case durationMs
        case error
        case diff
    }
}

public struct RemoteThread: Codable, Equatable {
    public var id: String
    public var sessionID: String
    public var title: String
    public var preview: String
    public var cwd: String
    public var modelProvider: String
    public var createdAt: Int64
    public var updatedAt: Int64
    public var status: String
    public var isPinned: Bool
    public var source: JSONValue?
    public var turnIDs: [String]
    public var turns: [String: RemoteTurn]
    public var items: [String: RemoteItem]

    public init(
        id: String,
        sessionID: String,
        title: String,
        preview: String,
        cwd: String,
        modelProvider: String,
        createdAt: Int64,
        updatedAt: Int64,
        status: String,
        isPinned: Bool,
        source: JSONValue? = nil,
        turnIDs: [String] = [],
        turns: [String: RemoteTurn] = [:],
        items: [String: RemoteItem] = [:]
    ) {
        self.id = id
        self.sessionID = sessionID
        self.title = title
        self.preview = preview
        self.cwd = cwd
        self.modelProvider = modelProvider
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.status = status
        self.isPinned = isPinned
        self.source = source
        self.turnIDs = turnIDs
        self.turns = turns
        self.items = items
    }

    public init(summary: RemoteThreadSummary) {
        self.init(
            id: summary.id,
            sessionID: summary.sessionID,
            title: summary.title,
            preview: summary.preview,
            cwd: summary.cwd,
            modelProvider: summary.modelProvider,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
            status: summary.status,
            isPinned: summary.isPinned,
            source: summary.source
        )
    }

    public func summary() -> RemoteThreadSummary {
        RemoteThreadSummary(
            id: id,
            sessionID: sessionID,
            title: title,
            preview: preview,
            cwd: cwd,
            modelProvider: modelProvider,
            createdAt: createdAt,
            updatedAt: updatedAt,
            status: status,
            isPinned: isPinned,
            source: source
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case sessionID = "sessionId"
        case title
        case preview
        case cwd
        case modelProvider
        case createdAt
        case updatedAt
        case status
        case isPinned
        case source
        case turnIDs = "turnIds"
        case turns
        case items
    }
}

public struct RemoteAttachment: Codable, Equatable {
    public var id: String
    public var name: String
    public var mimeType: String
    public var size: Int64
    public var kind: RemoteAttachmentKind
    public var dataURL: String?
    public var text: String?

    public init(
        id: String,
        name: String,
        mimeType: String,
        size: Int64,
        kind: RemoteAttachmentKind,
        dataURL: String? = nil,
        text: String? = nil
    ) {
        self.id = id
        self.name = name
        self.mimeType = mimeType
        self.size = size
        self.kind = kind
        self.dataURL = dataURL
        self.text = text
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case name
        case mimeType
        case size
        case kind
        case dataURL = "dataUrl"
        case text
    }
}

/// Item 使用宽松的字段集合：已知字段提供便捷访问，rawFields 保存未知字段。
public struct RemoteItem: Codable, Equatable {
    public var type: RemoteItemType
    public var id: String
    public var turnID: String
    public var status: ItemStatus
    public var text: String?
    public var phase: String?
    public var summary: [String]
    public var content: [String]
    public var command: String?
    public var cwd: String?
    public var output: String
    public var exitCode: Int64?
    public var durationMs: Int64?
    public var changes: [JSONValue]
    public var patch: String
    public var namespace: String?
    public var tool: String?
    public var arguments: JSONValue?
    public var success: Bool?
    public var rawFields: [String: JSONValue]

    public init(
        type: RemoteItemType,
        id: String,
        turnID: String,
        status: ItemStatus,
        text: String? = nil,
        phase: String? = nil,
        summary: [String] = [],
        content: [String] = [],
        command: String? = nil,
        cwd: String? = nil,
        output: String = "",
        exitCode: Int64? = nil,
        durationMs: Int64? = nil,
        changes: [JSONValue] = [],
        patch: String = "",
        namespace: String? = nil,
        tool: String? = nil,
        arguments: JSONValue? = nil,
        success: Bool? = nil,
        rawFields: [String: JSONValue] = [:]
    ) {
        self.type = type
        self.id = id
        self.turnID = turnID
        self.status = status
        self.text = text
        self.phase = phase
        self.summary = summary
        self.content = content
        self.command = command
        self.cwd = cwd
        self.output = output
        self.exitCode = exitCode
        self.durationMs = durationMs
        self.changes = changes
        self.patch = patch
        self.namespace = namespace
        self.tool = tool
        self.arguments = arguments
        self.success = success
        var fields = rawFields
        fields["type"] = .string(type.rawValue)
        fields["id"] = .string(id)
        fields["turnId"] = .string(turnID)
        fields["status"] = .string(status.rawValue)
        self.rawFields = fields
    }

    public init(from decoder: Decoder) throws {
        let raw = try JSONValue(from: decoder)
        guard let object = raw.objectValue else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "item 必须是对象"))
        }
        guard let id = object["id"]?.stringValue, let turnID = object["turnId"]?.stringValue else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "item 缺少 id 或 turnId"))
        }
        type = RemoteItemType(rawValue: object["type"]?.stringValue ?? "unknown")
        self.id = id
        self.turnID = turnID
        status = ItemStatus(rawValue: object["status"]?.stringValue ?? "unknown")
        text = object["text"]?.stringValue
        phase = object["phase"]?.stringValue
        summary = object["summary"]?.stringArrayValue ?? []
        content = object["content"]?.stringArrayValue ?? []
        command = object["command"]?.stringValue
        cwd = object["cwd"]?.stringValue
        output = object["output"]?.stringValue ?? ""
        exitCode = object["exitCode"]?.intValue
        durationMs = object["durationMs"]?.intValue
        changes = object["changes"]?.arrayValue ?? []
        patch = object["patch"]?.stringValue ?? ""
        namespace = object["namespace"]?.stringValue
        tool = object["tool"]?.stringValue
        arguments = object["arguments"]
        success = object["success"]?.boolValue
        rawFields = object
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["type"] = .string(type.rawValue)
        object["id"] = .string(id)
        object["turnId"] = .string(turnID)
        object["status"] = .string(status.rawValue)
        setOptional(&object, key: "text", value: text.map(JSONValue.string))
        setOptional(&object, key: "phase", value: phase.map(JSONValue.string))
        object["summary"] = .array(summary.map(JSONValue.string))
        object["content"] = .array(content.map(JSONValue.string))
        setOptional(&object, key: "command", value: command.map(JSONValue.string))
        setOptional(&object, key: "cwd", value: cwd.map(JSONValue.string))
        object["output"] = .string(output)
        setOptional(&object, key: "exitCode", value: exitCode.map { .number(Double($0)) })
        setOptional(&object, key: "durationMs", value: durationMs.map { .number(Double($0)) })
        object["changes"] = .array(changes)
        object["patch"] = .string(patch)
        setOptional(&object, key: "namespace", value: namespace.map(JSONValue.string))
        setOptional(&object, key: "tool", value: tool.map(JSONValue.string))
        setOptional(&object, key: "arguments", value: arguments)
        setOptional(&object, key: "success", value: success.map(JSONValue.bool))
        try JSONValue.object(object).encode(to: encoder)
    }
}

private func setOptional(_ object: inout [String: JSONValue], key: String, value: JSONValue?) {
    if let value {
        object[key] = value
    }
}

private func encodeJSONValue<T: Encodable>(_ value: T) throws -> JSONValue {
    let data = try JSONEncoder().encode(value)
    return try JSONDecoder().decode(JSONValue.self, from: data)
}

private extension JSONValue {
    var arrayValue: [JSONValue]? {
        if case let .array(value) = self { return value }
        return nil
    }

    var stringArrayValue: [String]? {
        guard case let .array(value) = self else { return nil }
        return value.compactMap(\.stringValue)
    }
}

public struct ApprovalRequest: Codable, Equatable {
    public var id: String
    public var method: String
    public var threadID: String
    public var turnID: String
    public var itemID: String
    public var title: String
    public var description: String
    public var command: String?
    public var cwd: String?
    public var availableDecisions: [String]
    public var raw: JSONValue

    public init(
        id: String,
        method: String,
        threadID: String,
        turnID: String,
        itemID: String,
        title: String,
        description: String,
        command: String? = nil,
        cwd: String? = nil,
        availableDecisions: [String],
        raw: JSONValue = .null
    ) {
        self.id = id
        self.method = method
        self.threadID = threadID
        self.turnID = turnID
        self.itemID = itemID
        self.title = title
        self.description = description
        self.command = command
        self.cwd = cwd
        self.availableDecisions = availableDecisions
        self.raw = raw
    }

    private enum CodingKeys: String, CodingKey {
        case id
        case method
        case threadID = "threadId"
        case turnID = "turnId"
        case itemID = "itemId"
        case title
        case description
        case command
        case cwd
        case availableDecisions
        case raw
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        method = try container.decode(String.self, forKey: .method)
        threadID = try container.decode(String.self, forKey: .threadID)
        turnID = try container.decode(String.self, forKey: .turnID)
        itemID = try container.decode(String.self, forKey: .itemID)
        title = try container.decode(String.self, forKey: .title)
        description = try container.decode(String.self, forKey: .description)
        command = try container.decodeIfPresent(String.self, forKey: .command)
        cwd = try container.decodeIfPresent(String.self, forKey: .cwd)
        availableDecisions = try container.decode([String].self, forKey: .availableDecisions)
        raw = try container.decodeIfPresent(JSONValue.self, forKey: .raw) ?? .null
    }
}

public struct ConnectionStatusEvent: Codable, Equatable {
    public var phase: ConnectionPhase
    public var message: String?
    public var rawFields: [String: JSONValue]

    public init(phase: ConnectionPhase, message: String? = nil, rawFields: [String: JSONValue] = [:]) {
        self.phase = phase
        self.message = message
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case phase
        case message
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        phase = try container.decode(ConnectionPhase.self, forKey: .phase)
        message = try container.decodeIfPresent(String.self, forKey: .message)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["phase"] = try encodeJSONValue(phase)
        setOptional(&object, key: "message", value: message.map(JSONValue.string))
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ThreadListSnapshotEvent: Codable, Equatable {
    public var threads: [RemoteThreadSummary]
    public var nextCursor: String?
    public var append: Bool?
    public var rawFields: [String: JSONValue]

    public init(threads: [RemoteThreadSummary], nextCursor: String?, append: Bool? = nil, rawFields: [String: JSONValue] = [:]) {
        self.threads = threads
        self.nextCursor = nextCursor
        self.append = append
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threads
        case nextCursor
        case append
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threads = try container.decode([RemoteThreadSummary].self, forKey: .threads)
        nextCursor = try container.decodeIfPresent(String.self, forKey: .nextCursor)
        append = try container.decodeIfPresent(Bool.self, forKey: .append)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threads"] = try encodeJSONValue(threads)
        setOptional(&object, key: "nextCursor", value: nextCursor.map(JSONValue.string))
        setOptional(&object, key: "append", value: append.map(JSONValue.bool))
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ThreadSnapshotEvent: Codable, Equatable {
    public var thread: RemoteThread
    public var rawFields: [String: JSONValue]

    public init(thread: RemoteThread, rawFields: [String: JSONValue] = [:]) {
        self.thread = thread
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case thread
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try container.decode(RemoteThread.self, forKey: .thread)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["thread"] = try encodeJSONValue(thread)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ThreadUpsertEvent: Codable, Equatable {
    public var thread: RemoteThreadSummary
    public var rawFields: [String: JSONValue]

    public init(thread: RemoteThreadSummary, rawFields: [String: JSONValue] = [:]) {
        self.thread = thread
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case thread
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        thread = try container.decode(RemoteThreadSummary.self, forKey: .thread)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["thread"] = try encodeJSONValue(thread)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ThreadRemovedEvent: Codable, Equatable {
    public var threadID: String
    public var rawFields: [String: JSONValue]

    public init(threadID: String, rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct TurnStartedEvent: Codable, Equatable {
    public var threadID: String
    public var turn: RemoteTurn
    public var rawFields: [String: JSONValue]

    public init(threadID: String, turn: RemoteTurn, rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.turn = turn
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case turn
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
        turn = try container.decode(RemoteTurn.self, forKey: .turn)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        object["turn"] = try encodeJSONValue(turn)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct TurnCompletedEvent: Codable, Equatable {
    public var threadID: String
    public var turn: RemoteTurn
    public var rawFields: [String: JSONValue]

    public init(threadID: String, turn: RemoteTurn, rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.turn = turn
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case turn
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
        turn = try container.decode(RemoteTurn.self, forKey: .turn)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        object["turn"] = try encodeJSONValue(turn)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ItemUpsertEvent: Codable, Equatable {
    public var threadID: String
    public var turnID: String
    public var item: RemoteItem
    public var rawFields: [String: JSONValue]

    public init(threadID: String, turnID: String, item: RemoteItem, rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.turnID = turnID
        self.item = item
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case turnID = "turnId"
        case item
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
        turnID = try container.decode(String.self, forKey: .turnID)
        item = try container.decode(RemoteItem.self, forKey: .item)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        object["turnId"] = .string(turnID)
        object["item"] = try encodeJSONValue(item)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ItemDeltaEvent: Codable, Equatable {
    public var threadID: String
    public var turnID: String
    public var itemID: String
    public var target: ItemDeltaTarget
    public var delta: String
    public var rawFields: [String: JSONValue]

    public init(threadID: String, turnID: String, itemID: String, target: ItemDeltaTarget, delta: String, rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.turnID = turnID
        self.itemID = itemID
        self.target = target
        self.delta = delta
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case turnID = "turnId"
        case itemID = "itemId"
        case target
        case delta
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
        turnID = try container.decode(String.self, forKey: .turnID)
        itemID = try container.decode(String.self, forKey: .itemID)
        target = try container.decode(ItemDeltaTarget.self, forKey: .target)
        delta = try container.decode(String.self, forKey: .delta)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        object["turnId"] = .string(turnID)
        object["itemId"] = .string(itemID)
        object["target"] = try encodeJSONValue(target)
        object["delta"] = .string(delta)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct TurnDiffUpdatedEvent: Codable, Equatable {
    public var threadID: String
    public var turnID: String
    public var diff: String
    public var rawFields: [String: JSONValue]

    public init(threadID: String, turnID: String, diff: String, rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.turnID = turnID
        self.diff = diff
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case turnID = "turnId"
        case diff
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
        turnID = try container.decode(String.self, forKey: .turnID)
        diff = try container.decode(String.self, forKey: .diff)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        object["turnId"] = .string(turnID)
        object["diff"] = .string(diff)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ApprovalRequestedEvent: Codable, Equatable {
    public var approval: ApprovalRequest
    public var rawFields: [String: JSONValue]

    public init(approval: ApprovalRequest, rawFields: [String: JSONValue] = [:]) {
        self.approval = approval
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case approval
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approval = try container.decode(ApprovalRequest.self, forKey: .approval)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["approval"] = try encodeJSONValue(approval)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ApprovalResolvedEvent: Codable, Equatable {
    public var approvalID: String
    public var rawFields: [String: JSONValue]

    public init(approvalID: String, rawFields: [String: JSONValue] = [:]) {
        self.approvalID = approvalID
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case approvalID = "approvalId"
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        approvalID = try container.decode(String.self, forKey: .approvalID)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["approvalId"] = .string(approvalID)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct RemoteErrorEvent: Codable, Equatable {
    public var message: String
    public var threadID: String?
    public var turnID: String?
    public var rawFields: [String: JSONValue]

    public init(message: String, threadID: String? = nil, turnID: String? = nil, rawFields: [String: JSONValue] = [:]) {
        self.message = message
        self.threadID = threadID
        self.turnID = turnID
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case message
        case threadID = "threadId"
        case turnID = "turnId"
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        message = try container.decode(String.self, forKey: .message)
        threadID = try container.decodeIfPresent(String.self, forKey: .threadID)
        turnID = try container.decodeIfPresent(String.self, forKey: .turnID)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["message"] = .string(message)
        setOptional(&object, key: "threadId", value: threadID.map(JSONValue.string))
        setOptional(&object, key: "turnId", value: turnID.map(JSONValue.string))
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct RawRemoteEvent: Codable, Equatable {
    public var method: String
    public var data: JSONValue
    public var rawFields: [String: JSONValue]

    public init(method: String, data: JSONValue, rawFields: [String: JSONValue] = [:]) {
        self.method = method
        self.data = data
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case method
        case data
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        method = try container.decode(String.self, forKey: .method)
        data = try container.decode(JSONValue.self, forKey: .data)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["method"] = .string(method)
        object["data"] = data
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct UnknownRemoteEvent: Equatable {
    public let method: String
    public let params: JSONValue

    public init(method: String, params: JSONValue) {
        self.method = method
        self.params = params
    }
}

public struct RemoteSemanticEvent: Equatable {
    public let name: FixtureKind
    public let method: String
    public let params: JSONValue

    public init(name: FixtureKind, method: String, params: JSONValue) {
        self.name = name
        self.method = method
        self.params = params
    }
}

public enum RemoteEvent: Codable, Equatable {
    case connectionStatus(ConnectionStatusEvent)
    case threadListSnapshot(ThreadListSnapshotEvent)
    case threadSnapshot(ThreadSnapshotEvent)
    case threadUpsert(ThreadUpsertEvent)
    case threadRemoved(ThreadRemovedEvent)
    case turnStarted(TurnStartedEvent)
    case turnCompleted(TurnCompletedEvent)
    case itemUpsert(ItemUpsertEvent)
    case itemDelta(ItemDeltaEvent)
    case turnDiffUpdated(TurnDiffUpdatedEvent)
    case approvalRequested(ApprovalRequestedEvent)
    case approvalResolved(ApprovalResolvedEvent)
    case error(RemoteErrorEvent)
    case raw(RawRemoteEvent)
    case semantic(RemoteSemanticEvent)
    case unknown(UnknownRemoteEvent)

    private enum CodingKeys: String, CodingKey {
        case method
        case params
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let method = try container.decode(String.self, forKey: .method)
        let params = try container.decode(JSONValue.self, forKey: .params)
        switch method {
        case "connection.status": self = .connectionStatus(try params.decode(ConnectionStatusEvent.self))
        case "thread.list.snapshot": self = .threadListSnapshot(try params.decode(ThreadListSnapshotEvent.self))
        case "thread.snapshot": self = .threadSnapshot(try params.decode(ThreadSnapshotEvent.self))
        case "thread.upsert": self = .threadUpsert(try params.decode(ThreadUpsertEvent.self))
        case "thread.removed": self = .threadRemoved(try params.decode(ThreadRemovedEvent.self))
        case "turn.started": self = .turnStarted(try params.decode(TurnStartedEvent.self))
        case "turn.completed": self = .turnCompleted(try params.decode(TurnCompletedEvent.self))
        case "item.upsert": self = .itemUpsert(try params.decode(ItemUpsertEvent.self))
        case "item.delta": self = .itemDelta(try params.decode(ItemDeltaEvent.self))
        case "turn.diff.updated": self = .turnDiffUpdated(try params.decode(TurnDiffUpdatedEvent.self))
        case "approval.requested": self = .approvalRequested(try params.decode(ApprovalRequestedEvent.self))
        case "approval.resolved": self = .approvalResolved(try params.decode(ApprovalResolvedEvent.self))
        case "error": self = .error(try params.decode(RemoteErrorEvent.self))
        case "raw": self = .raw(try params.decode(RawRemoteEvent.self))
        case "turn.plan.updated": self = .semantic(RemoteSemanticEvent(name: .turnPlanUpdated, method: method, params: params))
        case "tool.progress": self = .semantic(RemoteSemanticEvent(name: .toolProgress, method: method, params: params))
        case "turn.attachment": self = .semantic(RemoteSemanticEvent(name: .turnAttachment, method: method, params: params))
        case "turn.failed": self = .semantic(RemoteSemanticEvent(name: .turnFailed, method: method, params: params))
        default: self = .unknown(UnknownRemoteEvent(method: method, params: params))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case let .connectionStatus(value):
            try container.encode("connection.status", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .threadListSnapshot(value):
            try container.encode("thread.list.snapshot", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .threadSnapshot(value):
            try container.encode("thread.snapshot", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .threadUpsert(value):
            try container.encode("thread.upsert", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .threadRemoved(value):
            try container.encode("thread.removed", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .turnStarted(value):
            try container.encode("turn.started", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .turnCompleted(value):
            try container.encode("turn.completed", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .itemUpsert(value):
            try container.encode("item.upsert", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .itemDelta(value):
            try container.encode("item.delta", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .turnDiffUpdated(value):
            try container.encode("turn.diff.updated", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .approvalRequested(value):
            try container.encode("approval.requested", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .approvalResolved(value):
            try container.encode("approval.resolved", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .error(value):
            try container.encode("error", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .raw(value):
            try container.encode("raw", forKey: .method)
            try container.encode(value, forKey: .params)
        case let .semantic(value):
            try container.encode(value.method, forKey: .method)
            try container.encode(value.params, forKey: .params)
        case let .unknown(value):
            try container.encode(value.method, forKey: .method)
            try container.encode(value.params, forKey: .params)
        }
    }
}

public struct EventEnvelope: Codable, Equatable {
    public var kind: MessageKind
    public var sequence: Int64
    public var eventID: String
    public var event: RemoteEvent
    public var rawFields: [String: JSONValue]

    public init(sequence: Int64, eventID: String, event: RemoteEvent, kind: MessageKind = .event, rawFields: [String: JSONValue] = [:]) {
        self.kind = kind
        self.sequence = sequence
        self.eventID = eventID
        self.event = event
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case sequence
        case eventID = "eventId"
        case event
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(MessageKind.self, forKey: .kind)
        sequence = try container.decode(Int64.self, forKey: .sequence)
        eventID = try container.decode(String.self, forKey: .eventID)
        event = try container.decode(RemoteEvent.self, forKey: .event)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["kind"] = .string(kind.rawValue)
        object["sequence"] = .number(Double(sequence))
        object["eventId"] = .string(eventID)
        object["event"] = try encodeJSONValue(event)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct TurnStartParameters: Codable, Equatable {
    public var threadID: String
    public var text: String
    public var clientRequestID: String
    public var attachments: [RemoteAttachment]
    public var rawFields: [String: JSONValue]

    public init(threadID: String, text: String, clientRequestID: String, attachments: [RemoteAttachment] = [], rawFields: [String: JSONValue] = [:]) {
        self.threadID = threadID
        self.text = text
        self.clientRequestID = clientRequestID
        self.attachments = attachments
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case threadID = "threadId"
        case text
        case clientRequestID = "clientRequestId"
        case attachments
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        threadID = try container.decode(String.self, forKey: .threadID)
        text = try container.decode(String.self, forKey: .text)
        clientRequestID = try container.decode(String.self, forKey: .clientRequestID)
        attachments = try container.decodeIfPresent([RemoteAttachment].self, forKey: .attachments) ?? []
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["threadId"] = .string(threadID)
        object["text"] = .string(text)
        object["clientRequestId"] = .string(clientRequestID)
        object["attachments"] = try encodeJSONValue(attachments)
        try JSONValue.object(object).encode(to: encoder)
    }
}

public struct ClientRequestEnvelope: Codable, Equatable {
    public var kind: MessageKind
    public var id: String
    public var method: ClientMethod
    public var params: JSONValue
    public var rawFields: [String: JSONValue]

    public init(id: String, method: ClientMethod, params: JSONValue, kind: MessageKind = .request, rawFields: [String: JSONValue] = [:]) {
        self.kind = kind
        self.id = id
        self.method = method
        self.params = params
        self.rawFields = rawFields
    }

    public var turnStartParameters: TurnStartParameters? {
        guard method == .turnStart else { return nil }
        return try? params.decode(TurnStartParameters.self)
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case id
        case method
        case params
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(MessageKind.self, forKey: .kind)
        id = try container.decode(String.self, forKey: .id)
        method = try container.decode(ClientMethod.self, forKey: .method)
        params = try container.decode(JSONValue.self, forKey: .params)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["kind"] = .string(kind.rawValue)
        object["id"] = .string(id)
        object["method"] = .string(method.rawValue)
        object["params"] = params
        try JSONValue.object(object).encode(to: encoder)
    }
}

public enum RemoteProtocol {
    /// 生成只用于请求关联的 ID；回合幂等使用 params.clientRequestId 另行保证。
    public static func makeRequestID() -> String {
        UUID().uuidString.lowercased()
    }

    public static func makeRequest(
        method: ClientMethod,
        params: JSONValue = .object([:]),
        id: String? = nil
    ) -> ClientRequestEnvelope {
        ClientRequestEnvelope(
            id: id ?? makeRequestID(),
            method: method,
            params: params
        )
    }
}

public struct ResponseError: Codable, Equatable {
    public let code: String
    public let message: String
    public let details: JSONValue?

    public init(code: String, message: String, details: JSONValue? = nil) {
        self.code = code
        self.message = message
        self.details = details
    }
}

public struct ServerResponseEnvelope: Codable, Equatable {
    public var kind: MessageKind
    public var id: String
    public var ok: Bool
    public var result: JSONValue?
    public var error: ResponseError?
    public var rawFields: [String: JSONValue]

    public init(kind: MessageKind = .response, id: String, ok: Bool, result: JSONValue? = nil, error: ResponseError? = nil, rawFields: [String: JSONValue] = [:]) {
        self.kind = kind
        self.id = id
        self.ok = ok
        self.result = result
        self.error = error
        self.rawFields = rawFields
    }

    private enum CodingKeys: String, CodingKey {
        case kind
        case id
        case ok
        case result
        case error
    }

    public init(from decoder: Decoder) throws {
        rawFields = try JSONValue(from: decoder).objectValue ?? [:]
        let container = try decoder.container(keyedBy: CodingKeys.self)
        kind = try container.decode(MessageKind.self, forKey: .kind)
        id = try container.decode(String.self, forKey: .id)
        ok = try container.decode(Bool.self, forKey: .ok)
        result = try container.decodeIfPresent(JSONValue.self, forKey: .result)
        error = try container.decodeIfPresent(ResponseError.self, forKey: .error)
    }

    public func encode(to encoder: Encoder) throws {
        var object = rawFields
        object["kind"] = .string(kind.rawValue)
        object["id"] = .string(id)
        object["ok"] = .bool(ok)
        setOptional(&object, key: "result", value: result)
        if let error {
            object["error"] = try encodeJSONValue(error)
        }
        try JSONValue.object(object).encode(to: encoder)
    }
}

public enum WireMessage: Codable, Equatable {
    case request(ClientRequestEnvelope)
    case response(ServerResponseEnvelope)
    case event(EventEnvelope)
    case unknown(kind: String, payload: JSONValue)

    public init(from decoder: Decoder) throws {
        let value = try JSONValue(from: decoder)
        guard let object = value.objectValue, let kind = object["kind"]?.stringValue else {
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "远程消息缺少 kind"))
        }
        let data = try JSONEncoder().encode(value)
        switch kind {
        case "request": self = .request(try JSONDecoder().decode(ClientRequestEnvelope.self, from: data))
        case "response": self = .response(try JSONDecoder().decode(ServerResponseEnvelope.self, from: data))
        case "event": self = .event(try JSONDecoder().decode(EventEnvelope.self, from: data))
        default: self = .unknown(kind: kind, payload: value)
        }
    }

    public func encode(to encoder: Encoder) throws {
        switch self {
        case let .request(value): try value.encode(to: encoder)
        case let .response(value): try value.encode(to: encoder)
        case let .event(value): try value.encode(to: encoder)
        case let .unknown(kind, payload):
            guard case let .object(fields) = payload else {
                try payload.encode(to: encoder)
                return
            }
            var updated = fields
            updated["kind"] = .string(kind)
            try JSONValue.object(updated).encode(to: encoder)
        }
    }
}

public extension WireMessage {
    /// 将当前 mock 文件名映射到其语义名称，同时保留真实 wire method。
    var fixtureKind: FixtureKind? {
        switch self {
        case let .request(request):
            if request.method == .turnStart, let parameters = request.turnStartParameters, !parameters.attachments.isEmpty {
                return .turnAttachment
            }
            return nil
        case let .event(envelope):
            switch envelope.event {
            case .threadListSnapshot: return .threadListSnapshot
            case let .itemUpsert(value) where value.item.type == .plan: return .turnPlanUpdated
            case let .itemDelta(value) where value.target == .toolOutput: return .toolProgress
            case .turnDiffUpdated: return .turnDiffUpdated
            case .approvalRequested: return .approvalRequested
            case let .turnCompleted(value) where value.turn.status == .failed: return .turnFailed
            case let .semantic(value): return value.name
            default: return nil
            }
        case .response, .unknown:
            return nil
        }
    }
}

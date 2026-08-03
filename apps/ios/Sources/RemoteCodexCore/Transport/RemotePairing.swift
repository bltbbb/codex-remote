import Foundation

#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public struct RemoteDeviceSummary: Codable, Equatable {
    public let id: String
    public let name: String
    public let createdAt: Int64
    public let lastSeenAt: Int64
    public let revokedAt: Int64?

    public init(
        id: String,
        name: String,
        createdAt: Int64,
        lastSeenAt: Int64,
        revokedAt: Int64? = nil
    ) {
        self.id = id
        self.name = name
        self.createdAt = createdAt
        self.lastSeenAt = lastSeenAt
        self.revokedAt = revokedAt
    }
}

public struct RemotePairingResponse: Codable, Equatable {
    public let device: RemoteDeviceSummary
    public let token: String

    public init(device: RemoteDeviceSummary, token: String) {
        self.device = device
        self.token = token
    }
}

public enum RemotePairingError: Error, Equatable, LocalizedError {
    case invalidCode
    case invalidName
    case invalidEndpoint
    case http(status: Int, message: String)
    case invalidResponse(String)
    case transport(String)

    public var errorDescription: String? {
        switch self {
        case .invalidCode:
            return "请输入 6 位数字配对码"
        case .invalidName:
            return "设备名称不能为空"
        case .invalidEndpoint:
            return "Bridge 地址无效，需使用 ws:// 或 wss:// WebSocket 地址"
        case let .http(status, message):
            return "配对失败（\(status)）：\(message)"
        case let .invalidResponse(detail):
            return "配对响应格式无效：\(detail)"
        case let .transport(message):
            return "配对网络请求失败：\(message)"
        }
    }
}

public protocol RemotePairingService: AnyObject {
    func completePairing(code: String, name: String) async throws -> RemotePairingResponse
}

public extension RemoteWebSocketEndpoint {
    var pairingURL: URL? {
        guard let scheme = url.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }

        components.scheme = scheme == "wss" ? "https" : "http"
        components.path = "/api/pairing/complete"
        components.query = nil
        components.fragment = nil
        return components.url
    }
}

public final class RemotePairingClient: RemotePairingService {
    public let pairingURL: URL
    private let session: URLSession

    public convenience init(
        endpoint: RemoteWebSocketEndpoint,
        session: URLSession = .shared
    ) throws {
        guard let pairingURL = endpoint.pairingURL else {
            throw RemotePairingError.invalidEndpoint
        }
        self.init(pairingURL: pairingURL, session: session)
    }

    public init(pairingURL: URL, session: URLSession = .shared) {
        self.pairingURL = pairingURL
        self.session = session
    }

    public func completePairing(code: String, name: String) async throws -> RemotePairingResponse {
        guard code.utf8.count == 6,
              code.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else {
            throw RemotePairingError.invalidCode
        }

        let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedName.isEmpty else {
            throw RemotePairingError.invalidName
        }

        let body = PairingRequest(code: code, name: String(trimmedName.prefix(80)))
        var request = URLRequest(url: pairingURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(body)

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw RemotePairingError.transport(error.localizedDescription)
        }

        guard let httpResponse = response as? HTTPURLResponse else {
            throw RemotePairingError.invalidResponse("缺少 HTTP 响应")
        }

        let decoder = JSONDecoder()
        guard (200..<300).contains(httpResponse.statusCode) else {
            let message = (try? decoder.decode(PairingFailure.self, from: data)).flatMap(\.error)
                ?? "服务器拒绝了配对请求"
            throw RemotePairingError.http(status: httpResponse.statusCode, message: message)
        }

        do {
            return try decoder.decode(RemotePairingResponse.self, from: data)
        } catch {
            throw RemotePairingError.invalidResponse(error.localizedDescription)
        }
    }
}

private struct PairingRequest: Codable {
    let code: String
    let name: String
}

private struct PairingFailure: Codable {
    let error: String?
}

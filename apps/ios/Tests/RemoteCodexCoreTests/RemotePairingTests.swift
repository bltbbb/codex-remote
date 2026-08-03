import Foundation
import XCTest
@testable import RemoteCodexCore

final class RemotePairingTests: XCTestCase {
    func testEndpointBuildsPairingURLWithoutWebSocketQuery() throws {
        let endpoint = RemoteWebSocketEndpoint(
            url: URL(string: "wss://bridge.example:443/ws?client=ios")!
        )

        XCTAssertEqual(
            endpoint.pairingURL?.absoluteString,
            "https://bridge.example:443/api/pairing/complete"
        )
    }

    func testPairingClientSendsRequestAndDecodesResponse() async throws {
        PairingURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.absoluteString, "http://bridge.example/api/pairing/complete")
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

            let body = try XCTUnwrap(request.httpBody)
            let object = try XCTUnwrap(
                JSONSerialization.jsonObject(with: body) as? [String: String]
            )
            XCTAssertEqual(object["code"], "123456")
            XCTAssertEqual(object["name"], "测试手机")

            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 200,
                httpVersion: nil,
                headerFields: nil
            )!
            let data = Data(
                """
                {
                  "device": {
                    "id": "device-1",
                    "name": "测试手机",
                    "createdAt": 1,
                    "lastSeenAt": 2,
                    "revokedAt": null
                  },
                  "token": "secret-token"
                }
                """.utf8
            )
            return (response, data)
        }
        defer { PairingURLProtocol.handler = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingURLProtocol.self]
        let session = URLSession(configuration: configuration)
        let client = try RemotePairingClient(
            endpoint: RemoteWebSocketEndpoint(
                url: URL(string: "ws://bridge.example/ws")!
            ),
            session: session
        )

        let result = try await client.completePairing(code: "123456", name: "测试手机")

        XCTAssertEqual(result.token, "secret-token")
        XCTAssertEqual(result.device.id, "device-1")
        XCTAssertEqual(result.device.name, "测试手机")
    }

    func testPairingClientMapsHTTPFailure() async throws {
        PairingURLProtocol.handler = { request in
            let response = HTTPURLResponse(
                url: try XCTUnwrap(request.url),
                statusCode: 400,
                httpVersion: nil,
                headerFields: nil
            )!
            return (
                response,
                Data("{\"ok\":false,\"error\":\"配对码无效或已经过期\"}".utf8)
            )
        }
        defer { PairingURLProtocol.handler = nil }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [PairingURLProtocol.self]
        let client = RemotePairingClient(
            pairingURL: URL(string: "http://bridge.example/api/pairing/complete")!,
            session: URLSession(configuration: configuration)
        )

        do {
            _ = try await client.completePairing(code: "123456", name: "测试手机")
            XCTFail("HTTP 失败应抛出配对错误")
        } catch let error as RemotePairingError {
            XCTAssertEqual(
                error,
                .http(status: 400, message: "配对码无效或已经过期")
            )
        }
    }

    func testPairingClientRejectsInvalidInput() async throws {
        let client = RemotePairingClient(
            pairingURL: URL(string: "http://bridge.example/api/pairing/complete")!
        )

        do {
            _ = try await client.completePairing(code: "12", name: "测试手机")
            XCTFail("短配对码应被拒绝")
        } catch let error as RemotePairingError {
            XCTAssertEqual(error, .invalidCode)
        }

        do {
            _ = try await client.completePairing(code: "123456", name: " ")
            XCTFail("空设备名应被拒绝")
        } catch let error as RemotePairingError {
            XCTAssertEqual(error, .invalidName)
        }
    }

    #if canImport(Security)
    func testKeychainStoresUpdatesAndDeletesToken() throws {
        let store = KeychainRemoteCredentialStore(
            service: "com.codex-remote.tests.\(UUID().uuidString)",
            account: "test"
        )
        defer { try? store.deleteToken() }

        XCTAssertNil(try store.loadToken())

        try store.saveToken("token-one")
        XCTAssertEqual(try store.loadToken(), "token-one")

        try store.saveToken("token-two")
        XCTAssertEqual(try store.loadToken(), "token-two")

        try store.deleteToken()
        XCTAssertNil(try store.loadToken())
    }
    #endif
}

private final class PairingURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool {
        true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(
                self,
                didFailWithError: RemotePairingError.transport("测试 HTTP 处理器未配置")
            )
            return
        }

        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

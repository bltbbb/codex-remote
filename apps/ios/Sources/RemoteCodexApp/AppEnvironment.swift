import Combine
import Foundation
import RemoteCodexCore

enum AppEnvironmentError: Error, LocalizedError {
    case invalidEndpoint
    case credential(String)

    var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            return "Bridge 地址无效，需使用 ws:// 或 wss:// WebSocket 地址"
        case let .credential(message):
            return "设备令牌保存失败：\(message)"
        }
    }
}

@MainActor
final class AppEnvironment: ObservableObject {
    @Published private(set) var store: RemoteAppStore
    @Published private(set) var isPaired: Bool
    @Published private(set) var endpointText: String
    @Published private(set) var pairedDeviceName: String?
    @Published var setupErrorMessage: String?

    private let credentialStore: any RemoteCredentialStore
    private let defaults: UserDefaults
    private var endpoint: RemoteWebSocketEndpoint
    private var storeCancellable: AnyCancellable?

    private static let endpointDefaultsKey = "remote-codex.websocket-url"
    private static let deviceNameDefaultsKey = "remote-codex.device-name"
    private static let defaultEndpointURL = URL(string: "ws://127.0.0.1:18787/ws")!

    var state: RemoteState {
        store.state
    }

    init(
        store: RemoteAppStore? = nil,
        credentialStore: any RemoteCredentialStore = KeychainRemoteCredentialStore(),
        defaults: UserDefaults = .standard
    ) {
        let resolvedEndpoint = Self.endpoint(
            from: defaults.string(forKey: Self.endpointDefaultsKey)
        ) ?? RemoteWebSocketEndpoint(url: Self.defaultEndpointURL)
        var savedToken: String?
        do {
            savedToken = try credentialStore.loadToken()
        } catch {
            savedToken = nil
        }

        self.credentialStore = credentialStore
        self.defaults = defaults
        self.endpoint = resolvedEndpoint
        self.endpointText = resolvedEndpoint.url.absoluteString
        self.isPaired = store != nil || savedToken != nil
        self.pairedDeviceName = defaults.string(forKey: Self.deviceNameDefaultsKey)
        self.setupErrorMessage = nil
        self.store = store ?? Self.makeStore(endpoint: resolvedEndpoint, token: savedToken)
        bindStore()
    }

    func pair(code: String, name: String, serverURL: String) async throws -> RemotePairingResponse {
        let nextEndpoint = try Self.parseEndpoint(serverURL)
        let pairingClient = try RemotePairingClient(endpoint: nextEndpoint)
        let result = try await pairingClient.completePairing(code: code, name: name)

        do {
            try credentialStore.saveToken(result.token)
        } catch {
            throw AppEnvironmentError.credential(error.localizedDescription)
        }

        defaults.set(nextEndpoint.url.absoluteString, forKey: Self.endpointDefaultsKey)
        defaults.set(result.device.name, forKey: Self.deviceNameDefaultsKey)
        endpoint = nextEndpoint
        endpointText = nextEndpoint.url.absoluteString
        pairedDeviceName = result.device.name
        await replaceStore(endpoint: nextEndpoint, token: result.token)
        isPaired = true
        setupErrorMessage = nil
        return result
    }

    func forgetPairing() async {
        do {
            try credentialStore.deleteToken()
            await replaceStore(endpoint: endpoint, token: nil)
            defaults.removeObject(forKey: Self.deviceNameDefaultsKey)
            pairedDeviceName = nil
            isPaired = false
            setupErrorMessage = nil
        } catch {
            setupErrorMessage = error.localizedDescription
        }
    }

    func clearSetupError() {
        setupErrorMessage = nil
    }

    private func bindStore() {
        storeCancellable = store.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.objectWillChange.send()
                }
            }
    }

    private func replaceStore(endpoint: RemoteWebSocketEndpoint, token: String?) async {
        await store.close()
        store = Self.makeStore(endpoint: endpoint, token: token)
        bindStore()
    }

    private static func makeStore(
        endpoint: RemoteWebSocketEndpoint,
        token: String?
    ) -> RemoteAppStore {
        RemoteAppStore(
            endpoint: RemoteWebSocketEndpoint(
                url: endpoint.url,
                deviceToken: token
            )
        )
    }

    private static func endpoint(from value: String?) -> RemoteWebSocketEndpoint? {
        guard let value else { return nil }
        return try? parseEndpoint(value)
    }

    private static func parseEndpoint(_ value: String) throws -> RemoteWebSocketEndpoint {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              (scheme == "ws" || scheme == "wss"),
              url.host != nil else {
            throw AppEnvironmentError.invalidEndpoint
        }

        let endpoint = RemoteWebSocketEndpoint(url: url)
        guard endpoint.pairingURL != nil else {
            throw AppEnvironmentError.invalidEndpoint
        }
        return endpoint
    }
}

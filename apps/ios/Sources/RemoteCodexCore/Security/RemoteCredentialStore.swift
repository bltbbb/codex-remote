import Foundation

#if canImport(Security)
import Security
#endif

public protocol RemoteCredentialStore: AnyObject {
    func loadToken() throws -> String?
    func saveToken(_ token: String) throws
    func deleteToken() throws
}

public enum RemoteCredentialStoreError: Error, Equatable, LocalizedError {
    case emptyToken
    case unavailable
    case keychainStatus(Int32)
    case invalidStoredValue

    public var errorDescription: String? {
        switch self {
        case .emptyToken:
            return "设备令牌不能为空"
        case .unavailable:
            return "当前平台不支持 Keychain"
        case let .keychainStatus(status):
            return "Keychain 操作失败：\(status)"
        case .invalidStoredValue:
            return "Keychain 中的设备令牌格式无效"
        }
    }
}

#if canImport(Security)
public final class KeychainRemoteCredentialStore: RemoteCredentialStore {
    private let service: String
    private let account: String

    public init(
        service: String = "com.codex-remote.device",
        account: String = "primary"
    ) {
        self.service = service
        self.account = account
    }

    public func loadToken() throws -> String? {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            guard let data = item as? Data,
                  let token = String(data: data, encoding: .utf8),
                  !token.isEmpty else {
                throw RemoteCredentialStoreError.invalidStoredValue
            }
            return token
        case errSecItemNotFound:
            return nil
        default:
            throw RemoteCredentialStoreError.keychainStatus(status)
        }
    }

    public func saveToken(_ token: String) throws {
        guard !token.isEmpty else {
            throw RemoteCredentialStoreError.emptyToken
        }

        let data = Data(token.utf8)
        let updateAttributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(
            baseQuery as CFDictionary,
            updateAttributes as CFDictionary
        )

        if updateStatus == errSecSuccess {
            return
        }
        guard updateStatus == errSecItemNotFound else {
            throw RemoteCredentialStoreError.keychainStatus(updateStatus)
        }

        var addQuery = baseQuery
        addQuery[kSecValueData as String] = data
        addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
        guard addStatus == errSecSuccess else {
            throw RemoteCredentialStoreError.keychainStatus(addStatus)
        }
    }

    public func deleteToken() throws {
        let status = SecItemDelete(baseQuery as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw RemoteCredentialStoreError.keychainStatus(status)
        }
    }

    private var baseQuery: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }
}
#else
public final class KeychainRemoteCredentialStore: RemoteCredentialStore {
    public init(
        service: String = "com.codex-remote.device",
        account: String = "primary"
    ) {}

    public func loadToken() throws -> String? {
        throw RemoteCredentialStoreError.unavailable
    }

    public func saveToken(_ token: String) throws {
        throw RemoteCredentialStoreError.unavailable
    }

    public func deleteToken() throws {
        throw RemoteCredentialStoreError.unavailable
    }
}
#endif

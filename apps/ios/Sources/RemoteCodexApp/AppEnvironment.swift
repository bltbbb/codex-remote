import Combine
import Foundation
import RemoteCodexCore

@MainActor
final class AppEnvironment: ObservableObject {
    let store: RemoteAppStore
    private var cancellables: Set<AnyCancellable> = []

    var state: RemoteState {
        store.state
    }

    init(store: RemoteAppStore = AppEnvironment.makeDefaultStore()) {
        self.store = store
        store.objectWillChange
            .sink { [weak self] _ in
                Task { @MainActor in
                    self?.objectWillChange.send()
                }
            }
            .store(in: &cancellables)
    }

    private static func makeDefaultStore() -> RemoteAppStore {
        RemoteAppStore(
            endpoint: RemoteWebSocketEndpoint(url: URL(string: "ws://127.0.0.1:18787/ws")!)
        )
    }
}

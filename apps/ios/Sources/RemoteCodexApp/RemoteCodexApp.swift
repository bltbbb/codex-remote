import SwiftUI

@main
struct RemoteCodexApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var environment = AppEnvironment()
    @State private var needsForegroundReconnect = false

    var body: some Scene {
        WindowGroup {
            RootView(environment: environment)
                .onChange(of: scenePhase) { phase in
                    switch phase {
                    case .background:
                        needsForegroundReconnect = true
                    case .active where needsForegroundReconnect:
                        needsForegroundReconnect = false
                        guard environment.isPaired else { return }
                        Task {
                            await environment.store.reconnect()
                        }
                    case .active, .inactive:
                        break
                    @unknown default:
                        break
                    }
                }
        }
    }
}

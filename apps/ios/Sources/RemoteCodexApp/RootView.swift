import RemoteCodexCore
import SwiftUI

struct RootView: View {
    @ObservedObject var environment: AppEnvironment
    @State private var selectedThreadID: String?
    @State private var messageDraft = ""
    @State private var isRefreshing = false

    var body: some View {
        NavigationSplitView {
            ThreadSidebarView(
                store: environment.store,
                selectedThreadID: $selectedThreadID,
                isRefreshing: $isRefreshing,
                refreshThreads: refreshThreads
            )
        } detail: {
            ThreadDetailView(
                store: environment.store,
                messageDraft: $messageDraft
            )
        }
        .safeAreaInset(edge: .top) {
            if let message = environment.store.lastErrorMessage {
                ErrorBannerView(message: message) {
                    environment.store.clearError()
                }
                .padding(.horizontal)
                .padding(.top, 8)
            }
        }
        .task {
            await environment.store.connect()
        }
        .onAppear {
            selectedThreadID = environment.store.state.activeThreadID
        }
        .onChange(of: selectedThreadID) { threadID in
            guard let threadID else {
                environment.store.selectThread(nil)
                return
            }
            environment.store.selectThread(threadID)
            Task {
                await environment.store.loadThread(threadID)
            }
        }
        .onChange(of: environment.store.state.activeThreadID) { threadID in
            guard selectedThreadID != threadID else { return }
            selectedThreadID = threadID
        }
        .onChange(of: environment.store.state.connection.phase) { phase in
            guard phase == .online else { return }
            Task {
                await refreshThreads()
            }
        }
    }

    private func refreshThreads() async {
        guard environment.store.connectionPhase == .online else { return }
        isRefreshing = true
        defer { isRefreshing = false }
        await environment.store.loadThreads()
    }
}

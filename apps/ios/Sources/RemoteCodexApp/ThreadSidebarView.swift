import RemoteCodexCore
import SwiftUI

struct ThreadSidebarView: View {
    @ObservedObject var store: RemoteAppStore
    @Binding var selectedThreadID: String?
    @Binding var isRefreshing: Bool
    let refreshThreads: () async -> Void
    let pairedDeviceName: String
    let forgetPairing: () async -> Void
    @State private var isCreating = false
    @State private var showingWorkspacePicker = false
    @State private var isLoadingWorkspaces = false
    @State private var workspaceLoadError: String?
    @State private var workspaces: [RemoteWorkspace] = []
    @State private var showingPairingSettings = false

    var body: some View {
        List(selection: $selectedThreadID) {
            Section {
                ConnectionStatusView(store: store)

                HStack(spacing: 12) {
                    Button {
                        Task {
                            await refreshThreads()
                        }
                    } label: {
                        Label("刷新线程", systemImage: "arrow.clockwise")
                    }
                    .disabled(isRefreshing || store.connectionPhase != .online)

                    Button {
                        loadWorkspacesForCreation()
                    } label: {
                        Label("新建线程", systemImage: "plus")
                    }
                    .disabled(isCreating || isLoadingWorkspaces || store.connectionPhase != .online)

                    Spacer(minLength: 0)

                    if isRefreshing || isCreating {
                        ProgressView()
                            .controlSize(.small)
                    }
                }

                Button {
                    showingPairingSettings = true
                } label: {
                    HStack(spacing: 8) {
                        Label("配对设置", systemImage: "person.badge.key")
                        Spacer(minLength: 8)
                        Text(pairedDeviceName)
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .lineLimit(1)
                    }
                }
                .buttonStyle(.borderless)
            }

            Section("线程") {
                if store.state.threadOrder.isEmpty {
                    Text(emptyMessage)
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ForEach(store.state.threadOrder, id: \.self) { threadID in
                        if let thread = store.state.threads[threadID] {
                            NavigationLink(value: threadID) {
                                ThreadRowView(thread: thread)
                            }
                            .tag(threadID as String?)
                        }
                    }
                }

                if let nextCursor = store.state.nextThreadCursor, !nextCursor.isEmpty {
                    Button {
                        Task {
                            isRefreshing = true
                            await store.loadThreads(cursor: nextCursor)
                            isRefreshing = false
                        }
                    } label: {
                        Label("加载更多", systemImage: "ellipsis.circle")
                    }
                    .disabled(isRefreshing || store.connectionPhase != .online)
                }
            }
        }
        .navigationTitle("Codex Remote")
        .listStyle(.sidebar)
        .sheet(isPresented: $showingWorkspacePicker) {
            WorkspacePickerView(
                workspaces: workspaces,
                isLoading: isLoadingWorkspaces,
                errorMessage: workspaceLoadError,
                isCreating: isCreating,
                onSelect: createThread,
                onRetry: loadWorkspacesForCreation,
                onClose: {
                    guard !isCreating else { return }
                    showingWorkspacePicker = false
                }
            )
        }
        .confirmationDialog(
            "配对设置",
            isPresented: $showingPairingSettings,
            titleVisibility: .visible
        ) {
            Button("清除本机配对", role: .destructive) {
                Task {
                    await forgetPairing()
                }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("清除后需要重新输入电脑端生成的配对码")
        }
    }

    private var emptyMessage: String {
        switch store.connectionPhase {
        case .connecting:
            return "正在连接电脑..."
        case .online:
            return "暂无线程"
        case .offline, .error, .unknown(_):
            return "连接后加载线程"
        }
    }

    private func loadWorkspacesForCreation() {
        guard store.connectionPhase == .online, !isCreating else { return }
        showingWorkspacePicker = true
        isLoadingWorkspaces = true
        workspaceLoadError = nil
        Task {
            defer { isLoadingWorkspaces = false }
            guard let result = await store.loadWorkspaces() else {
                workspaceLoadError = store.lastErrorMessage ?? "工作区加载失败，请重试"
                return
            }
            workspaces = result.workspaces
        }
    }

    private func createThread(_ workspace: RemoteWorkspace) {
        guard !isCreating else { return }
        isCreating = true
        Task {
            defer { isCreating = false }
            let thread = await store.createThread(cwd: workspace.path)
            guard let thread else { return }
            selectedThreadID = thread.id
            showingWorkspacePicker = false
        }
    }
}

private struct WorkspacePickerView: View {
    let workspaces: [RemoteWorkspace]
    let isLoading: Bool
    let errorMessage: String?
    let isCreating: Bool
    let onSelect: (RemoteWorkspace) -> Void
    let onRetry: () -> Void
    let onClose: () -> Void

    var body: some View {
        NavigationStack {
            Group {
                if isLoading {
                    ProgressView("正在加载电脑工作区...")
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let errorMessage {
                    VStack(spacing: 12) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.title2)
                            .foregroundColor(.orange)
                        Text(errorMessage)
                            .multilineTextAlignment(.center)
                            .foregroundColor(.secondary)
                        Button("重试", action: onRetry)
                            .buttonStyle(.borderedProminent)
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if workspaces.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "folder")
                            .font(.title2)
                            .foregroundColor(.secondary)
                        Text("电脑端尚未暴露可用工作区")
                            .foregroundColor(.secondary)
                        Text("请在 Bridge 配置工作区后重试。")
                            .font(.caption)
                            .foregroundColor(.secondary)
                            .multilineTextAlignment(.center)
                        Button("重新加载", action: onRetry)
                            .buttonStyle(.bordered)
                    }
                    .padding(24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List(workspaces) { workspace in
                        Button {
                            onSelect(workspace)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(workspace.name.isEmpty ? "未命名工作区" : workspace.name)
                                    .font(.headline)
                                    .foregroundColor(.primary)
                                Text(workspace.path)
                                    .font(.caption)
                                    .foregroundColor(.secondary)
                                    .lineLimit(2)
                                Text(sourceTitle(workspace.source))
                                    .font(.caption2)
                                    .foregroundColor(.secondary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isCreating)
                    }
                }
            }
            .navigationTitle("选择工作区")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消", action: onClose)
                        .disabled(isCreating)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func sourceTitle(_ source: RemoteWorkspaceSource) -> String {
        switch source {
        case .configured:
            return "电脑配置"
        case .history:
            return "历史会话"
        case let .unknown(value):
            return value
        }
    }
}

private struct ConnectionStatusView: View {
    @ObservedObject var store: RemoteAppStore
    @State private var showingConnectionDetails = false

    var body: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 9, height: 9)

            VStack(alignment: .leading, spacing: 2) {
                Text(statusTitle)
                    .font(.subheadline.weight(.semibold))
                Text(store.state.connection.message)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 8)

            if shouldShowDetailsButton {
                Button {
                    showingConnectionDetails = true
                } label: {
                    Image(systemName: "info.circle")
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("查看完整连接信息")
            }

            Button {
                Task {
                    if store.connectionPhase == .online || store.connectionPhase == .connecting {
                        await store.close()
                    } else {
                        await store.connect()
                    }
                }
            } label: {
                Image(systemName: store.connectionPhase == .online ? "xmark.circle" : "link")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel(store.connectionPhase == .online ? "断开连接" : "连接电脑")
            .disabled(store.connectionPhase == .connecting)
        }
        .padding(.vertical, 4)
        .alert("连接详情", isPresented: $showingConnectionDetails) {
            Button("确定", role: .cancel) {}
        } message: {
            Text(store.state.connection.message)
        }
    }

    private var shouldShowDetailsButton: Bool {
        store.connectionPhase != .online || store.state.connection.message.count > 36
    }

    private var statusTitle: String {
        switch store.connectionPhase {
        case .connecting:
            return "连接中"
        case .online:
            return "已连接"
        case .offline:
            return "未连接"
        case .error:
            return "连接错误"
        case let .unknown(value):
            return value
        }
    }

    private var statusColor: Color {
        switch store.connectionPhase {
        case .connecting:
            return .orange
        case .online:
            return .green
        case .offline:
            return .gray
        case .error:
            return .red
        case .unknown(_):
            return .gray
        }
    }
}

private struct ThreadRowView: View {
    let thread: RemoteThread

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            Circle()
                .fill(thread.status == "active" ? Color.orange : Color.secondary.opacity(0.45))
                .frame(width: 8, height: 8)
                .padding(.top, 6)

            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(thread.title.isEmpty ? "未命名线程" : thread.title)
                        .font(.headline)
                        .lineLimit(1)

                    if thread.isPinned {
                        Image(systemName: "pin.fill")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }
                }

                if !thread.preview.isEmpty {
                    Text(thread.preview)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }

                if !thread.cwd.isEmpty {
                    Text(thread.cwd)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .padding(.vertical, 3)
    }
}

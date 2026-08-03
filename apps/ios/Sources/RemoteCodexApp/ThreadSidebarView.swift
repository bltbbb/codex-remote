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
    @State private var showingCreateThread = false
    @State private var showingPairingSettings = false
    @State private var newThreadCWD = ""

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
                        showingCreateThread = true
                    } label: {
                        Label("新建线程", systemImage: "plus")
                    }
                    .disabled(isCreating || store.connectionPhase != .online)

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
        .alert("新建线程", isPresented: $showingCreateThread) {
            TextField("电脑上的工作目录", text: $newThreadCWD)
            Button("创建") {
                createThread()
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("输入电脑上已允许的工作目录")
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

    private func createThread() {
        let cwd = newThreadCWD.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cwd.isEmpty else { return }
        isCreating = true
        Task {
            let thread = await store.createThread(cwd: cwd)
            if let thread = thread {
                selectedThreadID = thread.id
                newThreadCWD = ""
            }
            isCreating = false
        }
    }
}

private struct ConnectionStatusView: View {
    @ObservedObject var store: RemoteAppStore

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
                    .lineLimit(1)
            }

            Spacer(minLength: 8)

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

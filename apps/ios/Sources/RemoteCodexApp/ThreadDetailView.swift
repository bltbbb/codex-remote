import RemoteCodexCore
import SwiftUI

struct ThreadDetailView: View {
    @ObservedObject var store: RemoteAppStore
    @Binding var messageDraft: String
    @State private var isSending = false
    @State private var isStopping = false

    var body: some View {
        Group {
            if let thread = store.currentThread {
                ThreadTimelineView(store: store, thread: thread)
            } else {
                EmptyThreadDetailView()
            }
        }
        .navigationTitle(store.currentThread?.title ?? "Codex Remote")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    Task {
                        isStopping = true
                        _ = await store.interruptCurrentTurn()
                        isStopping = false
                    }
                } label: {
                    Label("停止", systemImage: "stop.fill")
                }
                .disabled(isStopping || !canInterrupt || store.connectionPhase != .online)
            }
        }
        .safeAreaInset(edge: .bottom) {
            ComposerView(
                text: $messageDraft,
                isSending: isSending,
                isEnabled: store.currentThread != nil && store.connectionPhase == .online,
                send: sendMessage
            )
            .background(.regularMaterial)
        }
    }

    private var canInterrupt: Bool {
        guard let thread = store.currentThread else { return false }
        return thread.turnIDs.contains { turnID in
            guard let turn = thread.turns[turnID] else { return false }
            switch turn.status {
            case .notStarted, .inProgress:
                return true
            case .completed, .failed, .interrupted, .unknown(_):
                return false
            }
        }
    }

    private func sendMessage() {
        let text = messageDraft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }

        isSending = true
        Task {
            let result = await store.sendTurn(text: text)
            if result != nil {
                messageDraft = ""
            }
            isSending = false
        }
    }
}

private struct EmptyThreadDetailView: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "text.bubble")
                .font(.system(size: 32))
                .foregroundColor(.secondary)
            Text("选择一个线程")
                .font(.headline)
            Text("线程详情和实时回合会显示在这里")
                .font(.subheadline)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }
}

private struct ThreadTimelineView: View {
    @ObservedObject var store: RemoteAppStore
    let thread: RemoteThread

    private var approvals: [ApprovalRequest] {
        store.state.approvals.values
            .filter { $0.threadID == thread.id }
            .sorted { $0.id < $1.id }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                ThreadMetadataView(thread: thread)

                if !approvals.isEmpty {
                    ForEach(approvals, id: \.id) { approval in
                        ApprovalCardView(store: store, approval: approval)
                    }
                }

                if thread.turnIDs.isEmpty {
                    Text("暂无回合")
                        .foregroundColor(.secondary)
                        .frame(maxWidth: .infinity, alignment: .center)
                        .padding(.vertical, 36)
                } else {
                    ForEach(thread.turnIDs, id: \.self) { turnID in
                        if let turn = thread.turns[turnID] {
                            TurnTimelineView(thread: thread, turn: turn)
                        }
                    }
                }
            }
            .padding(.horizontal)
            .padding(.top, 14)
            .padding(.bottom, 10)
        }
        .background(Color(.systemGroupedBackground))
    }
}

private struct ThreadMetadataView: View {
    let thread: RemoteThread

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Label(thread.status.isEmpty ? "未知状态" : thread.status, systemImage: "circle.fill")
                    .font(.caption.weight(.semibold))
                    .foregroundColor(thread.status == "active" ? .orange : .secondary)

                Spacer()

                if !thread.modelProvider.isEmpty {
                    Text(thread.modelProvider)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            if !thread.cwd.isEmpty {
                Text(thread.cwd)
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemGroupedBackground))
        .cornerRadius(8)
    }
}

private struct TurnTimelineView: View {
    let thread: RemoteThread
    let turn: RemoteTurn

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: turn.status == .inProgress ? "bolt.fill" : "arrow.turn.down.right")
                    .foregroundColor(turn.status == .failed ? .red : .accentColor)
                Text(turn.status.displayName)
                    .font(.headline)
                Text(turn.id)
                    .font(.caption2)
                    .foregroundColor(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }

            if let error = turn.error, !error.isEmpty {
                Text(error)
                    .font(.subheadline)
                    .foregroundColor(.red)
                    .textSelection(.enabled)
            }

            ForEach(turn.itemIDs, id: \.self) { itemID in
                if let item = thread.items[itemID] {
                    ItemTimelineView(item: item)
                }
            }

            if let diff = turn.diff, !diff.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Label("变更", systemImage: "arrow.triangle.2.circlepath")
                        .font(.subheadline.weight(.semibold))
                    Text(diff)
                        .font(.system(.footnote, design: .monospaced))
                        .textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(.secondarySystemBackground))
                .cornerRadius(8)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.systemBackground))
        .cornerRadius(8)
    }
}

private struct ItemTimelineView: View {
    let item: RemoteItem

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: item.type.systemImage)
                    .foregroundColor(item.type.tint)
                Text(item.type.displayName)
                    .font(.subheadline.weight(.semibold))
                Text(item.status.displayName)
                    .font(.caption)
                    .foregroundColor(.secondary)
                Spacer(minLength: 0)
            }

            if let phase = item.phase, !phase.isEmpty {
                Text(phase)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            if let command = item.command, !command.isEmpty {
                Text("$ \(command)")
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }

            if let text = item.text, !text.isEmpty {
                Text(text)
                    .textSelection(.enabled)
            }

            ForEach(item.content, id: \.self) { content in
                Text(content)
                    .textSelection(.enabled)
            }

            if !item.summary.isEmpty {
                Text(item.summary.joined(separator: "\n"))
                    .font(.subheadline)
                    .foregroundColor(.secondary)
                    .textSelection(.enabled)
            }

            if !item.output.isEmpty {
                Text(item.output)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }

            if !item.patch.isEmpty {
                Text(item.patch)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }

            if let tool = item.tool, !tool.isEmpty {
                Text(tool)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(7)
    }
}

private struct ApprovalCardView: View {
    @ObservedObject var store: RemoteAppStore
    let approval: ApprovalRequest
    @State private var resolvingDecision: String?

    private var decisions: [String] {
        approval.availableDecisions.isEmpty ? ["accept", "decline"] : approval.availableDecisions
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Label("需要审批", systemImage: "checkmark.shield")
                .font(.headline)
                .foregroundColor(.orange)

            Text(approval.title)
                .font(.subheadline.weight(.semibold))

            if !approval.description.isEmpty {
                Text(approval.description)
                    .font(.subheadline)
                    .textSelection(.enabled)
            }

            if let command = approval.command, !command.isEmpty {
                Text("$ \(command)")
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
            }

            HStack(spacing: 8) {
                ForEach(decisions, id: \.self) { decision in
                    Button {
                        resolvingDecision = decision
                        Task {
                            _ = await store.resolveApproval(approval.id, decision: decision)
                            resolvingDecision = nil
                        }
                    } label: {
                        Text(decision.displayName)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(resolvingDecision != nil)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.orange.opacity(0.12))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.orange.opacity(0.45), lineWidth: 1)
        )
        .cornerRadius(8)
    }
}

private struct ComposerView: View {
    @Binding var text: String
    let isSending: Bool
    let isEnabled: Bool
    let send: () -> Void

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextEditor(text: $text)
                .frame(minHeight: 38, maxHeight: 100)
                .padding(4)
                .overlay(
                    RoundedRectangle(cornerRadius: 7)
                        .stroke(Color.secondary.opacity(0.35), lineWidth: 1)
                )
                .overlay(alignment: .topLeading) {
                    if text.isEmpty {
                        Text("输入消息...")
                            .foregroundColor(.secondary)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 11)
                            .allowsHitTesting(false)
                    }
                }

            Button(action: send) {
                if isSending {
                    ProgressView()
                        .controlSize(.small)
                } else {
                    Image(systemName: "paperplane.fill")
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityLabel("发送消息")
            .disabled(!isEnabled || isSending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }
}

struct ErrorBannerView: View {
    let message: String
    let clear: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundColor(.red)
            Text(message)
                .font(.subheadline)
                .foregroundColor(.primary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
            Button(action: clear) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("清除错误")
        }
        .padding(10)
        .background(.regularMaterial)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.red.opacity(0.35), lineWidth: 1)
        )
        .cornerRadius(8)
    }
}

private extension TurnStatus {
    var displayName: String {
        switch self {
        case .notStarted:
            return "未开始"
        case .inProgress:
            return "进行中"
        case .completed:
            return "已完成"
        case .failed:
            return "失败"
        case .interrupted:
            return "已停止"
        case let .unknown(value):
            return value
        }
    }
}

private extension ItemStatus {
    var displayName: String {
        switch self {
        case .pending:
            return "等待中"
        case .inProgress:
            return "进行中"
        case .completed:
            return "已完成"
        case .failed:
            return "失败"
        case .declined:
            return "已拒绝"
        case let .unknown(value):
            return value
        }
    }
}

private extension RemoteItemType {
    var displayName: String {
        switch self {
        case .userMessage:
            return "用户消息"
        case .agentMessage:
            return "助手消息"
        case .reasoning:
            return "思考"
        case .plan:
            return "计划"
        case .commandExecution:
            return "命令执行"
        case .fileChange:
            return "文件变更"
        case .toolCall:
            return "工具调用"
        case let .unknown(value):
            return value
        }
    }

    var systemImage: String {
        switch self {
        case .userMessage:
            return "person"
        case .agentMessage:
            return "sparkles"
        case .reasoning:
            return "brain"
        case .plan:
            return "list.bullet.clipboard"
        case .commandExecution:
            return "terminal"
        case .fileChange:
            return "doc.badge.gearshape"
        case .toolCall:
            return "wrench.and.screwdriver"
        case .unknown(_):
            return "questionmark"
        }
    }

    var tint: Color {
        switch self {
        case .userMessage:
            return .blue
        case .agentMessage:
            return .accentColor
        case .reasoning:
            return .purple
        case .plan:
            return .orange
        case .commandExecution:
            return .green
        case .fileChange:
            return .teal
        case .toolCall:
            return .indigo
        case .unknown(_):
            return .secondary
        }
    }
}

private extension String {
    var displayName: String {
        switch lowercased() {
        case "accept", "approve", "allow":
            return "允许"
        case "decline", "deny", "reject":
            return "拒绝"
        case "cancel":
            return "取消"
        default:
            return self
        }
    }
}

import RemoteCodexCore
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

struct ThreadDetailView: View {
    @ObservedObject var store: RemoteAppStore
    @Binding var messageDraft: String
    @State private var isSending = false
    @State private var isStopping = false
    @State private var isPreparingAttachment = false
    @State private var selectedPhotoItems: [PhotosPickerItem] = []
    @State private var attachments: [RemoteAttachment] = []
    @State private var attachmentErrorMessage: String?

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
                attachments: $attachments,
                photoItems: $selectedPhotoItems,
                isSending: isSending,
                isPreparingAttachment: isPreparingAttachment,
                isEnabled: store.currentThread != nil && store.connectionPhase == .online,
                send: sendMessage,
                importFiles: importFiles
            )
            .background(.regularMaterial)
        }
        .onChange(of: selectedPhotoItems) { items in
            guard !items.isEmpty else { return }
            Task {
                await importPhotos(items)
            }
        }
        .alert("附件无法添加", isPresented: Binding(
            get: { attachmentErrorMessage != nil },
            set: { isPresented in
                if !isPresented {
                    attachmentErrorMessage = nil
                }
            }
        )) {
            Button("确定", role: .cancel) {}
        } message: {
            Text(attachmentErrorMessage ?? "附件读取失败")
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
        let outgoingAttachments = attachments
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !outgoingAttachments.isEmpty else {
            return
        }

        isSending = true
        Task {
            let result = await store.sendTurn(text: text, attachments: outgoingAttachments)
            if result != nil {
                messageDraft = ""
                attachments.removeAll()
                selectedPhotoItems.removeAll()
            }
            isSending = false
        }
    }

    private func importPhotos(_ items: [PhotosPickerItem]) async {
        selectedPhotoItems.removeAll()
        isPreparingAttachment = true
        defer { isPreparingAttachment = false }

        for item in items {
            guard attachments.count < AttachmentRules.maximumCount else {
                attachmentErrorMessage = AttachmentRules.maximumCountMessage
                return
            }

            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    throw AttachmentImportError.unreadable
                }
                let contentType = item.supportedContentTypes.first ?? .jpeg
                attachments.append(
                    try AttachmentRules.makeDataAttachment(
                        data: data,
                        name: AttachmentRules.photoName(for: contentType),
                        contentType: contentType,
                        kind: .image
                    )
                )
            } catch {
                attachmentErrorMessage = error.localizedDescription
                return
            }
        }
    }

    private func importFiles(_ result: Result<[URL], Error>) {
        switch result {
        case let .failure(error):
            attachmentErrorMessage = error.localizedDescription
        case let .success(urls):
            guard !urls.isEmpty else { return }
            Task {
                isPreparingAttachment = true
                defer { isPreparingAttachment = false }

                for url in urls {
                    guard attachments.count < AttachmentRules.maximumCount else {
                        attachmentErrorMessage = AttachmentRules.maximumCountMessage
                        return
                    }

                    do {
                        attachments.append(try AttachmentRules.makeFileAttachment(from: url))
                    } catch {
                        attachmentErrorMessage = error.localizedDescription
                        return
                    }
                }
            }
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
    @Binding var attachments: [RemoteAttachment]
    @Binding var photoItems: [PhotosPickerItem]
    @State private var showingFileImporter = false
    let isSending: Bool
    let isPreparingAttachment: Bool
    let isEnabled: Bool
    let send: () -> Void
    let importFiles: (Result<[URL], Error>) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(attachments, id: \.id) { attachment in
                            AttachmentChipView(
                                attachment: attachment,
                                remove: {
                                    attachments.removeAll { $0.id == attachment.id }
                                }
                            )
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }

            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(
                    selection: $photoItems,
                    maxSelectionCount: max(1, AttachmentRules.maximumCount - attachments.count),
                    matching: .images
                ) {
                    Image(systemName: "photo")
                }
                .accessibilityLabel("添加照片")
                .disabled(!isEnabled || isSending || isPreparingAttachment || attachments.count >= AttachmentRules.maximumCount)

                Button {
                    showingFileImporter = true
                } label: {
                    Image(systemName: "paperclip")
                }
                .accessibilityLabel("添加文件")
                .disabled(!isEnabled || isSending || isPreparingAttachment || attachments.count >= AttachmentRules.maximumCount)
                .fileImporter(
                    isPresented: $showingFileImporter,
                    allowedContentTypes: [.item],
                    allowsMultipleSelection: true,
                    onCompletion: importFiles
                )

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
                    if isSending || isPreparingAttachment {
                        ProgressView()
                            .controlSize(.small)
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                }
                .buttonStyle(.borderedProminent)
                .accessibilityLabel("发送消息")
                .disabled(
                    !isEnabled ||
                    isSending ||
                    isPreparingAttachment ||
                    (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty)
                )
            }
        }
        .padding(.horizontal)
        .padding(.vertical, 8)
    }
}

private struct AttachmentChipView: View {
    let attachment: RemoteAttachment
    let remove: () -> Void

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: attachment.systemImage)
                .foregroundColor(.accentColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(attachment.name)
                    .font(.caption)
                    .lineLimit(1)
                Text(attachment.sizeLabel)
                    .font(.caption2)
                    .foregroundColor(.secondary)
            }
            Button(action: remove) {
                Image(systemName: "xmark.circle.fill")
                    .foregroundColor(.secondary)
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("移除附件 \(attachment.name)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(7)
    }
}

private enum AttachmentRules {
    static let maximumCount = 4
    static let maximumBytes: Int64 = 10 * 1024 * 1024
    static let maximumTextCharacters = 200_000
    static let maximumCountMessage = "最多添加 4 个附件"

    static func makeDataAttachment(
        data: Data,
        name: String,
        contentType: UTType,
        kind: RemoteAttachmentKind
    ) throws -> RemoteAttachment {
        guard Int64(data.count) <= maximumBytes else {
            throw AttachmentImportError.tooLarge
        }

        let mimeType = contentType.preferredMIMEType ?? "application/octet-stream"
        return RemoteAttachment(
            id: UUID().uuidString,
            name: name,
            mimeType: mimeType,
            size: Int64(data.count),
            kind: kind,
            dataURL: "data:\(mimeType);base64,\(data.base64EncodedString())"
        )
    }

    static func makeFileAttachment(from url: URL) throws -> RemoteAttachment {
        let didAccess = url.startAccessingSecurityScopedResource()
        defer {
            if didAccess {
                url.stopAccessingSecurityScopedResource()
            }
        }

        let values = try url.resourceValues(forKeys: [.contentTypeKey, .fileSizeKey])
        let contentType = values.contentType ?? .data
        if let fileSize = values.fileSize, Int64(fileSize) > maximumBytes {
            throw AttachmentImportError.tooLarge
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        let name = url.lastPathComponent.isEmpty ? "附件" : url.lastPathComponent
        let mimeType = contentType.preferredMIMEType ?? "application/octet-stream"

        if contentType.conforms(to: .image) {
            return try makeDataAttachment(data: data, name: name, contentType: contentType, kind: .image)
        }
        if contentType.conforms(to: .audio) {
            return try makeDataAttachment(data: data, name: name, contentType: contentType, kind: .audio)
        }

        guard Int64(data.count) <= maximumBytes else {
            throw AttachmentImportError.tooLarge
        }
        let text = String(data: data, encoding: .utf8).map { String($0.prefix(maximumTextCharacters)) }
        return RemoteAttachment(
            id: UUID().uuidString,
            name: name,
            mimeType: mimeType,
            size: Int64(data.count),
            kind: .file,
            text: text
        )
    }

    static func photoName(for contentType: UTType) -> String {
        let extensionName = contentType.preferredFilenameExtension ?? "jpg"
        return "照片.\(extensionName)"
    }
}

private enum AttachmentImportError: Error, LocalizedError {
    case unreadable
    case tooLarge

    var errorDescription: String? {
        switch self {
        case .unreadable:
            return "无法读取所选附件"
        case .tooLarge:
            return "单个附件不能超过 10 MB"
        }
    }
}

private extension RemoteAttachment {
    var systemImage: String {
        switch kind {
        case .image:
            return "photo"
        case .audio:
            return "waveform"
        case .file, .unknown(_):
            return "doc"
        }
    }

    var sizeLabel: String {
        ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
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

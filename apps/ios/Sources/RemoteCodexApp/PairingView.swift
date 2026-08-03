import RemoteCodexCore
import SwiftUI

struct PairingView: View {
    @ObservedObject var environment: AppEnvironment
    @State private var serverURL = ""
    @State private var pairingCode = ""
    @State private var deviceName = "iPhone"
    @State private var isPairing = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Bridge WebSocket 地址", text: $serverURL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled(true)
                        .keyboardType(.URL)

                    TextField("6 位配对码", text: $pairingCode)
                        .keyboardType(.numberPad)
                        .onChange(of: pairingCode) { value in
                            pairingCode = String(value.filter { $0.isNumber }.prefix(6))
                        }

                    TextField("设备名称", text: $deviceName)
                        .textInputAutocapitalization(.words)
                } header: {
                    Label("连接电脑", systemImage: "link")
                } footer: {
                    Text("配对码由电脑端托盘菜单生成")
                }

                Section {
                    Button {
                        pair()
                    } label: {
                        HStack {
                            Spacer()
                            if isPairing {
                                ProgressView()
                            } else {
                                Label("配对并连接", systemImage: "person.badge.key")
                            }
                            Spacer()
                        }
                    }
                    .disabled(
                        isPairing ||
                        pairingCode.count != 6 ||
                        serverURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ||
                        deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )
                }

                if let errorMessage {
                    Section {
                        Label(errorMessage, systemImage: "exclamationmark.triangle")
                            .foregroundColor(.red)
                            .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle("Codex Remote")
            .onAppear {
                if serverURL.isEmpty {
                    serverURL = environment.endpointText
                }
            }
        }
    }

    private func pair() {
        errorMessage = nil
        isPairing = true
        let code = pairingCode
        let name = deviceName
        let url = serverURL
        Task { @MainActor in
            defer { isPairing = false }
            do {
                _ = try await environment.pair(code: code, name: name, serverURL: url)
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

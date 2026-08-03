# 原生 Swift 基础

`Package.swift` 提供 iOS 16.3 的 Swift Package 入口：`RemoteCodexCore` 的协议和状态层保持 Foundation 纯 Swift，Apple 平台的 Store 额外使用 Combine 提供 SwiftUI 观察能力；`RemoteCodexApp` 通过 `AppEnvironment` 持有 `RemoteAppStore` 并在启动时尝试连接。测试通过源码路径读取 `packages/protocol-mock/fixtures`，迁移到 Xcode 或 CI 复制资源时保留该目录关系，或按测试文件注释调整加载器。

`RemoteProtocol` 会保留 event envelope、已知事件参数和 request/response envelope 的未知字段；带附件的 `turn.start` 只作为请求解码，不进入可持久化的 `RemoteState`。

`RemoteWebSocketClient` 位于 `RemoteCodexCore/Transport`：它封装 URLSession WebSocket、请求超时和待处理请求失败，连接打开后负责 `events.resume`、序号排序去重及合并 `events.ack`。设备 token 只通过 endpoint 鉴权入口传入，Keychain 仍由后续安全层负责；WebSocket、配对和完整 SwiftUI 页面继续分阶段接入。

`RemoteAppStore` 位于 `RemoteCodexCore/Store`：它是 `@MainActor` 的 SwiftUI 可观察状态入口，持有 `RemoteState`，把 `RemoteWebSocketClient` 的连接回调和事件交给 `RemoteReducer`，并暴露 `loadThreads`、`loadThread`、`createThread`、`sendTurn`、`interruptCurrentTurn` 和 `resolveApproval` 等 UI 动作。请求响应会先解码为 Swift 模型，再合并到状态；请求或解码失败统一保留在 `RemoteState.lastError`，可通过 `clearError()` 清除。`thread.read` 支持 Bridge 的 `{ loading: true }` 后台加载确认，`turn.start` 失败重试会复用同一 `clientRequestId`。Store 的 `clientFactory` 可注入使用 fake socket 的 `RemoteWebSocketClient`，测试无需真实网络。

`RemoteCodexApp` 当前使用 `NavigationSplitView` 呈现第一版可用界面：侧栏显示连接状态、刷新/新建/加载更多线程，详情页显示线程元信息、审批卡片、回合时间线、停止按钮和消息输入框。配对、Keychain、附件选择和更完整的移动端布局仍留给后续阶段。

没有本地 Mac 时，使用 `.github/workflows/ios-swift.yml` 在 GitHub Actions 的 macOS runner 上验证 Swift：workflow 会启动 `packages/protocol-mock`，编译 `RemoteCodexApp`、编译 `RemoteCodexCore` XCTest，并在可用 iPhone 模拟器上运行单测和真实 WebSocket 纵向链路测试。本地未设置 `REMOTE_CODEX_E2E=1` 时，端到端测试会跳过；Windows 仍可继续跑 `pnpm typecheck` 和 `pnpm test` 做协议、Web、Bridge 侧回归。

`RemoteCodexApp` 已接入第一版 SwiftUI 页面：侧栏展示连接状态、刷新按钮和线程列表；详情页按回合和 item 展示实时时间线，底部提供消息输入、发送和停止操作，当前线程的审批请求提供可用决策按钮，错误提示可直接清除。连接成功后页面自动加载线程，默认 endpoint 仍为 `ws://127.0.0.1:18787/ws`；页面只使用 iOS 16 / Swift 5.7 可用的 SwiftUI API，未加入 Keychain 或配对流程。

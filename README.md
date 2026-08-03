# Codex Remote

Codex Remote 是面向 Windows Codex Desktop 的远程客户端。阶段 4 使用外置 Native Host 接管 Desktop 原有的 stdio 启动入口，把 Desktop 和手机 Bridge 接到同一个真实 `codex app-server`；模型请求、工具执行及文件访问仍发生在电脑上。

阶段 0～3 与阶段 6 已完成，阶段 4～5 的主要远程链路和安全基线已经落地；阶段 7 正在迁移正式手机 UI 到原生 SwiftUI：

1. 当前 Codex Desktop 版本和协议勘探。
2. 共享远程协议、状态机、脱敏夹具与故障模拟器。
3. 响应式 Web UI，以及 Chromium、WebKit 双引擎测试。
4. Windows Bridge、真实 Codex、命名管道、托盘、配对、DPAPI 与设备撤销。
5. Native Host 已完成本机编译、外部安装和 Desktop 重启验证；Cloudflare Tunnel HTTPS/WSS 已接入当前同一个 app-server，Tailscale 降为诊断回退。
6. Web UI 保留为 Windows 调试器、协议模拟器前端和降级入口；正式 iPhone UI 改用 SwiftUI，不嵌入 WKWebView 业务页面。

详细范围见 `IMPLEMENTATION_PLAN.md`，逐阶段证据位于 `docs/`。

## 环境要求

- Windows 10/11。
- Node.js 22 或更高版本。
- pnpm 9.15.9。
- 已安装并能正常使用 Codex Desktop。
- 阶段 4 默认使用电脑端 `cloudflared`，手机不需要安装或开启 VPN；Tailscale 仅作为回退。
- Native Host 需要 .NET 8 SDK；没有系统 SDK 时可用项目脚本安装到 `work/dotnet-sdk/`，无需管理员权限。
- 阶段 0 生成的安全原生副本：`work/stage0/desktop-native/codex.exe`；也可用 `CODEX_EXECUTABLE` 指定已验证副本。

Bridge 不会修改 WindowsApps、Codex Desktop 安装目录或 `~/.codex/config.toml`。

## 安装与验证

```powershell
cd E:\myproject\codex-remote
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

## 使用模拟器开发 Web UI

```powershell
pnpm dev:mock
pnpm dev:web
```

- Web UI：`http://<电脑局域网 IP>:15173/`
- 模拟 WebSocket：`ws://<电脑局域网 IP>:18787/ws`

模拟器支持历史、新建、继续、流式推理、命令、审批、拒绝失败、停止、事件重放，以及暂停、乱序、重复和丢包注入。

## 隔离协议调试：独立 app-server

以下方式只用于隔离协议测试，不具备 Desktop 当前会话实时同步能力；正常阶段 4 启动不会使用它：

```powershell
$env:CODEX_EXECUTABLE='E:\myproject\codex-remote\work\stage0\desktop-native\codex.exe'
$env:CODEX_REMOTE_ALLOW_INDEPENDENT_APP_SERVER='1'
$env:CODEX_REMOTE_TRAY='1'
pnpm start:bridge
```

然后在同一局域网的 iPhone 打开：

```text
http://<电脑局域网 IP>:18787/
```

默认端口为 `18787`。Bridge 会同时提供生产 Web 静态文件、`/ws`、`/healthz` 和 `/readyz`。

## 阶段 4：同实例 Native Host 与 Cloudflare Tunnel

阶段 4 不进行路由器端口映射，也不把 `18787` 直接暴露到公网。Windows EXE 默认在本机编译；GitHub Windows 工作流只作为可选 CI 复核。首次没有 .NET 8 SDK 时运行安装脚本，然后编译并执行同实例集成验证：

```powershell
cd E:\myproject\codex-remote
pnpm install:dotnet-sdk
pnpm build:native-host
pnpm verify:native-host
```

当前本机产物位于 `artifacts/native-host-win-x64/`，`.exe` 与 `.exe.sha256` 必须保持在同一目录。当前验证产物 SHA-256 为 `CFEB0FFC02A7F27FD0B38F856624F580FD6CE7BE81D6F440A3B12C6EFC4CBE8A`。

安装必须由 Codex Desktop 之外的 PowerShell 完成。下面的命令会打开独立 Windows PowerShell 窗口；它只等待你主动完全退出 Codex，不会强制结束进程，安装成功后会自动重新打开应用：

```powershell
pnpm install:native-host:external
```

安装脚本会核对 EXE SHA-256，并且只接受 Desktop `26.727.6591.0` 和阶段 0 已验证的原生副本，不修改 WindowsApps、ASAR 或 `config.toml`。重新启动后检查 Native Host：

```powershell
pnpm verify:native-host
```

首次准备或 Web 代码更新后构建一次：

```powershell
pnpm build
```

首次配置 Cloudflare Tunnel 和 DNS：

```powershell
pnpm setup:cloudflare
```

后台启动、检查和停止：

```powershell
pnpm launch:cloudflare
pnpm verify:cloudflare
pnpm stop:cloudflare
```

默认公开地址为 `https://codex-remote.bltbbbego.store/`。Bridge 只监听 `127.0.0.1:18791`，`cloudflared` 主动建立出站 Tunnel，不开放路由器或 Windows 入站端口。连接仍强制使用项目自己的设备配对令牌；HTTPS/WSS 下令牌通过 WebSocket 子协议发送，不进入 URL 查询参数。

Tailscale 入口 `pnpm start:stage4` 暂时保留为诊断回退。它使用独立端口和设备库，不是默认手机入口。

Bridge 默认禁止启动独立 app-server。未发现 Native Host 时会直接失败，从结构上避免再次出现“手机回合成功写入 rollout，但 Desktop 当前 UI 没有这条消息”的分叉。

Bridge 启动后会预热首屏历史和最近会话，并对首屏请求做短时缓存与并发去重。Web 端长期只缓存不含消息正文和设备令牌的会话摘要；当前标签页另在 `sessionStorage` 中保存最多 12 个回合、最大 1.5 MB 的临时会话快照。Safari 回收页面进程后会先恢复该快照并在后台读取真实最新状态；只有从未打开过且没有快照的会话才显示骨架屏和“载入会话”状态。

移动端执行时间线与 Desktop 保持相同的两态交互：最终回复出现前，过程回复、思考与工具按事件顺序平铺；第一段最终回复出现后，完整过程折叠为带总耗时的单行摘要，最终回复在其下方独立增长。自动跟随只滚动会话容器，不滚动 Safari 页面视口。

iOS Safari 进入后台后可能暂停 WebSocket。页面返回前台时会快速重建连接并按事件序号补齐内容，但保留当前会话画面，不再重复显示骨架或读取已经加载的线程；页面进程被系统回收时则从当前标签页快照立即恢复。页面宽度使用 `visualViewport` 的实际可见尺寸，并为顶部状态、会话区和输入框保留 34px 右侧保护距离，避免 Safari 站点缩放和浏览器栏变化裁切内容。

阶段 4 启动入口同时启用以下边界：

- WebSocket 与配对 API 仅接受同源页面或明确配置的开发来源。
- 配对失败限制为每个来源地址 5 分钟内最多 8 次。
- 手机 Wi-Fi、蜂窝网络切换和从后台返回时主动探测并恢复连接。
- 默认 Bridge 只监听回环地址；Cloudflare 转发过来的请求不能调用生成配对码、设备管理或关机接口。

## 手机配对

1. 在电脑托盘菜单选择“生成手机配对码”。
2. 手机页面断线时点击“配对”。
3. 输入 6 位配对码和设备名称。
4. 手机保存设备令牌；电脑端设备密钥使用当前 Windows 用户的 DPAPI 加密保存。
5. 可从命名管道或本机管理接口撤销设备，撤销后现有连接会被立即关闭。

未配对任何设备时，`optional` 模式允许局域网首次调试；完成首台设备配对后，无令牌连接将被拒绝。可通过 `CODEX_REMOTE_AUTH_MODE=required` 从首次启动起强制配对。

## 常用配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `CODEX_EXECUTABLE` | 阶段 0 安全副本 | 指定已验证的 Codex 原生文件 |
| `CODEX_APP_SERVER_URL` | 空 | 仅开发调试时显式附加 app-server WebSocket |
| `CODEX_APP_SERVER_TOKEN` | 空 | 显式附加时使用的 Bearer 能力令牌 |
| `CODEX_REMOTE_NATIVE_HOST_PIPE` | `\\.\pipe\codex-remote-native-v1` | 覆盖 Native Host 当前用户发现管道 |
| `CODEX_REMOTE_ALLOW_INDEPENDENT_APP_SERVER` | `0` | 仅隔离协议测试时设为 `1`；正常远程必须保持关闭 |
| `CODEX_REMOTE_HOST` | `0.0.0.0` | Bridge 监听地址 |
| `CODEX_REMOTE_PORT` | `18787` | Bridge HTTP/WebSocket 端口 |
| `CODEX_REMOTE_AUTH_MODE` | `optional` | `off`、`optional` 或 `required` |
| `CODEX_REMOTE_DEVICE_STORE` | `%LOCALAPPDATA%\\CodexRemote\\devices.dat` | 覆盖 DPAPI 设备存储位置，主要用于隔离测试 |
| `CODEX_REMOTE_WORKSPACES` | Bridge 项目根目录 | 以分号分隔电脑明确暴露的绝对工作区；手机只能从此列表或历史会话工作区创建新会话 |
| `CODEX_REMOTE_TRAY` | `0` | 设为 `1` 启动通知区域托盘 |
| `CODEX_REMOTE_PUBLIC_URL` | 空 | 托盘打开的公网 HTTPS 地址；敏感管理请求仍走本机回环 |
| `CODEX_REMOTE_EXPECTED_VERSION` | `0.146.0-alpha.9.2` | 允许启动的精确协议版本 |
| `CODEX_REMOTE_ALLOW_VERSION_MISMATCH` | `0` | 仅完成新版本人工兼容测试后设为 `1` |

## 当前边界

- 阶段 3 已证明独立 Bridge 可以操作真实 Codex，但不能证明 Desktop 当前内存会话同步。
- 阶段 4 将同实例 Native Host 提前为硬性验收条件，并使用 Cloudflare Tunnel 提供无需手机 VPN 的 HTTPS/WSS 入口；Tailscale 只保留诊断回退。
- Cloudflare 会终止公网 TLS；当前设备令牌、防重放事件序号和回环隔离不等于应用层端到端加密。只有需要 Cloudflare 也无法读取会话内容时，才继续实现自建 Relay 或密文帧协议。
- 完整 Web 交互一致性属于阶段 6；阶段 7 开始建立原生 SwiftUI 客户端，版本门禁和兼容性加固并入阶段 8。
- 阶段 7～8 完成 SwiftUI 客户端、协议一致性、性能、兼容性和 CI；GitHub Actions IPA 打包及 TrollStore 真机验收统一放在最后的阶段 9。阶段 7 当前已完成协议、WebSocket、配对、Keychain 和基础线程页面，后续继续补齐附件、工作区选择、性能与真机验收。原生迁移细节见 `docs/native-ios-plan.md`。

`work/`、测试结果和构建目录均为本机可再生产物，不进入版本库。

## 阶段 7：原生 Swift 基础

第一批 SwiftUI 基础位于 `apps/ios`，以 iOS 16.3 Swift Package 承载纯 Swift 协议模型、`RemoteReducer`、夹具 XCTest 和最小 RootView。跨语言 schema、夹具清单与无第三方依赖的静态校验脚本位于 `packages/protocol-schema`；Schema 已开始约束已知 request/event params，同时保留 unknown 分支。Swift `RemoteState` 不保存附件正文，带附件的 `turn.start` 仅在请求解码阶段验证；当前 Web、Bridge 和协议模拟器实现保持不变。

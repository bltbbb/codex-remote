# 阶段 1：远程协议与模拟器完成报告

完成日期：2026-08-02

## 实现范围

- `packages/protocol` 定义请求、响应、事件、错误、线程、回合、消息、推理、计划、终端、文件修改、工具和审批类型。
- `codec.ts` 负责线协议解析与请求生成；非安全 HTTP 上通过 `getRandomValues` 兼容缺失的 `crypto.randomUUID`。
- `normalize.ts` 将 Codex app-server v2 消息规范化为稳定远程事件。
- `state.ts` 实现事件去重、倒序保护、运行中展开、完成后自动折叠和手动展开保持。
- `protocol-mock` 提供确定性的历史、新建、继续、流式输出、命令、审批、拒绝失败、停止和断线重放。
- `ProtocolFaultInjector` 支持暂停、释放、下一事件丢包、重复及相邻事件乱序。
- `REMOTE_CODEX_MOCK_STEP_MS` 控制模拟时间，可设为 `0` 加速测试。
- `fixtures/` 保存不含真实账号、路径和会话内容的脱敏协议样例。

## 架构调整

最初计划写有 Rust `remote-protocol` crate。阶段 0 证实共享协议可直接通过 app-server WebSocket 完成，不需要修改 Native Codex；当前机器也没有 Rust 工具链。因此共享协议实现为 TypeScript 包，供 Web、模拟器和 Windows Bridge 同时使用。阶段 4 提前的同实例接入由外置 .NET Native Host 完成 stdio/WebSocket 适配，仍不需要维护第二套 Rust 协议实现；只有未来 `CODEX_CLI_PATH` 入口失效时才评估 Native/MSIX 备选方案。

## 协议保证

- 每个客户端请求都有唯一 ID，并收到成功或结构化错误响应。
- 每个远程事件都有单调递增序号和唯一事件 ID。
- 状态归约器同时按事件 ID 和序号拒绝重复、倒序事件。
- 客户端在断线重连后调用 `events.resume`，按序合并实时队列与重放结果。
- 客户端批量发送 `events.ack`，Bridge 保存各客户端最后确认序号。
- 服务端序号重置时，客户端清空旧序号状态并重新获取完整快照。

## 验证证据

运行：

```powershell
pnpm --filter @codex-remote/protocol test
pnpm --filter @codex-remote/protocol-mock test
```

覆盖内容：

- ID 安全上下文回退。
- 自动折叠、手动展开和事件去重。
- 搜索快照替换与分页追加。
- 历史列表、完整流式回合、审批拒绝失败、停止与事件重放。
- 暂停、丢包、重复和乱序故障注入。

阶段 1 验收结论：通过。

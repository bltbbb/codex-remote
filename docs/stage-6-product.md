# 阶段 6：产品完善与完整交互一致性

## 已落地的产品契约

- 助手消息、过程消息和计划使用安全的 Markdown 渲染器；代码围栏生成独立代码块，链接只允许 `http`、`https` 和 `mailto` 协议。
- 统一差异视图解析 unified diff，显示文件头、旧/新行号、增删行和统计；超长命令、工具和文件元数据输出按上限折叠。
- 回形针按钮打开浏览器文件选择器，图片和音频按 data URL 发送，文本类文件作为受限上下文片段发送；单文件与总大小均有上限。
- `workspace.list` 返回电脑端配置和历史会话合并后的白名单；`thread.create` 在 Bridge 再次校验，手机不再输入任意系统路径。
- 用户向上阅读时暂停自动跟随，实时事件累积未读计数，并提供“回到底部”按钮。
- 超过 80 个回合时，Timeline 只渲染带预估占位高度的可视窗口和前后缓冲区，避免一次挂载全部历史节点。
- `turn.start` 使用 `clientRequestId` 做 Bridge 端幂等缓存；同一设备重复提交返回同一回合，内容不一致时返回冲突错误，失败请求允许安全重试。

## 源代码证据

| 要求 | 主要证据 |
| --- | --- |
| Markdown/代码块 | `apps/web/src/components/Markdown.tsx`、`apps/web/src/components/Timeline.tsx` |
| 差异、行号和大输出 | `apps/web/src/components/DiffView.tsx`、`apps/web/src/components/Timeline.tsx`、`packages/protocol/src/state.ts` |
| 附件 | `apps/web/src/components/Composer.tsx`、`packages/protocol/src/types.ts`、`packages/windows-bridge/src/bridge-engine.ts` |
| 工作区白名单 | `apps/web/src/components/WorkspacePicker.tsx`、`packages/windows-bridge/src/bridge-engine.ts`、`packages/windows-bridge/src/server.ts` |
| 未读与回到底部 | `apps/web/src/App.tsx`、`apps/web/src/styles.css` |
| 长历史窗口化 | `apps/web/src/components/Timeline.tsx`、`apps/web/src/styles.css` |
| 幂等和重连 | `apps/web/src/App.tsx`、`packages/windows-bridge/src/bridge-engine.ts`、`apps/web/src/client.ts` |
| 协议夹具/回归 | `packages/protocol-mock/fixtures/`、`packages/protocol-mock/test/`、`apps/web/test/`、`apps/web/e2e/remote-ui.spec.ts` |

## 协议夹具

`packages/protocol-mock/fixtures/` 增加了回合差异、失败回合和图片/文本附件请求夹具；模拟器同时覆盖工作区拒绝、差异事件和重复提交场景。

## 使用边界

- 附件内容只在当前请求中传输，不写入浏览器会话快照，也不由 Bridge 长期保存。
- 文件附件不会伪造 Codex 不支持的文件输入类型；文本文件被明确标注为上下文片段，其他文件保留为二进制附件提示。
- iOS 原生外壳、IPA 打包、Store 更新门禁和真机验收不属于阶段 6，仍按阶段 7～9 的顺序执行。

## 阶段 6 静态验收清单

- [x] 浏览器与 Safari 的 Markdown、代码、差异、附件、工作区选择和未读交互回归。
- [x] 工具长输出、失败、拒绝、停止、重试和断线恢复回归。
- [x] 长历史滚动位置、回到底部和重连快照回归。
- [x] `turn.start` 幂等与冲突错误回归。

## 阶段 6 运行时验收记录

- `pnpm typecheck`：4 个工作区通过。
- `pnpm test`：协议 9、Bridge 16、模拟器 10、Web 14 项测试通过。
- `pnpm build`：协议、模拟器、Bridge 和 Web 生产构建通过。
- Chromium `remote-ui.spec.ts`：3 项通过；桌面 WebKit：3 项通过。
- Mobile WebKit `mobile-safari.spec.ts`：8 项通过，覆盖视口、断网、后台返回、页面进程回收、新建、停止、审批拒绝和自动跟随。
- Mobile WebKit 模拟器隔离连接保持单调事件序号，后台恢复不重复发送 `thread.read`。

上述运行时验收使用不改动生产数据的协议模拟器和隔离浏览器环境完成；真实 iPhone 与 IPA 验收仍属于后续阶段。

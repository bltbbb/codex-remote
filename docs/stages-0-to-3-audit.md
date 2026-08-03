# 阶段 0～3 完成审计

审计日期：2026-08-02

本审计按 `IMPLEMENTATION_PLAN.md` 的阶段 0～3 逐条检查实现、运行结果和可复现证据，不以“文件存在”代替行为验证。

| 阶段 | 要求 | 权威证据 | 结论 |
| --- | --- | --- | --- |
| 0 | Desktop 包、native、源码标签和提交准确映射 | `stage-0-compatibility.md`；native `--version`；生成的 701 TS 与 349 Schema | 通过 |
| 0 | app-server 启动、事件类型和多客户端能力 | 双客户端真实持久线程、同一回合增量与完成事件实测 | 通过 |
| 1 | 共享请求/响应/事件协议与规范化 | `packages/protocol/src`；类型检查 | 通过 |
| 1 | 历史、新建、继续、流式、停止、审批、失败、断线 | MockEngine 测试与脱敏夹具 | 通过 |
| 1 | 时间加速、暂停、乱序、重复、丢包 | `stepDelayMs`、`ProtocolFaultInjector` 及测试 | 通过 |
| 2 | 会话侧栏、项目分组、搜索、分页 | `ThreadSidebar.tsx`；真实历史浏览器验收 | 通过 |
| 2 | 消息、推理、计划、工具、终端、差异 | `Timeline.tsx`；组件测试与 E2E | 通过 |
| 2 | 输入、停止、审批、失败重试、自动折叠 | UI 组件、状态归约器、模拟主流程 | 通过 |
| 2 | Chromium 与 WebKit | Playwright 4/4 通过 | 通过 |
| 2 | iPhone 14 Pro Max 断点 | 430×932 双引擎测试，无横向溢出、侧栏可开合 | 通过 |
| 3 | 命名管道和实例发现 | 真实管道状态查询返回 PID、版本与 app-server URL | 通过 |
| 3 | 快照、广播、序号、确认、重放 | BridgeEngine、EventJournal、RemoteClient 与测试 | 通过 |
| 3 | 托盘、配对、撤销和 DPAPI | Windows PowerShell 5 启动实测；隔离 Bridge 完成配对、密文、鉴权、撤销及旧令牌 401；DPAPI 真实往返 | 通过 |
| 3 | 版本不匹配保护 | 用期望版本 `0.0.0` 启动，被明确拒绝 | 通过 |
| 3 | Web 切换真实 Bridge | 生产 Web 从 `:18787` 读取真实 `$CODEX_HOME` 历史 | 通过 |
| 3 | 历史、新建、继续、停止、审批作用于同一 app-server | `verify-real-bridge.ts` 完整真实验收及线程清理 | 通过 |

## 最终自动化门槛

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

真实环境门槛：

```powershell
pnpm start:bridge
pnpm verify:real
```

## 审计结论

阶段 0～3 的计划条目均已有实现与直接证据。后续顺序已调整为：阶段 4 使用安全公网入口完成同实例与 iOS 16.3 Safari 联调，阶段 5 完成公网安全基线，阶段 6 完成交互一致性，阶段 7 建立原生 SwiftUI 客户端基础，阶段 8 完成功能对齐、性能、兼容性与 CI，最后在阶段 9 打包 TrollStore IPA 并完成真机验收。

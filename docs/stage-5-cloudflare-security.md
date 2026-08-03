# 阶段 5：Cloudflare 安全加固记录

## 当前结论

个人使用场景继续采用 Cloudflare Tunnel，不建设自有公网 Relay。Bridge 只监听 `127.0.0.1:18791`，Cloudflare 负责公网 HTTPS/WSS 转发，应用层设备令牌负责真正的配对和授权。

Cloudflare 会终止 TLS，因此 Cloudflare 网络侧理论上可以看到未加密的应用数据。当前方案适合个人使用；如果后续要求 Cloudflare 也无法读取会话内容，再单独实现应用层端到端加密或只转发密文的自建 Relay。

## 已完成的安全边界

- Bridge 使用强制设备配对，未配对 WebSocket 返回 `401`。
- 配对码只在电脑本机入口生成，公网调用返回 `403`。
- 设备令牌使用随机 256 位令牌，通过 WebSocket 子协议传递；非安全 HTTP 仅保留 Tailscale 兼容查询参数。
- 设备记录使用 Windows DPAPI 加密保存。
- 设备可以在电脑本机列出、撤销，撤销后立即关闭对应 WebSocket。
- 配对失败按客户端地址限速，5 分钟窗口最多允许 8 次失败尝试。
- Cloudflare 转发的客户端地址只有在实际连接来自回环源站时才可信。
- 公网不能调用设备管理、配对码生成或 Bridge 关闭接口。
- 跨站 HTTP 和 WebSocket 来源被拒绝。
- Web 响应包含 CSP、HSTS（仅 HTTPS）、禁止 iframe、禁止跨域资源策略、Referrer-Policy、Permissions-Policy 和类型嗅探保护。
- 公网健康检查不再暴露内部事件序号；本机健康检查仍保留序号用于诊断。
- 事件恢复有大小上限，超过上限时客户端进入完整状态同步，不把大型历史事件一次性塞进移动端。

## 验证命令

```powershell
pnpm verify:stage4
pnpm verify:cloudflare
pnpm typecheck
pnpm test
pnpm build
```

`verify:cloudflare` 会验证公网 HTTPS、HSTS、公网健康检查信息隔离、强制配对、配对完成、WSS 子协议令牌和公网管理接口拒绝。

## 暂未启用的增强项

- Cloudflare Access：个人单用户场景暂不叠加账号登录，避免破坏 iOS 16.3 Safari 的 WebSocket 配对流程。
- 应用层端到端加密：只有在需要 Cloudflare 无法读取 Codex 内容时实施。
- 设备令牌主动轮换：当前通过本机撤销和重新配对完成失效控制；若未来增加多设备或长期部署，再加入无感轮换。

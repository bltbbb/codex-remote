# 阶段 0：Codex 版本与协议兼容性报告

## 结论

当前环境可以基于 Codex 官方 app-server WebSocket 协议完成阶段 1～3，无需先修改 OpenAI 私有远程控制协议。

已验证能力：

- 读取真实历史会话。
- 使用两个 WebSocket 客户端同时初始化。
- 两个客户端读取同一份 `$CODEX_HOME` 历史。
- 两个客户端加入同一持久线程。
- 一个客户端发起回合后，两个客户端同时收到文本增量和完成事件。
- `thread/start`、`thread/resume`、`thread/list`、`thread/read`、`turn/start`、`turn/interrupt` 和审批请求均有正式生成的协议定义。

## 当前版本基线

| 项目 | 实测值 |
| --- | --- |
| Codex Desktop | `26.727.6591.0` |
| 包签名 | Store |
| Desktop native CLI | `0.146.0-alpha.9.2` |
| 官方源码标签 | `rust-v0.146.0-alpha.9.2` |
| 标签解析提交 | `86cc9f2177cad015befd595286d8767a650f7d13` |
| native SHA-256 | `ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F` |
| 本机 npm CLI | `0.144.1` |
| 操作系统 | Windows 10 `10.0.19045` x86_64 |

协议和 Bridge 必须以 Desktop native `0.146.0-alpha.9.2` 生成的绑定为准，不能以较旧的 npm CLI `0.144.1` 作为 Desktop 协议基线。

## 协议生成证据

从复制到项目诊断区的 Desktop native 执行：

```powershell
codex.exe app-server generate-ts --out <dir> --experimental
codex.exe app-server generate-json-schema --out <dir> --experimental
```

生成结果：

- TypeScript 类型文件：701 个。
- JSON Schema 文件：349 个。
- 包含 v2 线程、回合、工具、审批、推理、计划、远程控制和文件系统协议。

关键客户端请求：

- `initialize`
- `thread/list`
- `thread/read`
- `thread/start`
- `thread/resume`
- `thread/archive`
- `thread/delete`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- `model/list`

关键服务端事件：

- `thread/started`
- `thread/status/changed`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/reasoning/summaryTextDelta`
- `item/reasoning/summaryPartAdded`
- `item/reasoning/textDelta`
- `turn/plan/updated`
- `turn/diff/updated`
- `item/commandExecution/outputDelta`
- `item/fileChange/patchUpdated`

关键服务端审批请求：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

## WebSocket 多客户端实测

Desktop native 原生支持：

```text
app-server --listen ws://127.0.0.1:<port>
```

服务同时提供：

- `/readyz`
- `/healthz`
- 多个 WebSocket 客户端连接

第一次测试中，两个客户端都成功完成 `initialize` 和 `thread/list`，读取到相同的最新线程 ID。

第二次测试创建了一个可精确识别并在结束后删除的测试线程。客户端 A 发起回合，客户端 B 在 rollout 创建后执行 `thread/resume`。两个客户端均收到：

- `thread/started`
- `thread/status/changed`
- `turn/started` 或加入后的活动状态
- `item/started`
- `item/agentMessage/delta`
- `item/completed`
- `turn/completed`

两个客户端最终都得到文本 `REMOTE_CODEX_STAGE0_OK`，并且完成状态均为 `true`。

## 已发现的协议约束

### Ephemeral 线程不能被第二客户端恢复

`thread/start` 使用 `ephemeral: true` 时不会创建 rollout。第二客户端调用 `thread/resume` 会返回：

```text
no rollout found for thread id ...
```

因此需要多客户端加入的线程必须持久化，或者由 Bridge 在单客户端连接内进行转发。

### 第二客户端应在 rollout 创建后恢复线程

持久线程刚创建但尚未产生首个回合时，rollout 可能还不存在。可靠顺序为：

1. 客户端 A 创建线程。
2. 客户端 A 发起首个回合。
3. rollout 创建后，客户端 B 使用线程 ID 恢复。
4. 后续事件向两个已订阅客户端广播。

### Windows 不支持官方 daemon 生命周期

当前 CLI 的 `app-server daemon` 在 Windows 返回“仅支持 Unix”。Windows Bridge 不能依赖官方 daemon 管理命令。

### 当前 Desktop 使用 stdio 单端点

运行中 Desktop native 的命令行为：

```text
codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled
```

Desktop 没有使用 `--listen ws://...`，外部客户端不能直接附加到当前 stdio 连接。

阶段 3 采用两层策略：

1. 立即可用：Bridge 启动 Desktop 同版本 native 的 loopback WebSocket app-server，读取同一份 Codex 历史并执行真实任务。
2. 同实例目标：Bridge 支持附加到由桌面启动包装器暴露的 WebSocket 端点；包装器或后续 native 补丁负责让 Desktop stdio 客户端和 Bridge 共享同一 app-server。

第一层用于完成真实协议、历史、新建、继续和回合流验证；第二层用于最终实现桌面与手机对同一活动回合的零刷新同步。

## 网络观察

当前网络对部分 `chatgpt.com` 服务返回地区 403，但用户的自定义模型端点仍能完成 app-server 回合。该 403 影响官方远程控制、插件目录和遥测，不影响本项目使用本地 WebSocket app-server 和现有自定义模型提供商。

## 阶段 0 验收状态

| 验收项 | 状态 |
| --- | --- |
| 确认 Desktop 与 native 版本 | 通过 |
| 找到精确官方源码标签 | 通过 |
| 生成真实协议绑定 | 通过 |
| 读取真实历史会话 | 通过 |
| 验证 WebSocket 双客户端 | 通过 |
| 验证同一线程事件广播 | 通过 |
| 明确 Desktop stdio 附加限制 | 通过 |
| 给出阶段 3 接入决策 | 通过 |


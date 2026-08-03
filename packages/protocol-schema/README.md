# 原生协议 Schema

本目录是 TypeScript、Swift 和协议模拟器共用的第一版结构契约。`remote-protocol.schema.json` 使用带 `/v1/` 的 `$id` 和 `x-protocol-version` 标记版本；不兼容变更应新增版本文件，不覆盖旧版本。

Schema 对已知 request/event method 使用 `oneOf`、`const method` 和对应 params 定义，未知 method 仍走 unknown 分支以保持前向兼容。各 params 对象允许额外字段，Swift 模型通过 `rawFields` 保留这些字段。

`fixtures/manifest.json` 记录现有 mock 夹具的语义名称、实际 wire `kind` 和 `event.method`。其中 `turn.attachment` 是 `turn.start` 请求，`turn.plan.updated`、`tool.progress` 和 `turn.failed` 是当前协议中由 `item.upsert`、`item.delta` 和 `turn.completed(status=failed)` 表达的夹具语义。

执行 `pnpm --filter @codex-remote/protocol-schema verify` 可在不引入第三方依赖的情况下检查 schema、known method 覆盖、清单、夹具结构和生成占位文件。

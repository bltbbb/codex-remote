import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  AgentMessageItem,
  ClientRequestEnvelope,
  CommandItem,
  EventEnvelope,
  ReasoningItem,
  RemoteEvent,
  RemoteThread,
  RemoteThreadSummary,
  RemoteTurn,
  RemoteWorkspace,
  ToolCallItem,
  ServerResponseEnvelope,
} from "@codex-remote/protocol";
import { emptyTurn, fixtureThreads, summary } from "./fixtures";

export interface MockEngineOptions {
  stepDelayMs?: number;
  sequenceOffset?: number;
}

type Emit = (message: EventEnvelope | ServerResponseEnvelope) => void;

export class MockEngine {
  private sequence: number;
  private readonly history: EventEnvelope[] = [];
  private readonly threads = new Map<string, RemoteThread>(fixtureThreads.map((thread) => [thread.id, structuredClone(thread)]));
  private readonly pendingApprovals = new Map<string, { resolve: (decision: string) => void }>();
  private readonly startedTurnRequests = new Map<string, { fingerprint: string; turn: RemoteTurn }>();
  private readonly interruptedTurns = new Set<string>();
  private readonly stepDelayMs: number;

  constructor(options: MockEngineOptions = {}) {
    this.stepDelayMs = options.stepDelayMs ?? 180;
    this.sequence = options.sequenceOffset ?? 0;
  }

  private event(event: RemoteEvent): EventEnvelope {
    const envelope: EventEnvelope = {
      kind: "event",
      sequence: ++this.sequence,
      eventId: randomUUID(),
      event,
    };
    this.history.push(envelope);
    if (this.history.length > 500) this.history.shift();
    return envelope;
  }

  private response(id: string, result: unknown): ServerResponseEnvelope {
    return { kind: "response", id, ok: true, result };
  }

  private error(id: string, code: string, message: string): ServerResponseEnvelope {
    return { kind: "response", id, ok: false, error: { code, message } };
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.stepDelayMs));
  }

  connect(emit: Emit): void {
    emit(this.event({ method: "connection.status", params: { phase: "online", message: "协议模拟器已连接" } }));
  }

  async handle(request: ClientRequestEnvelope, emit: Emit): Promise<void> {
    switch (request.method) {
      case "connection.info":
        emit(this.response(request.id, { mode: "mock", version: "0.1.0", protocolVersion: 1 }));
        return;
      case "workspace.list": {
        const seen = new Set<string>();
        const workspaces: RemoteWorkspace[] = [...this.threads.values()].flatMap((thread) => {
          if (!thread.cwd || seen.has(thread.cwd.toLowerCase())) return [];
          seen.add(thread.cwd.toLowerCase());
          const name = thread.cwd.split(/[\\/]/).filter(Boolean).at(-1) || thread.cwd;
          return [{ id: `workspace:${thread.cwd.toLowerCase()}`, path: thread.cwd, name, source: "history" as const }];
        });
        emit(this.response(request.id, { workspaces }));
        return;
      }
      case "thread.list": {
        const searchTerm = typeof request.params.searchTerm === "string" ? request.params.searchTerm.toLowerCase() : "";
        const threads = [...this.threads.values()]
          .filter((thread) => !searchTerm || thread.title.toLowerCase().includes(searchTerm) || thread.preview.toLowerCase().includes(searchTerm))
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map(summary);
        emit(this.response(request.id, { threads, nextCursor: null }));
        emit(this.event({ method: "thread.list.snapshot", params: { threads, nextCursor: null, append: Boolean(request.params.cursor) } }));
        return;
      }
      case "thread.read":
      case "thread.resume": {
        const threadId = String(request.params.threadId ?? "");
        const thread = this.threads.get(threadId);
        if (!thread) {
          emit(this.error(request.id, "thread_not_found", `找不到会话 ${threadId}`));
          return;
        }
        emit(this.response(request.id, { thread }));
        emit(this.event({ method: "thread.snapshot", params: { thread: structuredClone(thread) } }));
        return;
      }
      case "thread.create": {
        const id = `thread-${randomUUID()}`;
        const cwd = String(request.params.cwd ?? "");
        const allowed = [...this.threads.values()].some((thread) => thread.cwd.toLowerCase() === cwd.toLowerCase());
        if (!allowed) {
          emit(this.error(request.id, "workspace_not_allowed", "模拟器只允许使用已暴露的历史工作区"));
          return;
        }
        const timestamp = Math.floor(Date.now() / 1000);
        const thread: RemoteThread = {
          id,
          sessionId: `session-${randomUUID()}`,
          title: "新会话",
          preview: "",
          cwd,
          modelProvider: "custom",
          createdAt: timestamp,
          updatedAt: timestamp,
          status: "idle",
          isPinned: false,
          source: "appServer",
          turnIds: [],
          turns: {},
          items: {},
        };
        this.threads.set(id, thread);
        emit(this.response(request.id, { thread }));
        emit(this.event({ method: "thread.upsert", params: { thread: summary(thread) } }));
        emit(this.event({ method: "thread.snapshot", params: { thread: structuredClone(thread) } }));
        return;
      }
      case "thread.delete": {
        const threadId = String(request.params.threadId ?? "");
        const deleted = this.threads.delete(threadId);
        emit(this.response(request.id, { threadId, deleted }));
        if (deleted) emit(this.event({ method: "thread.removed", params: { threadId } }));
        return;
      }
      case "turn.start": {
        const threadId = String(request.params.threadId ?? "");
        const input = String(request.params.text ?? "");
        const clientRequestId = String(request.params.clientRequestId ?? request.id);
        const requestKey = clientRequestId;
        const fingerprint = JSON.stringify({ threadId, input, attachments: request.params.attachments ?? null });
        const existingTurn = this.startedTurnRequests.get(requestKey);
        if (existingTurn) {
          if (existingTurn.fingerprint !== fingerprint) {
            emit(this.error(request.id, "idempotency_conflict", "相同提交标识对应了不同的消息内容"));
            return;
          }
          emit(this.response(request.id, { turn: structuredClone(existingTurn.turn), deduplicated: true }));
          return;
        }
        const thread = this.threads.get(threadId);
        if (!thread) {
          emit(this.error(request.id, "thread_not_found", `找不到会话 ${threadId}`));
          return;
        }
        const turn = emptyTurn(`turn-${randomUUID()}`);
        thread.turnIds.push(turn.id);
        thread.turns[turn.id] = turn;
        thread.status = "active";
        thread.updatedAt = Math.floor(Date.now() / 1000);
        this.startedTurnRequests.set(requestKey, { fingerprint, turn: structuredClone(turn) });
        while (this.startedTurnRequests.size > 500) {
          const oldestKey = this.startedTurnRequests.keys().next().value as string | undefined;
          if (!oldestKey) break;
          this.startedTurnRequests.delete(oldestKey);
        }
        emit(this.response(request.id, { turn }));
        void this.runTurn(thread, turn, input, emit);
        return;
      }
      case "turn.interrupt": {
        const threadId = String(request.params.threadId ?? "");
        const turnId = String(request.params.turnId ?? "");
        const thread = this.threads.get(threadId);
        const turn = thread?.turns[turnId];
        if (thread && turn) {
          this.interruptedTurns.add(turnId);
          turn.status = "interrupted";
          turn.completedAt = Math.floor(Date.now() / 1000);
          emit(this.event({ method: "turn.completed", params: { threadId, turn: structuredClone(turn) } }));
        }
        emit(this.response(request.id, { interrupted: Boolean(turn) }));
        return;
      }
      case "approval.resolve": {
        const approvalId = String(request.params.approvalId ?? "");
        const decision = String(request.params.decision ?? "decline");
        this.pendingApprovals.get(approvalId)?.resolve(decision);
        this.pendingApprovals.delete(approvalId);
        emit(this.response(request.id, { approvalId, decision }));
        emit(this.event({ method: "approval.resolved", params: { approvalId } }));
        return;
      }
      case "events.resume": {
        const afterSequence = Number(request.params.afterSequence ?? 0);
        emit(this.response(request.id, {
          events: this.history.filter((event) => event.sequence > afterSequence),
          latestSequence: this.sequence,
          resetRequired: false,
        }));
        return;
      }
      case "events.ack":
        emit(this.response(request.id, { acknowledged: Number(request.params.sequence ?? 0) }));
        return;
      default:
        emit(this.error(request.id, "unsupported_method", `模拟器暂不支持 ${request.method}`));
    }
  }

  private async runTurn(thread: RemoteThread, turn: RemoteTurn, input: string, emit: Emit): Promise<void> {
    const threadId = thread.id;
    emit(this.event({ method: "turn.started", params: { threadId, turn: structuredClone(turn) } }));

    const userItem = { type: "userMessage" as const, id: `user-${randomUUID()}`, turnId: turn.id, status: "completed" as const, text: input };
    thread.items[userItem.id] = userItem;
    turn.itemIds.push(userItem.id);
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: userItem } }));
    if (input.includes("等待手机停止")) {
      for (let index = 0; index < 60; index += 1) {
        await this.delay();
        if (this.interruptedTurns.has(turn.id)) return;
      }
    }
    await this.delay();
    if (this.interruptedTurns.has(turn.id)) return;

    const reasoning: ReasoningItem = { type: "reasoning", id: `reasoning-${randomUUID()}`, turnId: turn.id, status: "inProgress", summary: [], content: [] };
    thread.items[reasoning.id] = reasoning;
    turn.itemIds.push(reasoning.id);
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: reasoning } }));
    for (const delta of ["分析当前会话状态", "，准备执行所需操作", "，随后整理结果。"] as const) {
      emit(this.event({ method: "item.delta", params: { threadId, turnId: turn.id, itemId: reasoning.id, target: "reasoningSummary", delta } }));
      await this.delay();
      if (this.interruptedTurns.has(turn.id)) return;
    }
    reasoning.summary = ["分析当前会话状态，准备执行所需操作，随后整理结果。"];
    reasoning.status = "completed";
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: structuredClone(reasoning) } }));

    if (input.includes("工具")) {
      const tool: ToolCallItem = {
        type: "toolCall",
        id: `tool-${randomUUID()}`,
        turnId: turn.id,
        status: "inProgress",
        namespace: "mock",
        tool: "inspect",
        arguments: { threadId },
        output: "",
        success: null,
        durationMs: null,
      };
      thread.items[tool.id] = tool;
      turn.itemIds.push(tool.id);
      emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: structuredClone(tool) } }));
      await this.delay();
      if (this.interruptedTurns.has(turn.id)) return;
      tool.status = input.includes("失败") ? "failed" : "completed";
      tool.success = !input.includes("失败");
      tool.output = tool.success ? "模拟工具返回成功" : "模拟工具返回失败";
      tool.durationMs = 120;
      emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: structuredClone(tool) } }));
    }

    const commentary: AgentMessageItem = {
      type: "agentMessage",
      id: `commentary-${randomUUID()}`,
      turnId: turn.id,
      status: "inProgress",
      text: "",
      phase: "commentary",
    };
    thread.items[commentary.id] = commentary;
    turn.itemIds.push(commentary.id);
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: commentary } }));
    emit(this.event({ method: "item.delta", params: { threadId, turnId: turn.id, itemId: commentary.id, target: "agentMessage", delta: "正在整理执行进度，下一步继续完成验证。" } }));
    await this.delay();
    if (this.interruptedTurns.has(turn.id)) return;
    commentary.text = "正在整理执行进度，下一步继续完成验证。";
    commentary.status = "completed";
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: structuredClone(commentary) } }));

    if (input.includes("命令") || input.includes("测试")) {
      const command: CommandItem = {
        type: "commandExecution",
        id: `command-${randomUUID()}`,
        turnId: turn.id,
        status: "inProgress",
        command: "pnpm test",
        cwd: thread.cwd,
        output: "",
        exitCode: null,
        durationMs: null,
      };
      thread.items[command.id] = command;
      turn.itemIds.push(command.id);
      emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: command } }));
      emit(this.event({ method: "item.delta", params: { threadId, turnId: turn.id, itemId: command.id, target: "commandOutput", delta: "正在运行测试…\n" } }));
      await this.delay();
      if (this.interruptedTurns.has(turn.id)) return;
      command.status = "completed";
      command.output = "正在运行测试…\n全部测试通过\n";
      command.exitCode = 0;
      command.durationMs = 842;
      emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: structuredClone(command) } }));
    }

    if (input.includes("差异") || input.toLowerCase().includes("diff")) {
      const patch = "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,2 +1,3 @@\n const ready = true;\n+export default ready;\n";
      const change = {
        type: "fileChange" as const,
        id: `file-${randomUUID()}`,
        turnId: turn.id,
        status: "completed" as const,
        changes: [{ path: "src/example.ts", additions: 1, deletions: 0 }],
        patch,
      };
      thread.items[change.id] = change;
      turn.itemIds.push(change.id);
      emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: change } }));
      emit(this.event({ method: "turn.diff.updated", params: { threadId, turnId: turn.id, diff: patch } }));
    }

    if (input.includes("审批")) {
      const approval: ApprovalRequest = {
        id: `approval-${randomUUID()}`,
        method: "item/commandExecution/requestApproval",
        threadId,
        turnId: turn.id,
        itemId: `command-${randomUUID()}`,
        title: "批准命令执行",
        description: "模拟器请求执行受控命令",
        command: "pnpm build",
        cwd: thread.cwd,
        availableDecisions: ["accept", "decline"],
        raw: {},
      };
      emit(this.event({ method: "approval.requested", params: { approval } }));
      const decision = await new Promise<string>((resolve) => this.pendingApprovals.set(approval.id, { resolve }));
      if (this.interruptedTurns.has(turn.id)) return;
      if (decision === "decline") {
        turn.status = "failed";
        turn.error = "用户拒绝了模拟操作";
      }
    }

    const agent: AgentMessageItem = { type: "agentMessage", id: `agent-${randomUUID()}`, turnId: turn.id, status: "inProgress", text: "", phase: "final_answer" };
    thread.items[agent.id] = agent;
    turn.itemIds.push(agent.id);
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: agent } }));
    const answer = turn.status === "failed" ? "操作已被拒绝。" : "任务已完成，当前会话状态和事件流均已同步。";
    for (const delta of [answer.slice(0, 8), answer.slice(8, 18), answer.slice(18)]) {
      if (!delta) continue;
      emit(this.event({ method: "item.delta", params: { threadId, turnId: turn.id, itemId: agent.id, target: "agentMessage", delta } }));
      await this.delay();
      if (this.interruptedTurns.has(turn.id)) return;
    }
    agent.text = answer;
    agent.status = "completed";
    emit(this.event({ method: "item.upsert", params: { threadId, turnId: turn.id, item: structuredClone(agent) } }));

    turn.status = turn.status === "failed" ? "failed" : "completed";
    turn.completedAt = Math.floor(Date.now() / 1000);
    turn.durationMs = Math.max(1, (turn.completedAt - (turn.startedAt ?? turn.completedAt)) * 1_000);
    thread.status = "idle";
    emit(this.event({ method: "turn.completed", params: { threadId, turn: structuredClone(turn) } }));
    this.interruptedTurns.delete(turn.id);
  }
}

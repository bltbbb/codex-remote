import { describe, expect, it } from "vitest";
import type { CodexRpcTransport, RpcId } from "../src/codex-rpc";
import { CodexBridgeEngine } from "../src/bridge-engine";
import { EventJournal } from "../src/event-journal";

class FakeRpc implements CodexRpcTransport {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  readonly responses: Array<{ id: RpcId; result: unknown }> = [];
  private notification: ((method: string, params: unknown) => void) | null = null;
  private serverRequest: ((id: RpcId, method: string, params: unknown) => void) | null = null;

  async request(method: string, params?: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/list") return { data: [{ id: "thread-1", sessionId: "session-1", name: "真实会话", preview: "", cwd: "E:\\repo", modelProvider: "openai", createdAt: 1, updatedAt: 2, status: "idle", isPinned: false, source: "appServer" }], nextCursor: null };
    if (method === "thread/resume" || method === "thread/start") {
      const thread = { id: "thread-1", sessionId: "session-1", name: "真实会话", preview: "", cwd: "E:\\repo", modelProvider: "openai", createdAt: 1, updatedAt: 2, status: "idle", isPinned: false, source: "appServer", turns: [] };
      if (method === "thread/resume") this.notification?.("thread/started", { thread });
      return { thread };
    }
    if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress", items: [], startedAt: 1, completedAt: null, durationMs: null, error: null } };
    return {};
  }

  respond(id: RpcId, result: unknown): void { this.responses.push({ id, result }); }
  respondError(): void {}
  onNotification(listener: (method: string, params: unknown) => void): () => void { this.notification = listener; return () => { this.notification = null; }; }
  onRequest(listener: (id: RpcId, method: string, params: unknown) => void): () => void { this.serverRequest = listener; return () => { this.serverRequest = null; }; }
  async close(): Promise<void> {}
  requestApproval(id: RpcId = 7): void {
    this.serverRequest?.(id, "item/commandExecution/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "pnpm test",
      cwd: "E:\\repo",
    });
  }
  requestPermissionApproval(id: RpcId = 8): void {
    this.serverRequest?.(id, "item/permissions/requestApproval", {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-2",
      permissions: { network: true },
    });
  }
}

const info = {
  bridgeVersion: "0.1.0",
  codexVersion: "test",
  codexUserAgent: "test",
  codexHome: "C:\\codex",
  appServerUrl: "ws://127.0.0.1:1",
  appServerMode: "native-host" as const,
  desktopVersion: "test",
  nativeHostPid: 1,
  codexPid: 2,
  namedPipe: "test",
};

describe("Bridge 核心", () => {
  it("将线程与回合请求映射到同一个 Codex 传输", async () => {
    const rpc = new FakeRpc();
    const engine = new CodexBridgeEngine(rpc, new EventJournal(), info, ["E:\\repo"]);
    const request = (id: string, method: Parameters<CodexBridgeEngine["handle"]>[0]["method"], params: Record<string, unknown>) => ({ kind: "request" as const, id, method, params });

    await engine.handle(request("1", "thread.list", {}));
    await engine.handle(request("2", "thread.read", { threadId: "thread-1" }));
    await engine.handle(request("3", "turn.start", { threadId: "thread-1", text: "继续" }));

    expect(rpc.calls.map((call) => call.method)).toEqual(["thread/list", "thread/resume", "turn/start"]);
  });

  it("新建会话启用请求审批并可停止同一回合", async () => {
    const rpc = new FakeRpc();
    const engine = new CodexBridgeEngine(rpc, new EventJournal(), info, ["E:\\repo"]);

    await engine.handle({ kind: "request", id: "create", method: "thread.create", params: { cwd: "E:\\repo" } });
    await engine.handle({ kind: "request", id: "stop", method: "turn.interrupt", params: { threadId: "thread-1", turnId: "turn-1" } });

    expect(rpc.calls).toEqual([
      {
        method: "thread/start",
        params: { cwd: "E:\\repo", ephemeral: false, approvalPolicy: "on-request", sandbox: "workspace-write" },
      },
      { method: "turn/interrupt", params: { threadId: "thread-1", turnId: "turn-1" } },
    ]);
  });

  it("把 Codex 审批请求转发给手机并回写决定", async () => {
    const rpc = new FakeRpc();
    const journal = new EventJournal();
    const engine = new CodexBridgeEngine(rpc, journal, info);
    rpc.requestApproval();
    expect(journal.replay(0)[0]?.event.method).toBe("approval.requested");

    await engine.handle({ kind: "request", id: "approve", method: "approval.resolve", params: { approvalId: "7", decision: "accept" } });
    expect(rpc.responses).toEqual([{ id: 7, result: { decision: "accept" } }]);

    rpc.requestApproval(9);
    await engine.handle({ kind: "request", id: "decline", method: "approval.resolve", params: { approvalId: "9", decision: "decline" } });
    expect(rpc.responses.at(-1)).toEqual({ id: 9, result: { decision: "decline" } });

    rpc.requestPermissionApproval();
    await engine.handle({ kind: "request", id: "permission", method: "approval.resolve", params: { approvalId: "8", decision: "accept" } });
    expect(rpc.responses.at(-1)).toEqual({ id: 8, result: { permissions: { network: true }, scope: "turn" } });
    expect(journal.replay(0).filter((entry) => entry.event.method === "approval.resolved")).toHaveLength(3);
  });

  it("只暴露白名单工作区，并让重复提交只启动一个回合", async () => {
    const rpc = new FakeRpc();
    const engine = new CodexBridgeEngine(rpc, new EventJournal(), info, ["E:\\repo"]);
    await engine.handle({ kind: "request", id: "list", method: "thread.list", params: {} });
    const workspaces = await engine.handle({ kind: "request", id: "workspace", method: "workspace.list", params: {} }) as { workspaces: Array<{ path: string }> };
    expect(workspaces.workspaces.map((entry) => entry.path)).toContain("E:\\repo");

    const first = await engine.handle({ kind: "request", id: "turn-1", method: "turn.start", params: { threadId: "thread-1", text: "继续", clientRequestId: "same" } });
    const second = await engine.handle({ kind: "request", id: "turn-2", method: "turn.start", params: { threadId: "thread-1", text: "继续", clientRequestId: "same" } });
    expect((first as { turn: { id: string } }).turn.id).toBe((second as { turn: { id: string } }).turn.id);
    expect(rpc.calls.filter((call) => call.method === "turn/start")).toHaveLength(1);
    await expect(engine.handle({ kind: "request", id: "turn-3", method: "turn.start", params: { threadId: "thread-1", text: "不同", clientRequestId: "same" } })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("预热并复用首屏历史与会话快照", async () => {
    const rpc = new FakeRpc();
    const journal = new EventJournal();
    const engine = new CodexBridgeEngine(rpc, journal, info);

    await engine.warmInitialState();
    await engine.handle({ kind: "request", id: "list", method: "thread.list", params: { limit: 100, cursor: null, searchTerm: "" } });
    await engine.handle({ kind: "request", id: "read", method: "thread.read", params: { threadId: "thread-1" } });

    expect(rpc.calls.map((call) => call.method)).toEqual(["thread/list", "thread/resume"]);
    expect(journal.replay(0).filter((entry) => entry.event.method === "thread.list.snapshot")).toHaveLength(2);
    expect(journal.replay(0).filter((entry) => entry.event.method === "thread.snapshot")).toHaveLength(2);
  });
});

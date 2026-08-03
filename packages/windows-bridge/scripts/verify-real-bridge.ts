import WebSocket from "ws";
import { createRemoteId, parseWireMessage, type ClientMethod, type EventEnvelope, type ServerResponseEnvelope } from "@codex-remote/protocol";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

class VerificationClient {
  private readonly pending = new Map<string, Pending>();
  readonly events: EventEnvelope[] = [];

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const message = parseWireMessage(data.toString());
      if (message.kind === "event") {
        this.events.push(message);
        return;
      }
      if (message.kind === "response") this.resolve(message);
    });
  }

  static async connect(url: string): Promise<VerificationClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new VerificationClient(socket);
  }

  request<T>(method: ClientMethod, params: Record<string, unknown> = {}): Promise<T> {
    const id = createRemoteId();
    this.socket.send(JSON.stringify({ kind: "request", id, method, params }));
    return new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: (value) => resolve(value as T), reject }));
  }

  async waitFor(predicate: (event: EventEnvelope) => boolean, afterIndex = 0, timeoutMs = 180_000): Promise<EventEnvelope> {
    const deadline = Date.now() + timeoutMs;
    let index = afterIndex;
    while (Date.now() < deadline) {
      while (index < this.events.length) {
        const event = this.events[index++];
        if (event && predicate(event)) return event;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("等待真实 Bridge 事件超时");
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.close();
      setTimeout(resolve, 1_000);
    });
  }

  private resolve(response: ServerResponseEnvelope): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.message ?? "Bridge 请求失败"));
  }
}

type ThreadResult = {
  thread: {
    id: string;
    turnIds: string[];
    items: Record<string, { type: string; text?: string; output?: string }>;
  };
};

async function completedTurn(
  client: VerificationClient,
  threadId: string,
  text: string,
  expectedText: string,
  approvalPolicy?: string,
  approvalDecision: "accept" | "decline" = "accept",
): Promise<{ turnId: string; approvalSeen: boolean; snapshot: ThreadResult }> {
  const startIndex = client.events.length;
  const result = await client.request<{ turn: { id: string } }>("turn.start", { threadId, text, approvalPolicy });
  let approvalSeen = false;
  const handledApprovals = new Set<string>();
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    for (const envelope of client.events.slice(startIndex)) {
      if (envelope.event.method === "approval.requested") {
        const approval = envelope.event.params.approval;
        if (approval.threadId === threadId && !handledApprovals.has(approval.id)) {
          handledApprovals.add(approval.id);
          approvalSeen = true;
          await client.request("approval.resolve", { approvalId: approval.id, decision: approvalDecision });
        }
      }
      if (envelope.event.method === "turn.completed" && envelope.event.params.threadId === threadId && envelope.event.params.turn.id === result.turn.id) {
        const snapshot = await client.request<ThreadResult>("thread.read", { threadId });
        const answer = Object.values(snapshot.thread.items)
          .filter((item) => item.type === "agentMessage")
          .map((item) => item.text ?? "")
          .join("\n");
        if (!answer.includes(expectedText)) throw new Error(`真实 Codex 回复未包含 ${expectedText}：${answer}`);
        return { turnId: result.turn.id, approvalSeen, snapshot };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`真实 Codex 回合未完成：${result.turn.id}`);
}

async function main(): Promise<void> {
  const url = process.env.CODEX_REMOTE_VERIFY_URL ?? "ws://127.0.0.1:18787/ws";
  let client: VerificationClient | null = null;
  let threadId: string | null = null;
  const evidence: Record<string, unknown> = {};

  try {
    client = await VerificationClient.connect(url);
    evidence.connection = await client.request("connection.info");
    const created = await client.request<ThreadResult>("thread.create", { cwd: process.cwd(), approvalPolicy: "on-request", sandbox: "workspace-write" });
    threadId = created.thread.id;
    evidence.createdThreadId = threadId;

    const first = await completedTurn(client, threadId, "只回复 REMOTE_CODEX_STAGE3_OK，不要执行任何工具。", "REMOTE_CODEX_STAGE3_OK");
    evidence.firstTurnId = first.turnId;

    const listed = await client.request<{ threads: Array<{ id: string }> }>("thread.list", { limit: 100 });
    if (!listed.threads.some((thread) => thread.id === threadId)) throw new Error("真实历史列表中找不到刚创建的会话");
    evidence.historyListed = true;

    await client.close();
    client = await VerificationClient.connect(url);
    const resumed = await client.request<ThreadResult>("thread.read", { threadId });
    if (!resumed.thread.turnIds.includes(first.turnId)) throw new Error("第二个客户端恢复历史后缺少第一个回合");
    evidence.secondClientResumed = true;

    const second = await completedTurn(client, threadId, "只回复 REMOTE_CODEX_STAGE3_CONTINUE_OK，不要执行任何工具。", "REMOTE_CODEX_STAGE3_CONTINUE_OK");
    evidence.continuedTurnId = second.turnId;

    const approval = await completedTurn(
      client,
      threadId,
      "请使用 shell 执行命令 `python -c \"print('REMOTE_CODEX_STAGE3_APPROVAL_OK')\"`，然后只回复 REMOTE_CODEX_STAGE3_APPROVAL_DONE。",
      "REMOTE_CODEX_STAGE3_APPROVAL_DONE",
      "untrusted",
    );
    if (!approval.approvalSeen) throw new Error("真实命令回合没有触发审批请求");
    evidence.approvalTurnId = approval.turnId;
    evidence.approvalAccepted = true;

    const rejectedMarker = "REMOTE_CODEX_STAGE3_REJECT_SHOULD_NOT_RUN";
    const rejected = await completedTurn(
      client,
      threadId,
      `请使用 shell 执行命令 \`python -c "print('${rejectedMarker}')"\`。如果审批被拒绝，只回复 REMOTE_CODEX_STAGE3_APPROVAL_REJECTED。`,
      "REMOTE_CODEX_STAGE3_APPROVAL_REJECTED",
      "untrusted",
      "decline",
    );
    if (!rejected.approvalSeen) throw new Error("真实拒绝回合没有触发审批请求");
    const rejectedCommandOutput = Object.values(rejected.snapshot.thread.items)
      .filter((item) => item.type === "commandExecution")
      .map((item) => item.output ?? "")
      .join("\n");
    if (rejectedCommandOutput.includes(rejectedMarker)) throw new Error("审批拒绝后命令仍然产生了输出");
    evidence.rejectedApprovalTurnId = rejected.turnId;
    evidence.approvalDeclined = true;

    const stopStartIndex = client.events.length;
    const stopTurn = await client.request<{ turn: { id: string } }>("turn.start", {
      threadId,
      text: "请立即使用 shell 执行 PowerShell 命令 `Start-Sleep -Seconds 30`，不要执行其他操作。",
      approvalPolicy: "never",
    });
    await client.waitFor(
      (event) => event.event.method === "item.upsert"
        && event.event.params.threadId === threadId
        && event.event.params.turnId === stopTurn.turn.id
        && event.event.params.item.type === "commandExecution"
        && event.event.params.item.status === "inProgress",
      stopStartIndex,
    );
    await client.request("turn.interrupt", { threadId, turnId: stopTurn.turn.id });
    const stopped = await client.waitFor(
      (event) => event.event.method === "turn.completed" && event.event.params.threadId === threadId && event.event.params.turn.id === stopTurn.turn.id,
      stopStartIndex,
    );
    if (stopped.event.method !== "turn.completed" || stopped.event.params.turn.status !== "interrupted") {
      throw new Error(`停止后的回合状态不是 interrupted：${stopped.event.method === "turn.completed" ? stopped.event.params.turn.status : "unknown"}`);
    }
    evidence.interruptedTurnId = stopTurn.turn.id;

    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } finally {
    if (client && threadId) {
      try { await client.request("thread.delete", { threadId }); } catch (error) { console.error(`清理测试会话失败：${error instanceof Error ? error.message : String(error)}`); }
    }
    await client?.close();
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

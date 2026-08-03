import path from "node:path";
import {
  normalizeApprovalRequest,
  normalizeCodexNotification,
  normalizeThread,
  normalizeThreadSummary,
  normalizeTurn,
  type ClientRequestEnvelope,
  type RemoteEvent,
  type RemoteThread,
  type RemoteThreadSummary,
  type RemoteWorkspace,
} from "@codex-remote/protocol";
import type { CodexRpcTransport, RpcId } from "./codex-rpc";
import { EventJournal } from "./event-journal";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function normalizeWorkspacePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return path.normalize(path.resolve(trimmed));
}

function workspaceKey(value: string): string {
  return normalizeWorkspacePath(value).replace(/[\\/]+$/, "").toLowerCase();
}

function workspaceName(value: string): string {
  const normalized = normalizeWorkspacePath(value).replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized;
}

function normalizeAttachments(value: unknown): Array<{
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: "image" | "audio" | "file";
  dataUrl?: string;
  text?: string;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const source = record(entry);
    const kind = source.kind === "image" || source.kind === "audio" || source.kind === "file" ? source.kind : null;
    const name = typeof source.name === "string" ? source.name.slice(0, 160) : "附件";
    const mimeType = typeof source.mimeType === "string" ? source.mimeType.slice(0, 120) : "application/octet-stream";
    const size = typeof source.size === "number" && Number.isFinite(source.size) ? Math.max(0, source.size) : 0;
    if (!kind || size > 10 * 1024 * 1024) return [];
    const dataUrl = typeof source.dataUrl === "string" && source.dataUrl.length <= MAX_ATTACHMENT_DATA_URL_LENGTH ? source.dataUrl : undefined;
    const text = typeof source.text === "string" ? source.text.slice(0, MAX_ATTACHMENT_TEXT) : undefined;
    if ((kind === "image" || kind === "audio") && !dataUrl?.startsWith("data:")) return [];
    return [{ id: typeof source.id === "string" ? source.id : name, name, mimeType, size, kind, dataUrl, text }];
  });
}

export class BridgeRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface BridgeInfo {
  bridgeVersion: string;
  codexVersion: string;
  codexUserAgent: string;
  codexHome: string;
  appServerUrl: string;
  appServerMode: "native-host" | "explicit" | "independent";
  desktopVersion: string | null;
  nativeHostPid: number | null;
  codexPid: number | null;
  namedPipe: string;
}

type PendingApproval = {
  rpcId: RpcId;
  method: string;
  params: UnknownRecord;
};

type ThreadListResult = {
  threads: RemoteThreadSummary[];
  nextCursor: string | null;
};

type TimedThreadSnapshot = {
  thread: RemoteThread;
  cachedAt: number;
};

const THREAD_LIST_CACHE_MS = 5 * 60_000;
const THREAD_SNAPSHOT_CACHE_MS = 2 * 60_000;
const MAX_CACHED_THREADS = 3;
const MAX_IDEMPOTENT_TURN_STARTS = 512;
const MAX_ATTACHMENT_TEXT = 200_000;
const MAX_ATTACHMENT_DATA_URL_LENGTH = 14 * 1024 * 1024;

type IdempotentTurnStart = { fingerprint: string; result: Promise<unknown> };

export class CodexBridgeEngine {
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly threadSnapshots = new Map<string, TimedThreadSnapshot>();
  private threadListCache: (ThreadListResult & { cachedAt: number }) | null = null;
  private threadListInFlight: Promise<ThreadListResult> | null = null;
  private readonly threadResumeInFlight = new Map<string, Promise<RemoteThread>>();
  private readonly idempotentTurnStarts = new Map<string, IdempotentTurnStart>();
  private readonly configuredWorkspacePaths: string[];
  private readonly disposeNotification: () => void;
  private readonly disposeRequest: () => void;

  constructor(
    private readonly rpc: CodexRpcTransport,
    readonly journal: EventJournal,
    private readonly info: BridgeInfo,
    workspacePaths: string[] = [],
  ) {
    this.configuredWorkspacePaths = workspacePaths.map(normalizeWorkspacePath).filter(Boolean);
    this.disposeNotification = rpc.onNotification((method, params) => {
      const event = normalizeCodexNotification(method, params);
      this.updateCaches(event);
      this.journal.publish(event);
    });
    this.disposeRequest = rpc.onRequest((id, method, params) => this.handleServerRequest(id, method, params));
  }

  announceOnline(): void {
    this.journal.publish({ method: "connection.status", params: { phase: "online", message: "真实 Codex app-server 已连接" } });
  }

  announceError(message: string): void {
    this.journal.publish({ method: "connection.status", params: { phase: "error", message } });
  }

  async warmInitialState(): Promise<void> {
    const result = await this.listThreads({ limit: 100, cursor: null, searchTerm: null }) as ThreadListResult;
    const firstThread = result.threads.find((thread) => thread.status === "active") ?? result.threads[0];
    if (firstThread) await this.resumeThread(firstThread.id);
    // thread/resume 会产生 thread/started 通知；预热结束后恢复刚读取的列表缓存。
    this.threadListCache = { ...result, cachedAt: Date.now() };
  }

  async handle(request: ClientRequestEnvelope, clientId = "anonymous"): Promise<unknown> {
    switch (request.method) {
      case "connection.info":
        return { mode: "bridge", protocolVersion: 1, latestSequence: this.journal.latestSequence, ...this.info };
      case "workspace.list":
        return this.listWorkspaces();
      case "thread.list":
        return this.listThreads(request.params);
      case "thread.read":
      case "thread.resume":
        return this.resumeThread(String(request.params.threadId ?? ""));
      case "thread.create":
        return this.createThread(String(request.params.cwd ?? ""), request.params);
      case "thread.delete":
        return this.deleteThread(String(request.params.threadId ?? ""));
      case "turn.start": {
        const threadId = String(request.params.threadId ?? "");
        const text = String(request.params.text ?? "");
        const clientRequestId = String(request.params.clientRequestId ?? request.id);
        return this.startTurnIdempotent(clientId, clientRequestId, threadId, text, request.params);
      }
      case "turn.interrupt":
        return this.interruptTurn(String(request.params.threadId ?? ""), String(request.params.turnId ?? ""));
      case "approval.resolve":
        return this.resolveApproval(String(request.params.approvalId ?? ""), String(request.params.decision ?? "decline"));
      case "events.resume":
        return this.resumeEvents(Number(request.params.afterSequence ?? 0));
      case "events.ack":
        return { acknowledged: this.journal.acknowledge(String(request.params.clientId ?? clientId), Number(request.params.sequence ?? 0)) };
      case "pairing.complete":
      case "device.list":
      case "device.revoke":
        throw new BridgeRequestError("admin_method_unavailable", "设备管理请求必须由 Bridge 管理层处理");
      default:
        throw new BridgeRequestError("unsupported_method", `Bridge 暂不支持 ${String(request.method)}`);
    }
  }

  dispose(): void {
    this.disposeNotification();
    this.disposeRequest();
  }

  private async listThreads(params: UnknownRecord): Promise<ThreadListResult> {
    const cacheable = !params.cursor && !params.searchTerm && (params.limit == null || params.limit === 100);
    if (cacheable && this.threadListCache && Date.now() - this.threadListCache.cachedAt < THREAD_LIST_CACHE_MS) {
      const { threads, nextCursor } = this.threadListCache;
      this.publishThreadList(threads, nextCursor, false);
      return { threads, nextCursor };
    }

    if (cacheable) {
      if (!this.threadListInFlight) {
        this.threadListInFlight = this.fetchThreadList(params).finally(() => {
          this.threadListInFlight = null;
        });
      }
      const result = await this.threadListInFlight;
      this.threadListCache = { ...result, cachedAt: Date.now() };
      this.publishThreadList(result.threads, result.nextCursor, false);
      return result;
    }

    const result = await this.fetchThreadList(params);
    this.publishThreadList(result.threads, result.nextCursor, typeof params.cursor === "string" && params.cursor.length > 0);
    return result;
  }

  private async fetchThreadList(params: UnknownRecord): Promise<ThreadListResult> {
    const result = record(
      await this.rpc.request("thread/list", {
        cursor: typeof params.cursor === "string" ? params.cursor : null,
        limit: typeof params.limit === "number" ? params.limit : 100,
        searchTerm: typeof params.searchTerm === "string" ? params.searchTerm : null,
        sortKey: "updated_at",
        sortDirection: "desc",
      }),
    );
    const threads = Array.isArray(result.data) ? result.data.map(normalizeThreadSummary) : [];
    const nextCursor = typeof result.nextCursor === "string" ? result.nextCursor : null;
    return { threads, nextCursor };
  }

  private async listWorkspaces(): Promise<{ workspaces: RemoteWorkspace[] }> {
    if (!this.threadListCache || Date.now() - this.threadListCache.cachedAt >= THREAD_LIST_CACHE_MS) {
      const result = await this.fetchThreadList({ limit: 100, cursor: null, searchTerm: null });
      this.threadListCache = { ...result, cachedAt: Date.now() };
    }
    const paths = new Map<string, RemoteWorkspace>();
    for (const workspacePath of this.configuredWorkspacePaths) {
      const key = workspaceKey(workspacePath);
      paths.set(key, { id: `workspace:${key}`, path: workspacePath, name: workspaceName(workspacePath), source: "configured" });
    }
    for (const thread of this.threadListCache.threads) {
      if (!thread.cwd) continue;
      const workspacePath = normalizeWorkspacePath(thread.cwd);
      const key = workspaceKey(workspacePath);
      if (!paths.has(key)) paths.set(key, { id: `workspace:${key}`, path: workspacePath, name: workspaceName(workspacePath), source: "history" });
    }
    return { workspaces: [...paths.values()] };
  }

  private publishThreadList(threads: RemoteThreadSummary[], nextCursor: string | null, append: boolean): void {
    this.journal.publish({ method: "thread.list.snapshot", params: { threads, nextCursor, append } });
  }

  private async resumeThread(threadId: string): Promise<unknown> {
    if (!threadId) throw new BridgeRequestError("invalid_thread", "缺少 threadId");
    const cached = this.threadSnapshots.get(threadId);
    if (cached && Date.now() - cached.cachedAt < THREAD_SNAPSHOT_CACHE_MS) {
      this.journal.publish({ method: "thread.snapshot", params: { thread: cached.thread } });
      return { threadId, delivered: true, cached: true };
    }

    let pending = this.threadResumeInFlight.get(threadId);
    if (!pending) {
      pending = this.fetchThread(threadId).then((thread) => {
        this.journal.publish({ method: "thread.snapshot", params: { thread } });
        return thread;
      }).finally(() => {
        this.threadResumeInFlight.delete(threadId);
      });
      this.threadResumeInFlight.set(threadId, pending);
    }
    void pending.catch((error) => {
      this.journal.publish({ method: "error", params: { message: `会话加载失败：${error instanceof Error ? error.message : String(error)}` } });
    });
    // 会话正文会在后台通过 thread.snapshot 事件发送，响应立即确认请求已排队。
    return { threadId, delivered: false, loading: true };
  }

  private resumeEvents(afterSequence: number): unknown {
    // 首次连接会紧接着调用 thread.list/thread.read；不要把 Bridge 启动以来的
    // 大型会话快照全部塞进恢复响应。轻量事件仍可用于恢复连接状态和审批状态。
    const events = this.journal.replayBounded(afterSequence, 512 * 1024);
    if (afterSequence === 0) {
      return {
        events: events.events.filter((entry) => isLightweightReplayEvent(entry.event.method)),
        latestSequence: this.journal.latestSequence,
        resetRequired: false,
      };
    }
    if (events.truncated) {
      return { events: [], latestSequence: this.journal.latestSequence, resetRequired: true };
    }
    return {
      events: events.events.filter((entry) => isLightweightReplayEvent(entry.event.method)),
      latestSequence: this.journal.latestSequence,
      resetRequired: false,
    };
  }

  private async fetchThread(threadId: string): Promise<RemoteThread> {
    const result = record(await this.rpc.request("thread/resume", { threadId }));
    const thread = normalizeThread(result.thread);
    this.threadSnapshots.delete(threadId);
    this.threadSnapshots.set(threadId, { thread, cachedAt: Date.now() });
    while (this.threadSnapshots.size > MAX_CACHED_THREADS) {
      const oldestId = this.threadSnapshots.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.threadSnapshots.delete(oldestId);
    }
    return thread;
  }

  private async createThread(cwd: string, params: UnknownRecord): Promise<unknown> {
    if (!cwd) throw new BridgeRequestError("invalid_cwd", "新建会话需要电脑上的绝对工作目录");
    if (!path.isAbsolute(cwd)) throw new BridgeRequestError("invalid_cwd", "新建会话需要电脑上的绝对工作目录");
    const workspace = normalizeWorkspacePath(cwd);
    const configured = this.configuredWorkspacePaths.some((entry) => workspaceKey(entry) === workspaceKey(workspace));
    const allowed = configured || (await this.listWorkspaces()).workspaces.some((entry) => workspaceKey(entry.path) === workspaceKey(workspace));
    if (!allowed) {
      throw new BridgeRequestError("workspace_not_allowed", "该工作区未被电脑端明确暴露，无法创建会话", { cwd });
    }
    const result = record(
      await this.rpc.request("thread/start", {
        cwd: workspace,
        ephemeral: false,
        approvalPolicy: typeof params.approvalPolicy === "string" ? params.approvalPolicy : "on-request",
        sandbox: typeof params.sandbox === "string" ? params.sandbox : "workspace-write",
      }),
    );
    const thread = normalizeThread(result.thread);
    this.upsertCachedThread(thread);
    this.threadSnapshots.set(thread.id, { thread, cachedAt: Date.now() });
    this.journal.publish({ method: "thread.upsert", params: { thread } });
    this.journal.publish({ method: "thread.snapshot", params: { thread } });
    return { thread };
  }

  private async deleteThread(threadId: string): Promise<unknown> {
    if (!threadId) throw new BridgeRequestError("invalid_thread", "缺少 threadId");
    await this.rpc.request("thread/delete", { threadId });
    this.removeCachedThread(threadId);
    this.threadSnapshots.delete(threadId);
    this.journal.publish({ method: "thread.removed", params: { threadId } });
    return { threadId, deleted: true };
  }

  private startTurnIdempotent(clientId: string, clientRequestId: string, threadId: string, text: string, params: UnknownRecord): Promise<unknown> {
    const key = `${clientId}:${clientRequestId}`;
    const fingerprint = JSON.stringify({ threadId, text, attachments: params.attachments ?? null });
    const existing = this.idempotentTurnStarts.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new BridgeRequestError("idempotency_conflict", "相同提交标识对应了不同的消息内容");
      }
      return existing.result;
    }
    const result = this.startTurn(threadId, text, params);
    this.idempotentTurnStarts.set(key, { fingerprint, result });
    while (this.idempotentTurnStarts.size > MAX_IDEMPOTENT_TURN_STARTS) {
      const oldestKey = this.idempotentTurnStarts.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.idempotentTurnStarts.delete(oldestKey);
    }
    void result.catch(() => {
      const current = this.idempotentTurnStarts.get(key);
      if (current?.result === result) this.idempotentTurnStarts.delete(key);
    });
    return result;
  }

  private async startTurn(threadId: string, text: string, params: UnknownRecord): Promise<unknown> {
    const attachments = normalizeAttachments(params.attachments);
    if (!threadId || (!text.trim() && !attachments.length)) throw new BridgeRequestError("invalid_turn", "缺少 threadId 或消息内容");
    const cachedThread = this.threadSnapshots.get(threadId)?.thread;
    const listedThread = this.threadListCache?.threads.find((thread) => thread.id === threadId);
    const threadCwd = cachedThread?.cwd || listedThread?.cwd || (await this.fetchThread(threadId)).cwd;
    if (!threadCwd) throw new BridgeRequestError("workspace_not_allowed", "无法确认该会话的工作区");
    const configured = this.configuredWorkspacePaths.some((entry) => workspaceKey(entry) === workspaceKey(threadCwd));
    const allowed = configured || (await this.listWorkspaces()).workspaces.some((entry) => workspaceKey(entry.path) === workspaceKey(threadCwd));
    if (!allowed) throw new BridgeRequestError("workspace_not_allowed", "该会话工作区已不在电脑端白名单中", { cwd: threadCwd });
    const input: UnknownRecord[] = text.trim() ? [{ type: "text", text, text_elements: [] }] : [];
    for (const attachment of attachments) {
      if (attachment.kind === "image" && attachment.dataUrl) input.push({ type: "image", url: attachment.dataUrl });
      else if (attachment.kind === "audio" && attachment.dataUrl) input.push({ type: "audio", url: attachment.dataUrl });
      else if (attachment.kind === "file") {
        const body = attachment.text?.slice(0, MAX_ATTACHMENT_TEXT) ?? `[二进制附件：${attachment.name}]`;
        input.push({ type: "text", text: `\n\n附件：${attachment.name}\n${body}`, text_elements: [] });
      }
    }
    const turnParams: UnknownRecord = { threadId, input };
    if (typeof params.clientRequestId === "string" && params.clientRequestId.trim()) turnParams.clientUserMessageId = params.clientRequestId;
    if (typeof params.approvalPolicy === "string") turnParams.approvalPolicy = params.approvalPolicy;
    if (typeof params.sandboxPolicy === "object" && params.sandboxPolicy) turnParams.sandboxPolicy = params.sandboxPolicy;
    if (typeof params.permissions === "string") turnParams.permissions = params.permissions;
    const result = record(await this.rpc.request("turn/start", turnParams));
    this.threadSnapshots.delete(threadId);
    return { turn: normalizeTurn(result.turn) };
  }

  private updateCaches(event: RemoteEvent): void {
    switch (event.method) {
      case "thread.upsert":
        this.upsertCachedThread(event.params.thread);
        this.threadSnapshots.delete(event.params.thread.id);
        break;
      case "thread.removed":
        this.removeCachedThread(event.params.threadId);
        this.threadSnapshots.delete(event.params.threadId);
        break;
      case "turn.started":
      case "turn.completed":
        this.updateCachedThreadStatus(event.params.threadId, event.method === "turn.started" ? "active" : "idle");
        this.threadSnapshots.delete(event.params.threadId);
        break;
      case "item.upsert":
      case "item.delta":
      case "turn.diff.updated":
        this.threadSnapshots.delete(event.params.threadId);
        break;
      default:
        break;
    }
  }

  private upsertCachedThread(thread: RemoteThreadSummary): void {
    if (!this.threadListCache) return;
    this.threadListCache.threads = [thread, ...this.threadListCache.threads.filter((item) => item.id !== thread.id)].slice(0, 100);
  }

  private removeCachedThread(threadId: string): void {
    if (!this.threadListCache) return;
    this.threadListCache.threads = this.threadListCache.threads.filter((thread) => thread.id !== threadId);
  }

  private updateCachedThreadStatus(threadId: string, status: string): void {
    const thread = this.threadListCache?.threads.find((item) => item.id === threadId);
    if (!thread) return;
    Object.assign(thread, { status, updatedAt: Math.floor(Date.now() / 1_000) });
    this.upsertCachedThread(thread);
  }

  private async interruptTurn(threadId: string, turnId: string): Promise<unknown> {
    if (!threadId || !turnId) throw new BridgeRequestError("invalid_turn", "停止任务需要 threadId 和 turnId");
    await this.rpc.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true };
  }

  private resolveApproval(approvalId: string, decision: string): unknown {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new BridgeRequestError("approval_not_found", `找不到待处理审批 ${approvalId}`);
    this.pendingApprovals.delete(approvalId);

    if (pending.method === "item/permissions/requestApproval") {
      const requested = record(pending.params.permissions);
      this.rpc.respond(pending.rpcId, {
        permissions: decision === "accept" ? requested : {},
        scope: "turn",
      });
    } else {
      this.rpc.respond(pending.rpcId, { decision: decision === "accept" ? "accept" : "decline" });
    }
    this.journal.publish({ method: "approval.resolved", params: { approvalId } });
    return { approvalId, decision };
  }

  private handleServerRequest(id: RpcId, method: string, paramsInput: unknown): void {
    if (!method.includes("requestApproval")) {
      this.rpc.respondError(id, -32601, `Codex Remote 暂不处理服务器请求 ${method}`);
      return;
    }
    const params = record(paramsInput);
    const approvalId = String(id);
    this.pendingApprovals.set(approvalId, { rpcId: id, method, params });
    const approval = normalizeApprovalRequest(approvalId, method, params);
    this.journal.publish({ method: "approval.requested", params: { approval } });
  }
}

function isLightweightReplayEvent(method: string): boolean {
  return method === "connection.status"
    || method === "thread.list.snapshot"
    || method === "thread.upsert"
    || method === "thread.removed"
    || method === "turn.started"
    || method === "turn.completed"
    || method === "turn.diff.updated"
    || method === "approval.requested"
    || method === "approval.resolved"
    || method === "error";
}

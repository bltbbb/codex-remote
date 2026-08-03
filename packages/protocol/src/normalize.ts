import type {
  ApprovalRequest,
  RemoteEvent,
  RemoteItem,
  RemoteThread,
  RemoteThreadSummary,
  RemoteTurn,
  TurnStatus,
} from "./types";
import { createRemoteId } from "./id";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function normalizeTurnStatus(value: unknown): TurnStatus {
  switch (value) {
    case "inProgress":
    case "completed":
    case "failed":
    case "interrupted":
    case "notStarted":
      return value;
    default:
      return "notStarted";
  }
}

function itemStatus(value: unknown): RemoteItem["status"] {
  switch (value) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
    case "pending":
      return value;
    default:
      return "pending";
  }
}

export function normalizeThreadSummary(input: unknown): RemoteThreadSummary {
  const source = record(input);
  const preview = text(source.preview);
  return {
    id: text(source.id),
    sessionId: text(source.sessionId),
    title: text(source.name) || preview || "未命名会话",
    preview,
    cwd: text(source.cwd),
    modelProvider: text(source.modelProvider),
    createdAt: typeof source.createdAt === "number" ? source.createdAt : 0,
    updatedAt: typeof source.updatedAt === "number" ? source.updatedAt : 0,
    status: text(source.status, "unknown"),
    isPinned: source.isPinned === true,
    source: source.source,
  };
}

export function normalizeTurn(input: unknown): RemoteTurn {
  const source = record(input);
  const items = Array.isArray(source.items) ? source.items : [];
  const errorValue = source.error;
  return {
    id: text(source.id),
    status: normalizeTurnStatus(source.status),
    itemIds: items.map((item) => text(record(item).id)).filter(Boolean),
    startedAt: numberOrNull(source.startedAt),
    completedAt: numberOrNull(source.completedAt),
    durationMs: numberOrNull(source.durationMs),
    error: errorValue == null ? null : text(record(errorValue).message, JSON.stringify(errorValue)),
    diff: text(source.diff) || undefined,
  };
}

function userInputText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      const item = record(entry);
      if (item.type === "text") return text(item.text);
      if (item.type === "image" || item.type === "localImage" || item.type === "input_image") return "[图片]";
      if (item.type === "audio" || item.type === "localAudio" || item.type === "input_audio") return "[音频]";
      if (item.type === "file") return `[附件：${text(item.name, "文件")}]`;
      return item.type ? `[${String(item.type)}]` : "";
    })
    .filter(Boolean)
    .join("\n");
}

export function normalizeItem(input: unknown, turnId: string, forcedStatus?: RemoteItem["status"]): RemoteItem {
  const source = record(input);
  const id = text(source.id) || createRemoteId();
  const type = text(source.type, "unknown");
  const status = forcedStatus ?? itemStatus(source.status);

  switch (type) {
    case "userMessage":
      return { type, id, turnId, status: "completed", text: userInputText(source.content ?? source.input) || text(source.text) };
    case "agentMessage":
      return { type, id, turnId, status, text: text(source.text), phase: source.phase == null ? null : text(source.phase) };
    case "reasoning":
      return {
        type,
        id,
        turnId,
        status,
        summary: Array.isArray(source.summary) ? source.summary.map((part) => text(part)) : [],
        content: Array.isArray(source.content) ? source.content.map((part) => text(part)) : [],
      };
    case "plan":
      return { type, id, turnId, status, text: text(source.text) };
    case "commandExecution":
      return {
        type,
        id,
        turnId,
        status: itemStatus(source.status),
        command: text(source.command),
        cwd: text(source.cwd),
        output: text(source.aggregatedOutput),
        exitCode: numberOrNull(source.exitCode),
        durationMs: numberOrNull(source.durationMs),
      };
    case "fileChange":
      return {
        type,
        id,
        turnId,
        status: itemStatus(source.status),
        changes: Array.isArray(source.changes) ? (source.changes as Array<Record<string, unknown>>) : [],
        patch: text(source.patch),
      };
    case "mcpToolCall":
    case "dynamicToolCall":
      return {
        type: "toolCall",
        id,
        turnId,
        status: itemStatus(source.status),
        namespace: source.namespace == null ? (source.server == null ? null : text(source.server)) : text(source.namespace),
        tool: text(source.tool),
        arguments: source.arguments,
        output: source.result == null ? "" : JSON.stringify(source.result, null, 2),
        success: typeof source.success === "boolean" ? source.success : null,
        durationMs: numberOrNull(source.durationMs),
      };
    default:
      return { type: "unknown", originalType: type, id, turnId, status, data: source };
  }
}

export function normalizeThread(input: unknown): RemoteThread {
  const source = record(input);
  const summary = normalizeThreadSummary(source);
  const turnsInput = Array.isArray(source.turns) ? source.turns : [];
  const turns: RemoteThread["turns"] = {};
  const items: RemoteThread["items"] = {};
  const turnIds: string[] = [];

  for (const rawTurn of turnsInput) {
    const turn = normalizeTurn(rawTurn);
    if (!turn.id) continue;
    turnIds.push(turn.id);
    turns[turn.id] = turn;
    const rawItems = Array.isArray(record(rawTurn).items) ? (record(rawTurn).items as unknown[]) : [];
    for (const rawItem of rawItems) {
      const item = normalizeItem(rawItem, turn.id, "completed");
      items[item.id] = item;
    }
  }

  return { ...summary, turnIds, turns, items };
}

export function normalizeCodexNotification(method: string, paramsInput: unknown): RemoteEvent {
  const params = record(paramsInput);
  const threadId = text(params.threadId);
  const turnId = text(params.turnId) || text(record(params.turn).id);

  switch (method) {
    case "thread/started":
      return { method: "thread.upsert", params: { thread: normalizeThreadSummary(params.thread) } };
    case "thread/deleted":
    case "thread/archived":
      return { method: "thread.removed", params: { threadId } };
    case "turn/started":
      return { method: "turn.started", params: { threadId, turn: normalizeTurn(params.turn) } };
    case "turn/completed":
      return { method: "turn.completed", params: { threadId, turn: normalizeTurn(params.turn) } };
    case "item/started":
      return { method: "item.upsert", params: { threadId, turnId, item: normalizeItem(params.item, turnId, "inProgress") } };
    case "item/completed":
      return { method: "item.upsert", params: { threadId, turnId, item: normalizeItem(params.item, turnId, "completed") } };
    case "item/agentMessage/delta":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "agentMessage", delta: text(params.delta) } };
    case "item/reasoning/summaryTextDelta":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "reasoningSummary", delta: text(params.delta) } };
    case "item/reasoning/textDelta":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "reasoningText", delta: text(params.delta) } };
    case "item/plan/delta":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "plan", delta: text(params.delta) } };
    case "item/commandExecution/outputDelta":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "commandOutput", delta: text(params.delta) } };
    case "item/fileChange/patchUpdated":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "filePatch", delta: text(params.patch) || (Array.isArray(params.changes) ? JSON.stringify(params.changes, null, 2) : "") } };
    case "item/fileChange/outputDelta":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "filePatch", delta: text(params.delta) } };
    case "item/mcpToolCall/progress":
      return { method: "item.delta", params: { threadId, turnId, itemId: text(params.itemId), target: "toolOutput", delta: text(params.message) } };
    case "turn/diff/updated":
      return { method: "turn.diff.updated", params: { threadId, turnId, diff: text(params.diff) } };
    case "turn/plan/updated":
      return {
        method: "item.upsert",
        params: {
          threadId,
          turnId,
          item: normalizeItem({ id: text(params.itemId) || `plan-${turnId}`, type: "plan", text: JSON.stringify(params.plan ?? [], null, 2) }, turnId, "inProgress"),
        },
      };
    case "error":
      return { method: "error", params: { message: text(record(params.error).message, text(params.message, "Codex app-server 错误")), threadId, turnId } };
    default:
      return { method: "raw", params: { method, data: paramsInput } };
  }
}

export function normalizeApprovalRequest(id: string, method: string, paramsInput: unknown): ApprovalRequest {
  const params = record(paramsInput);
  const command = text(params.command);
  const reason = text(params.reason);
  const decisions = Array.isArray(params.availableDecisions) ? params.availableDecisions.map((entry) => text(entry)).filter(Boolean) : [];
  return {
    id,
    method,
    threadId: text(params.threadId),
    turnId: text(params.turnId),
    itemId: text(params.itemId),
    title: method.includes("fileChange") ? "批准文件修改" : method.includes("permissions") ? "批准额外权限" : "批准命令执行",
    description: reason || command || "Codex 请求继续执行操作",
    command: command || undefined,
    cwd: text(params.cwd) || undefined,
    availableDecisions: decisions.length ? decisions : ["accept", "decline"],
    raw: paramsInput,
  };
}

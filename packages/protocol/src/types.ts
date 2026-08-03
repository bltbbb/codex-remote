export type ConnectionPhase = "connecting" | "online" | "offline" | "error";

export type TurnStatus = "notStarted" | "inProgress" | "completed" | "failed" | "interrupted";

export type ItemStatus = "pending" | "inProgress" | "completed" | "failed" | "declined";

export interface RemoteThreadSummary {
  id: string;
  sessionId: string;
  title: string;
  preview: string;
  cwd: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: string;
  isPinned: boolean;
  source: unknown;
}

/** 手机提交给 Bridge 的本地附件。内容只在请求期间传输，不写入会话缓存。 */
export type RemoteAttachmentKind = "image" | "audio" | "file";

export interface RemoteAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: RemoteAttachmentKind;
  /** 图片或音频使用 data URL；普通文本文件使用 text。 */
  dataUrl?: string;
  text?: string;
}

export interface RemoteWorkspace {
  id: string;
  path: string;
  name: string;
  source: "configured" | "history";
}

export interface RemoteTurn {
  id: string;
  status: TurnStatus;
  itemIds: string[];
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  error: string | null;
  /** 当前回合聚合后的 unified diff。旧快照可能没有该字段。 */
  diff?: string;
}

interface RemoteItemBase {
  id: string;
  turnId: string;
  status: ItemStatus;
}

export interface UserMessageItem extends RemoteItemBase {
  type: "userMessage";
  text: string;
}

export interface AgentMessageItem extends RemoteItemBase {
  type: "agentMessage";
  text: string;
  phase: string | null;
}

export interface ReasoningItem extends RemoteItemBase {
  type: "reasoning";
  summary: string[];
  content: string[];
}

export interface PlanItem extends RemoteItemBase {
  type: "plan";
  text: string;
}

export interface CommandItem extends RemoteItemBase {
  type: "commandExecution";
  command: string;
  cwd: string;
  output: string;
  exitCode: number | null;
  durationMs: number | null;
}

export interface FileChangeItem extends RemoteItemBase {
  type: "fileChange";
  changes: Array<Record<string, unknown>>;
  patch: string;
}

export interface ToolCallItem extends RemoteItemBase {
  type: "toolCall";
  namespace: string | null;
  tool: string;
  arguments: unknown;
  output: string;
  success: boolean | null;
  durationMs: number | null;
}

export interface UnknownItem extends RemoteItemBase {
  type: "unknown";
  originalType: string;
  data: Record<string, unknown>;
}

export type RemoteItem =
  | UserMessageItem
  | AgentMessageItem
  | ReasoningItem
  | PlanItem
  | CommandItem
  | FileChangeItem
  | ToolCallItem
  | UnknownItem;

export interface RemoteThread extends RemoteThreadSummary {
  turnIds: string[];
  turns: Record<string, RemoteTurn>;
  items: Record<string, RemoteItem>;
}

export interface ApprovalRequest {
  id: string;
  method: string;
  threadId: string;
  turnId: string;
  itemId: string;
  title: string;
  description: string;
  command?: string;
  cwd?: string;
  availableDecisions: string[];
  raw: unknown;
}

export type RemoteEvent =
  | { method: "connection.status"; params: { phase: ConnectionPhase; message?: string } }
  | { method: "thread.list.snapshot"; params: { threads: RemoteThreadSummary[]; nextCursor: string | null; append?: boolean } }
  | { method: "thread.snapshot"; params: { thread: RemoteThread } }
  | { method: "thread.upsert"; params: { thread: RemoteThreadSummary } }
  | { method: "thread.removed"; params: { threadId: string } }
  | { method: "turn.started"; params: { threadId: string; turn: RemoteTurn } }
  | { method: "turn.completed"; params: { threadId: string; turn: RemoteTurn } }
  | { method: "item.upsert"; params: { threadId: string; turnId: string; item: RemoteItem } }
  | {
      method: "item.delta";
      params: {
        threadId: string;
        turnId: string;
        itemId: string;
        target: "agentMessage" | "reasoningSummary" | "reasoningText" | "plan" | "commandOutput" | "filePatch" | "toolOutput";
        delta: string;
      };
    }
  | { method: "turn.diff.updated"; params: { threadId: string; turnId: string; diff: string } }
  | { method: "approval.requested"; params: { approval: ApprovalRequest } }
  | { method: "approval.resolved"; params: { approvalId: string } }
  | { method: "error"; params: { message: string; threadId?: string; turnId?: string } }
  | { method: "raw"; params: { method: string; data: unknown } };

export interface EventEnvelope {
  kind: "event";
  sequence: number;
  eventId: string;
  event: RemoteEvent;
}

export type ClientMethod =
  | "connection.info"
  | "workspace.list"
  | "thread.list"
  | "thread.read"
  | "thread.create"
  | "thread.delete"
  | "thread.resume"
  | "turn.start"
  | "turn.interrupt"
  | "approval.resolve"
  | "events.resume"
  | "events.ack"
  | "pairing.complete"
  | "device.list"
  | "device.revoke"
  | "mock.fault.configure"
  | "mock.fault.release";

export interface ClientRequestEnvelope {
  kind: "request";
  id: string;
  method: ClientMethod;
  params: Record<string, unknown>;
}

export interface ServerResponseEnvelope {
  kind: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export type WireMessage = ClientRequestEnvelope | ServerResponseEnvelope | EventEnvelope;

export interface RemoteState {
  connection: { phase: ConnectionPhase; message: string };
  threads: Record<string, RemoteThread>;
  threadOrder: string[];
  activeThreadId: string | null;
  nextThreadCursor: string | null;
  approvals: Record<string, ApprovalRequest>;
  processExpanded: Record<string, boolean>;
  manualExpansion: Record<string, boolean>;
  lastSequence: number;
  seenEventIds: Record<string, true>;
  lastError: string | null;
}

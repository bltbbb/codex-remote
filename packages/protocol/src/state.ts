import type { EventEnvelope, RemoteItem, RemoteState, RemoteThread, RemoteTurn } from "./types";

export function createInitialState(): RemoteState {
  return {
    connection: { phase: "offline", message: "尚未连接" },
    threads: {},
    threadOrder: [],
    activeThreadId: null,
    nextThreadCursor: null,
    approvals: {},
    processExpanded: {},
    manualExpansion: {},
    lastSequence: 0,
    seenEventIds: {},
    lastError: null,
  };
}

function ensureThread(state: RemoteState, threadId: string): RemoteThread {
  return state.threads[threadId] ?? {
    id: threadId,
    sessionId: "",
    title: "正在加载…",
    preview: "",
    cwd: "",
    modelProvider: "",
    createdAt: 0,
    updatedAt: 0,
    status: "unknown",
    isPinned: false,
    source: null,
    turnIds: [],
    turns: {},
    items: {},
  };
}

function appendItemToTurn(turn: RemoteTurn, itemId: string): RemoteTurn {
  return turn.itemIds.includes(itemId) ? turn : { ...turn, itemIds: [...turn.itemIds, itemId] };
}

function appendBounded(current: string, delta: string, limit = 1_000_000): string {
  const next = current + delta;
  if (next.length <= limit) return next;
  const head = Math.floor(limit * 0.72);
  const tail = limit - head;
  return `${next.slice(0, head)}\n… 中间输出已截断 …\n${next.slice(-tail)}`;
}

function appendDelta(item: RemoteItem, target: string, delta: string): RemoteItem {
  switch (target) {
    case "agentMessage":
      return item.type === "agentMessage" ? { ...item, text: appendBounded(item.text, delta) } : item;
    case "reasoningSummary":
      return item.type === "reasoning"
        ? { ...item, summary: item.summary.length ? [...item.summary.slice(0, -1), appendBounded(item.summary.at(-1) ?? "", delta, 300_000)] : [delta.slice(0, 300_000)] }
        : item;
    case "reasoningText":
      return item.type === "reasoning"
        ? { ...item, content: item.content.length ? [...item.content.slice(0, -1), appendBounded(item.content.at(-1) ?? "", delta, 500_000)] : [delta.slice(0, 500_000)] }
        : item;
    case "plan":
      return item.type === "plan" ? { ...item, text: appendBounded(item.text, delta, 300_000) } : item;
    case "commandOutput":
      return item.type === "commandExecution" ? { ...item, output: appendBounded(item.output, delta) } : item;
    case "filePatch":
      return item.type === "fileChange" ? { ...item, patch: delta ? appendBounded("", delta, 2_000_000) : item.patch } : item;
    case "toolOutput":
      return item.type === "toolCall" ? { ...item, output: appendBounded(item.output ? `${item.output}\n` : "", delta) } : item;
    default:
      return item;
  }
}

export function applyEvent(current: RemoteState, envelope: EventEnvelope): RemoteState {
  if (current.seenEventIds[envelope.eventId] || envelope.sequence <= current.lastSequence) return current;

  const seenEventIds: Record<string, true> = { ...current.seenEventIds, [envelope.eventId]: true };
  const seenKeys = Object.keys(seenEventIds);
  if (seenKeys.length > 5_000) {
    for (const eventId of seenKeys.slice(0, seenKeys.length - 5_000)) delete seenEventIds[eventId];
  }

  const state: RemoteState = {
    ...current,
    threads: { ...current.threads },
    approvals: { ...current.approvals },
    processExpanded: { ...current.processExpanded },
    manualExpansion: { ...current.manualExpansion },
    seenEventIds,
    lastSequence: envelope.sequence,
  };
  const event = envelope.event;

  switch (event.method) {
    case "connection.status":
      state.connection = { phase: event.params.phase, message: event.params.message ?? "" };
      break;
    case "thread.list.snapshot": {
      state.nextThreadCursor = event.params.nextCursor;
      for (const summary of event.params.threads) {
        state.threads[summary.id] = { ...ensureThread(state, summary.id), ...summary };
      }
      const incoming = event.params.threads.map((thread) => thread.id);
      state.threadOrder = event.params.append
        ? [...state.threadOrder, ...incoming.filter((id) => !state.threadOrder.includes(id))]
        : incoming;
      break;
    }
    case "thread.snapshot":
      state.threads[event.params.thread.id] = event.params.thread;
      if (!state.threadOrder.includes(event.params.thread.id)) state.threadOrder = [event.params.thread.id, ...state.threadOrder];
      break;
    case "thread.upsert": {
      const summary = event.params.thread;
      state.threads[summary.id] = { ...ensureThread(state, summary.id), ...summary };
      state.threadOrder = [summary.id, ...state.threadOrder.filter((id) => id !== summary.id)];
      break;
    }
    case "thread.removed":
      delete state.threads[event.params.threadId];
      state.threadOrder = state.threadOrder.filter((id) => id !== event.params.threadId);
      if (state.activeThreadId === event.params.threadId) state.activeThreadId = null;
      break;
    case "turn.started": {
      const thread = { ...ensureThread(state, event.params.threadId) };
      const previous = thread.turns[event.params.turn.id];
      thread.turns = { ...thread.turns, [event.params.turn.id]: event.params.turn };
      if (previous?.diff && !event.params.turn.diff) thread.turns[event.params.turn.id] = { ...event.params.turn, diff: previous.diff };
      thread.turnIds = thread.turnIds.includes(event.params.turn.id) ? thread.turnIds : [...thread.turnIds, event.params.turn.id];
      thread.status = "active";
      state.threads[thread.id] = thread;
      state.processExpanded[event.params.turn.id] = true;
      break;
    }
    case "turn.completed": {
      const thread = { ...ensureThread(state, event.params.threadId) };
      const previous = thread.turns[event.params.turn.id];
      thread.turns = { ...thread.turns, [event.params.turn.id]: event.params.turn };
      if (previous?.diff && !event.params.turn.diff) thread.turns[event.params.turn.id] = { ...event.params.turn, diff: previous.diff };
      thread.turnIds = thread.turnIds.includes(event.params.turn.id) ? thread.turnIds : [...thread.turnIds, event.params.turn.id];
      thread.status = "idle";
      state.threads[thread.id] = thread;
      if (!(event.params.turn.id in state.manualExpansion)) state.processExpanded[event.params.turn.id] = false;
      break;
    }
    case "item.upsert": {
      const thread = { ...ensureThread(state, event.params.threadId) };
      const turn = thread.turns[event.params.turnId] ?? {
        id: event.params.turnId,
        status: "inProgress",
        itemIds: [],
        startedAt: null,
        completedAt: null,
        durationMs: null,
        error: null,
      };
      thread.turns = { ...thread.turns, [turn.id]: appendItemToTurn(turn, event.params.item.id) };
      thread.turnIds = thread.turnIds.includes(turn.id) ? thread.turnIds : [...thread.turnIds, turn.id];
      thread.items = { ...thread.items, [event.params.item.id]: event.params.item };
      state.threads[thread.id] = thread;
      break;
    }
    case "item.delta": {
      const thread = { ...ensureThread(state, event.params.threadId) };
      const existing = thread.items[event.params.itemId];
      if (existing) {
        thread.items = { ...thread.items, [existing.id]: appendDelta(existing, event.params.target, event.params.delta) };
        state.threads[thread.id] = thread;
      }
      break;
    }
    case "approval.requested":
      state.approvals[event.params.approval.id] = event.params.approval;
      break;
    case "approval.resolved":
      delete state.approvals[event.params.approvalId];
      break;
    case "error":
      state.lastError = event.params.message;
      break;
    case "turn.diff.updated":
      {
        const thread = { ...ensureThread(state, event.params.threadId) };
        const turn = thread.turns[event.params.turnId] ?? {
          id: event.params.turnId,
          status: "inProgress" as const,
          itemIds: [],
          startedAt: null,
          completedAt: null,
          durationMs: null,
          error: null,
        };
        thread.turns = { ...thread.turns, [turn.id]: { ...turn, diff: event.params.diff } };
        thread.turnIds = thread.turnIds.includes(turn.id) ? thread.turnIds : [...thread.turnIds, turn.id];
        state.threads[thread.id] = thread;
        break;
      }
    case "raw":
      break;
  }

  return state;
}

export function setActiveThread(state: RemoteState, threadId: string | null): RemoteState {
  return { ...state, activeThreadId: threadId };
}

export function setTurnExpanded(state: RemoteState, turnId: string, expanded: boolean): RemoteState {
  return {
    ...state,
    processExpanded: { ...state.processExpanded, [turnId]: expanded },
    manualExpansion: { ...state.manualExpansion, [turnId]: expanded },
  };
}

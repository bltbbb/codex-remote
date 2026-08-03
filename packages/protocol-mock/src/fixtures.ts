import type { RemoteThread, RemoteThreadSummary, RemoteTurn } from "@codex-remote/protocol";

const now = Math.floor(Date.now() / 1000);

export const fixtureThreads: RemoteThread[] = [
  {
    id: "thread-active",
    sessionId: "session-active",
    title: "Codex Remote 开发",
    preview: "实现手机远程控制 Codex",
    cwd: "E:\\myproject\\codex-remote",
    modelProvider: "custom",
    createdAt: now - 7_200,
    updatedAt: now,
    status: "idle",
    isPinned: true,
    source: "appServer",
    turnIds: ["turn-history"],
    turns: {
      "turn-history": {
        id: "turn-history",
        status: "completed",
        itemIds: ["user-history", "reasoning-history", "command-history", "agent-history"],
        startedAt: now - 120,
        completedAt: now - 112,
        durationMs: 8_000,
        error: null,
      },
    },
    items: {
      "user-history": { type: "userMessage", id: "user-history", turnId: "turn-history", status: "completed", text: "检查当前协议实现" },
      "reasoning-history": {
        type: "reasoning",
        id: "reasoning-history",
        turnId: "turn-history",
        status: "completed",
        summary: ["检查协议类型和事件顺序"],
        content: [],
      },
      "command-history": {
        type: "commandExecution",
        id: "command-history",
        turnId: "turn-history",
        status: "completed",
        command: "pnpm test",
        cwd: "E:\\myproject\\codex-remote",
        output: "全部测试通过\n",
        exitCode: 0,
        durationMs: 1_204,
      },
      "agent-history": {
        type: "agentMessage",
        id: "agent-history",
        turnId: "turn-history",
        status: "completed",
        text: "协议检查完成，所有测试均已通过。",
        phase: "final_answer",
      },
    },
  },
  {
    id: "thread-history-2",
    sessionId: "session-history-2",
    title: "Windows Bridge 设计",
    preview: "讨论 app-server WebSocket 接入",
    cwd: "E:\\myproject\\codex-remote",
    modelProvider: "custom",
    createdAt: now - 86_400,
    updatedAt: now - 3_600,
    status: "idle",
    isPinned: false,
    source: "appServer",
    turnIds: [],
    turns: {},
    items: {},
  },
  {
    id: "thread-history-3",
    sessionId: "session-history-3",
    title: "移动端界面研究",
    preview: "适配 iPhone 14 Pro Max",
    cwd: "E:\\myproject\\mobile-ui",
    modelProvider: "custom",
    createdAt: now - 172_800,
    updatedAt: now - 7_200,
    status: "idle",
    isPinned: false,
    source: "appServer",
    turnIds: [],
    turns: {},
    items: {},
  },
];

export function summary(thread: RemoteThread): RemoteThreadSummary {
  const { turnIds: _turnIds, turns: _turns, items: _items, ...value } = thread;
  return value;
}

export function emptyTurn(id: string): RemoteTurn {
  return {
    id,
    status: "inProgress",
    itemIds: [],
    startedAt: Math.floor(Date.now() / 1000),
    completedAt: null,
    durationMs: null,
    error: null,
  };
}


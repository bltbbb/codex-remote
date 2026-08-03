import { describe, expect, it } from "vitest";
import { applyEvent, createInitialState, setTurnExpanded } from "../src/state";
import type { EventEnvelope, RemoteTurn } from "../src/types";

function envelope(sequence: number, event: EventEnvelope["event"]): EventEnvelope {
  return { kind: "event", sequence, eventId: `event-${sequence}`, event };
}

function turn(status: RemoteTurn["status"]): RemoteTurn {
  return { id: "turn-1", status, itemIds: [], startedAt: 1, completedAt: null, durationMs: null, error: null };
}

describe("远程状态归约器", () => {
  it("运行时展开，完成后自动折叠", () => {
    let state = createInitialState();
    state = applyEvent(state, envelope(1, { method: "turn.started", params: { threadId: "thread-1", turn: turn("inProgress") } }));
    expect(state.processExpanded["turn-1"]).toBe(true);

    state = applyEvent(state, envelope(2, { method: "turn.completed", params: { threadId: "thread-1", turn: { ...turn("completed"), completedAt: 2 } } }));
    expect(state.processExpanded["turn-1"]).toBe(false);
  });

  it("尊重用户手动展开状态", () => {
    let state = createInitialState();
    state = applyEvent(state, envelope(1, { method: "turn.started", params: { threadId: "thread-1", turn: turn("inProgress") } }));
    state = setTurnExpanded(state, "turn-1", true);
    state = applyEvent(state, envelope(2, { method: "turn.completed", params: { threadId: "thread-1", turn: { ...turn("completed"), completedAt: 2 } } }));
    expect(state.processExpanded["turn-1"]).toBe(true);
  });

  it("丢弃重复和倒序事件", () => {
    let state = createInitialState();
    const first = envelope(1, { method: "connection.status", params: { phase: "online" } });
    state = applyEvent(state, first);
    const repeated = applyEvent(state, first);
    expect(repeated).toBe(state);
    const older = applyEvent(state, envelope(0, { method: "connection.status", params: { phase: "offline" } }));
    expect(older).toBe(state);
  });

  it("搜索快照替换顺序，分页快照追加顺序", () => {
    let state = createInitialState();
    const summary = (id: string) => ({ id, sessionId: id, title: id, preview: "", cwd: "E:\\repo", modelProvider: "test", createdAt: 1, updatedAt: 1, status: "idle", isPinned: false, source: null });
    state = applyEvent(state, envelope(1, { method: "thread.list.snapshot", params: { threads: [summary("a"), summary("b")], nextCursor: "next" } }));
    state = applyEvent(state, envelope(2, { method: "thread.list.snapshot", params: { threads: [summary("c")], nextCursor: null, append: true } }));
    expect(state.threadOrder).toEqual(["a", "b", "c"]);
    state = applyEvent(state, envelope(3, { method: "thread.list.snapshot", params: { threads: [summary("b")], nextCursor: null } }));
    expect(state.threadOrder).toEqual(["b"]);
  });

  it("保存回合级聚合差异", () => {
    let state = createInitialState();
    state = applyEvent(state, envelope(1, { method: "turn.started", params: { threadId: "thread-1", turn: turn("inProgress") } }));
    state = applyEvent(state, envelope(2, { method: "turn.diff.updated", params: { threadId: "thread-1", turnId: "turn-1", diff: "+ added" } }));
    expect(state.threads["thread-1"]?.turns["turn-1"]?.diff).toBe("+ added");
  });

  it("限制工具和命令流式输出的内存占用", () => {
    let state = createInitialState();
    state = applyEvent(state, envelope(1, {
      method: "item.upsert",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { type: "commandExecution", id: "command-1", turnId: "turn-1", status: "inProgress", command: "test", cwd: "E:\\repo", output: "", exitCode: null, durationMs: null },
      },
    }));
    state = applyEvent(state, envelope(2, { method: "item.delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "command-1", target: "commandOutput", delta: "x".repeat(1_200_000) } }));
    const output = state.threads["thread-1"]?.items["command-1"];
    expect(output?.type === "commandExecution" ? output.output.length : 0).toBeLessThan(1_100_000);
  });
});

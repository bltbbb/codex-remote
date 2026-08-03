import { describe, expect, it } from "vitest";
import type { ClientRequestEnvelope, EventEnvelope, ServerResponseEnvelope } from "@codex-remote/protocol";
import { MockEngine } from "../src/engine";

function request(method: ClientRequestEnvelope["method"], params: Record<string, unknown> = {}): ClientRequestEnvelope {
  return { kind: "request", id: `${method}-id`, method, params };
}

describe("协议模拟器", () => {
  it("隔离连接仍保持单调事件序号", () => {
    const engine = new MockEngine({ sequenceOffset: 10_000 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    engine.connect((message) => messages.push(message));
    const event = messages.find((message): message is EventEnvelope => message.kind === "event");
    expect(event?.sequence).toBe(10_001);
  });

  it("返回会话列表和快照事件", async () => {
    const engine = new MockEngine({ stepDelayMs: 0 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("thread.list"), (message) => messages.push(message));
    expect(messages.some((message) => message.kind === "response" && message.ok)).toBe(true);
    expect(messages.some((message) => message.kind === "event" && message.event.method === "thread.list.snapshot")).toBe(true);
  });

  it("返回工作区白名单，并拒绝白名单之外的新会话目录", async () => {
    const engine = new MockEngine({ stepDelayMs: 0 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("workspace.list"), (message) => messages.push(message));
    const workspaceResponse = messages.find((message): message is ServerResponseEnvelope => message.kind === "response" && message.ok);
    expect((workspaceResponse?.result as { workspaces?: unknown[] } | undefined)?.workspaces?.length).toBeGreaterThan(0);

    const rejected: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("thread.create", { cwd: "C:\\Windows" }), (message) => rejected.push(message));
    expect(rejected.find((message): message is ServerResponseEnvelope => message.kind === "response")?.error?.code).toBe("workspace_not_allowed");
  });

  it("完整产生运行、推理、消息和完成事件", async () => {
    const engine = new MockEngine({ stepDelayMs: 0 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("turn.start", { threadId: "thread-active", text: "运行测试命令" }), (message) => messages.push(message));
    const deadline = Date.now() + 1_000;
    while (
      Date.now() < deadline &&
      !messages.some((message) => message.kind === "event" && message.event.method === "turn.completed")
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const methods = messages.filter((message): message is EventEnvelope => message.kind === "event").map((message) => message.event.method);
    expect(methods).toContain("turn.started");
    expect(methods).toContain("item.delta");
    expect(methods).toContain("turn.completed");
  });

  it("产生文件差异事件，并对重复提交去重", async () => {
    const engine = new MockEngine({ stepDelayMs: 0 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    const params = { threadId: "thread-active", text: "请展示差异", clientRequestId: "same-submit" };
    await engine.handle({ kind: "request", id: "first", method: "turn.start", params }, (message) => messages.push(message));
    await engine.handle({ kind: "request", id: "second", method: "turn.start", params }, (message) => messages.push(message));
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !messages.some((message) => message.kind === "event" && message.event.method === "turn.completed")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(messages.filter((message) => message.kind === "event" && message.event.method === "turn.started")).toHaveLength(1);
    expect(messages.some((message) => message.kind === "event" && message.event.method === "turn.diff.updated")).toBe(true);
    expect(messages.some((message) => message.kind === "response" && message.id === "second" && (message.result as { deduplicated?: boolean }).deduplicated)).toBe(true);
  });

  it("覆盖工具调用失败状态", async () => {
    const engine = new MockEngine({ stepDelayMs: 0 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("turn.start", { threadId: "thread-active", text: "请调用工具并失败" }), (message) => messages.push(message));
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && !messages.some((message) => message.kind === "event" && message.event.method === "turn.completed")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const toolEvents = messages.filter((message): message is EventEnvelope => message.kind === "event" && message.event.method === "item.upsert" && message.event.params.item.type === "toolCall");
    expect(toolEvents.some((event) => event.event.method === "item.upsert" && event.event.params.item.status === "failed")).toBe(true);
  });

  it("拒绝审批后产生失败回合", async () => {
    const engine = new MockEngine({ stepDelayMs: 0 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("turn.start", { threadId: "thread-active", text: "申请审批" }), (message) => messages.push(message));
    const deadline = Date.now() + 1_000;
    let approvalId = "";
    while (Date.now() < deadline && !approvalId) {
      const approval = messages.find((message): message is EventEnvelope => message.kind === "event" && message.event.method === "approval.requested");
      if (approval?.event.method === "approval.requested") approvalId = approval.event.params.approval.id;
      if (!approvalId) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(approvalId).not.toBe("");
    await engine.handle(request("approval.resolve", { approvalId, decision: "decline" }), (message) => messages.push(message));
    while (Date.now() < deadline && !messages.some((message) => message.kind === "event" && message.event.method === "turn.completed")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const completed = messages.find((message): message is EventEnvelope => message.kind === "event" && message.event.method === "turn.completed");
    expect(completed?.event.method === "turn.completed" ? completed.event.params.turn.status : null).toBe("failed");
  });

  it("停止回合后不再继续生成完成消息，并可重放断线期间事件", async () => {
    const engine = new MockEngine({ stepDelayMs: 20 });
    const messages: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("turn.start", { threadId: "thread-active", text: "长任务" }), (message) => messages.push(message));
    const started = messages.find((message): message is EventEnvelope => message.kind === "event" && message.event.method === "turn.started");
    if (!started || started.event.method !== "turn.started") throw new Error("未产生 turn.started");
    await engine.handle(request("turn.interrupt", { threadId: "thread-active", turnId: started.event.params.turn.id }), (message) => messages.push(message));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const completions = messages.filter((message): message is EventEnvelope => message.kind === "event" && message.event.method === "turn.completed");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.event.method === "turn.completed" ? completions[0].event.params.turn.status : null).toBe("interrupted");

    const replay: Array<EventEnvelope | ServerResponseEnvelope> = [];
    await engine.handle(request("events.resume", { afterSequence: 0 }), (message) => replay.push(message));
    const response = replay.find((message): message is ServerResponseEnvelope => message.kind === "response" && message.ok);
    expect(Array.isArray((response?.result as { events?: unknown[] } | undefined)?.events)).toBe(true);
  });
});

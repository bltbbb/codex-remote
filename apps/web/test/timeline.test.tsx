import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Timeline } from "../src/components/Timeline";
import type { RemoteThread } from "@codex-remote/protocol";

const thread: RemoteThread = {
  id: "thread-1",
  sessionId: "session-1",
  title: "测试会话",
  preview: "",
  cwd: "E:\\test",
  modelProvider: "custom",
  createdAt: 1,
  updatedAt: 2,
  status: "idle",
  isPinned: false,
  source: "appServer",
  turnIds: ["turn-1"],
  turns: {
    "turn-1": { id: "turn-1", status: "completed", itemIds: ["user", "reasoning", "agent"], startedAt: 1, completedAt: 2, durationMs: 1_000, error: null },
  },
  items: {
    user: { type: "userMessage", id: "user", turnId: "turn-1", status: "completed", text: "用户问题" },
    reasoning: { type: "reasoning", id: "reasoning", turnId: "turn-1", status: "completed", summary: ["推理摘要"], content: [] },
    agent: { type: "agentMessage", id: "agent", turnId: "turn-1", status: "completed", text: "最终回答", phase: "final_answer" },
  },
};

describe("会话时间线", () => {
  it("已完成回合默认折叠过程，点击后展开", async () => {
    const onToggle = vi.fn();
    const { rerender } = render(<Timeline thread={thread} expanded={{ "turn-1": false }} onToggleExpanded={onToggle} onRetry={() => undefined} />);
    expect(screen.getByText("用户问题")).toBeInTheDocument();
    expect(screen.getByText("最终回答")).toBeInTheDocument();
    expect(screen.queryByText("推理摘要")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /已处理/ }));
    expect(onToggle).toHaveBeenCalledWith("turn-1", true);
    rerender(<Timeline thread={thread} expanded={{ "turn-1": true }} onToggleExpanded={onToggle} onRetry={() => undefined} />);
    expect(screen.getByText("推理摘要")).toBeInTheDocument();
  });

  it("失败回合可以用原消息重试", async () => {
    const onRetry = vi.fn();
    const failedThread: RemoteThread = {
      ...thread,
      turns: { "turn-1": { ...thread.turns["turn-1"]!, status: "failed", error: "测试失败" } },
    };
    render(<Timeline thread={failedThread} expanded={{ "turn-1": false }} onToggleExpanded={() => undefined} onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetry).toHaveBeenCalledWith("用户问题");
  });

  it("显示回合总耗时，并把英文内部摘要转换为中文", async () => {
    const englishThread: RemoteThread = {
      ...thread,
      items: {
        ...thread.items,
        reasoning: {
          type: "reasoning",
          id: "reasoning",
          turnId: "turn-1",
          status: "completed",
          summary: ["**Verifying user message and bridge status**", "**Planning next action**"],
          content: [],
        },
      },
    };
    render(<Timeline thread={englishThread} expanded={{ "turn-1": true }} onToggleExpanded={() => undefined} onRetry={() => undefined} />);

    expect(screen.getByText("1 秒")).toBeInTheDocument();
    expect(screen.getByText(/正在验证当前状态/)).toBeInTheDocument();
    expect(screen.getByText(/正在规划下一步/)).toBeInTheDocument();
    expect(screen.getByText("查看原始摘要")).toBeInTheDocument();
  });

  it("会话读取期间显示明确的消息骨架屏", () => {
    render(<Timeline thread={thread} loading expanded={{}} onToggleExpanded={() => undefined} onRetry={() => undefined} />);
    expect(screen.getByRole("status", { name: "正在加载会话消息" })).toBeInTheDocument();
    expect(screen.queryByText("最终回答")).not.toBeInTheDocument();
  });

  it("回合刚开始且尚无步骤时保持连续的执行状态", () => {
    const runningThread: RemoteThread = {
      ...thread,
      turnIds: ["running"],
      turns: {
        running: { id: "running", status: "inProgress", itemIds: [], startedAt: Math.floor(Date.now() / 1_000), completedAt: null, durationMs: null, error: null },
      },
      items: {},
    };
    render(<Timeline thread={runningThread} expanded={{}} onToggleExpanded={() => undefined} onRetry={() => undefined} />);
    expect(screen.getByRole("status", { name: "Codex 正在执行" })).toBeInTheDocument();
    expect(screen.getByText("正在准备会话上下文")).toBeInTheDocument();
  });

  it("最终回复出现前把过程回复和工具按事件顺序平铺", () => {
    const runningThread: RemoteThread = {
      ...thread,
      turnIds: ["running"],
      turns: {
        running: { id: "running", status: "inProgress", itemIds: ["user", "commentary", "reasoning"], startedAt: Math.floor(Date.now() / 1_000), completedAt: null, durationMs: null, error: null },
      },
      items: {
        user: { type: "userMessage", id: "user", turnId: "running", status: "completed", text: "开始任务" },
        commentary: { type: "agentMessage", id: "commentary", turnId: "running", status: "completed", text: "先检查当前状态，再继续修改。", phase: "commentary" },
        reasoning: { type: "reasoning", id: "reasoning", turnId: "running", status: "inProgress", summary: ["检查状态"], content: [] },
      },
    };
    const { container } = render(<Timeline thread={runningThread} expanded={{ running: true }} onToggleExpanded={() => undefined} onRetry={() => undefined} />);

    expect(screen.getByText("先检查当前状态，再继续修改。")).toBeInTheDocument();
    expect(container.querySelector(".process-flow-live .process-commentary")).toBeInTheDocument();
    expect(container.querySelector(".final-answer-row")).not.toBeInTheDocument();
  });

  it("第一段最终回复出现后立即折叠整个过程", () => {
    const streamingThread: RemoteThread = {
      ...thread,
      turnIds: ["running"],
      turns: {
        running: { id: "running", status: "inProgress", itemIds: ["user", "reasoning", "commentary", "final"], startedAt: Math.floor(Date.now() / 1_000), completedAt: null, durationMs: null, error: null },
      },
      items: {
        user: { type: "userMessage", id: "user", turnId: "running", status: "completed", text: "开始任务" },
        reasoning: { type: "reasoning", id: "reasoning", turnId: "running", status: "completed", summary: ["检查状态"], content: [] },
        commentary: { type: "agentMessage", id: "commentary", turnId: "running", status: "completed", text: "过程中的回复", phase: "commentary" },
        final: { type: "agentMessage", id: "final", turnId: "running", status: "inProgress", text: "这是最终回复的第一段。", phase: "final_answer" },
      },
    };
    const { container } = render(<Timeline thread={streamingThread} expanded={{ running: true }} onToggleExpanded={() => undefined} onRetry={() => undefined} />);

    expect(screen.getByText("这是最终回复的第一段。")).toBeInTheDocument();
    expect(screen.queryByText("过程中的回复")).not.toBeInTheDocument();
    expect(screen.getByTestId("process-summary-running")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".process-live-body")).not.toBeInTheDocument();
  });

  it("长历史只挂载可视窗口内的回合", () => {
    const turnIds = Array.from({ length: 120 }, (_, index) => `turn-${index}`);
    const turns = Object.fromEntries(turnIds.map((id) => [id, {
      id,
      status: "completed" as const,
      itemIds: [],
      startedAt: 1,
      completedAt: 2,
      durationMs: 1_000,
      error: null,
    }]));
    const longThread: RemoteThread = { ...thread, turnIds, turns, items: {} };
    const { container } = render(<Timeline thread={longThread} expanded={{}} onToggleExpanded={() => undefined} onRetry={() => undefined} scrollTop={0} viewportHeight={600} />);
    expect(container.querySelector(".timeline")).toHaveAttribute("data-virtualized", "true");
    expect(container.querySelectorAll(".turn").length).toBeLessThan(turnIds.length);
  });
});

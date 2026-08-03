import { describe, expect, it } from "vitest";
import { normalizeCodexNotification, normalizeItem } from "../src/normalize";

describe("Codex 事件规范化", () => {
  it("保留 MCP 工具进度和文件差异输出", () => {
    expect(normalizeCodexNotification("item/mcpToolCall/progress", {
      threadId: "thread-1", turnId: "turn-1", itemId: "tool-1", message: "仍在处理",
    })).toEqual({ method: "item.delta", params: { threadId: "thread-1", turnId: "turn-1", itemId: "tool-1", target: "toolOutput", delta: "仍在处理" } });
    expect(normalizeCodexNotification("item/fileChange/patchUpdated", {
      threadId: "thread-1", turnId: "turn-1", itemId: "file-1", changes: [{ path: "a.ts", additions: 1 }],
    })).toMatchObject({ method: "item.delta", params: { target: "filePatch" } });
    expect(normalizeCodexNotification("turn/plan/updated", {
      threadId: "thread-1", turnId: "turn-1", plan: [{ step: "检查", status: "inProgress" }],
    })).toMatchObject({ method: "item.upsert", params: { item: { type: "plan", id: "plan-turn-1" } } });
  });

  it("把真实用户输入内容和附件占位符归一化", () => {
    const item = normalizeItem({
      id: "user-1",
      type: "userMessage",
      content: [{ type: "text", text: "请查看" }, { type: "image", url: "data:image/png;base64,AA==" }],
    }, "turn-1");
    expect(item.type === "userMessage" ? item.text : "").toBe("请查看\n[图片]");
  });
});

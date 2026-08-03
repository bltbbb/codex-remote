import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DiffView, parseUnifiedDiff } from "../src/components/DiffView";
import { Markdown } from "../src/components/Markdown";

describe("阶段 6 文本与差异渲染", () => {
  it("渲染标题、强调、链接和 fenced code block", () => {
    render(<Markdown value={"# 标题\n\n**重点** 与 `pnpm test`。\n\n```ts\nconst ok = true;\n```"} />);
    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByText("重点")).toBeInTheDocument();
    expect(screen.getByText("const ok = true;")).toBeInTheDocument();
    expect(document.querySelector(".markdown-code code")).toHaveAttribute("data-language", "ts");
  });

  it("解析 unified diff 的行号和增删统计", () => {
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+last";
    const lines = parseUnifiedDiff(diff);
    expect(lines.filter((line) => line.kind === "add")).toHaveLength(2);
    expect(lines.find((line) => line.kind === "remove")?.oldLine).toBe(2);
    render(<DiffView value={diff} />);
    expect(screen.getByText("+2")).toBeInTheDocument();
    expect(screen.getByText("−1")).toBeInTheDocument();
  });
});

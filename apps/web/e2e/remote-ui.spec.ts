import { expect, test } from "@playwright/test";

test("历史会话、流式过程、审批与完成折叠", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("电脑在线", { exact: true })).toBeVisible();

  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await threadRows.first().click();
  await expect(page.getByTestId("composer-input")).toBeEnabled();
  await expect(page.getByText("协议检查完成，所有测试均已通过。", { exact: true })).toBeVisible();

  await page.getByTestId("composer-input").fill("请运行测试命令并申请审批");
  await page.getByTestId("composer-input").press("Enter");
  const approvalDialog = page.getByRole("dialog", { name: "批准命令执行" });
  await expect(approvalDialog).toBeVisible({ timeout: 15_000 });
  const runningTurn = page.locator('[data-turn-status="inProgress"]').last();
  await expect(runningTurn.locator(".process-flow-live .process-commentary")).toContainText("正在整理执行进度");
  await approvalDialog.getByRole("button", { name: "允许", exact: true }).click();
  await expect(page.getByText("任务已完成，当前会话状态和事件流均已同步。", { exact: true })).toBeVisible();

  const turns = page.locator('[data-turn-status="completed"]');
  const latestTurn = turns.last();
  await expect(latestTurn.locator('[data-testid^="process-summary-"]')).toHaveAttribute("aria-expanded", "false");
  await expect(latestTurn.locator(".process-live-body")).toHaveCount(0);
});

test("阶段 6：差异、工作区选择和附件入口可用", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("thread-row-thread-active").click();
  await page.getByTestId("composer-input").fill("请展示差异");
  await page.getByTestId("composer-input").press("Enter");
  await expect(page.getByText("任务已完成，当前会话状态和事件流均已同步。", { exact: true })).toBeVisible({ timeout: 15_000 });
  const latestTurn = page.locator(".turn").last();
  await expect(latestTurn).toHaveAttribute("data-turn-status", "completed");
  const latestSummary = latestTurn.locator('[data-testid^="process-summary-"]');
  await latestSummary.click();
  await page.getByText("编辑了文件", { exact: true }).click();
  await expect(page.getByText("文件差异", { exact: true })).toBeVisible();
  await expect(page.locator(".diff-line-add")).toHaveCount(1);

  await page.getByRole("button", { name: "新建会话", exact: false }).click();
  await expect(page.getByRole("dialog", { name: "选择电脑工作区" })).toBeVisible();
  await expect(page.getByRole("dialog").locator(".workspace-options button")).toHaveCount(2);
  await page.getByRole("button", { name: /codex-remote/ }).last().click();
  await expect(page.getByTestId("composer-input")).toBeEnabled();

  const attachmentInput = page.locator('input[type="file"]');
  await attachmentInput.setInputFiles({ name: "notes.md", mimeType: "text/markdown", buffer: Buffer.from("# 附件") });
  await expect(page.getByText(/notes\.md/)).toBeVisible();
});

test("iPhone 14 Pro Max 断点没有横向溢出且侧栏可开合", async ({ page }) => {
  await page.setViewportSize({ width: 430, height: 932 });
  await page.goto("/");
  await expect(page.getByText("电脑在线", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "打开侧栏", exact: true })).toBeVisible();

  await expect.poll(async () => page.locator(".sidebar").evaluate((element) => element.getBoundingClientRect().right)).toBeLessThanOrEqual(0);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/sidebar-open/);
  await expect.poll(async () => page.locator(".sidebar").evaluate((element) => Math.round(element.getBoundingClientRect().left))).toBe(0);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

  await page.getByRole("button", { name: "关闭侧栏", exact: true }).click();
  await expect(page.locator(".sidebar")).not.toHaveClass(/sidebar-open/);
});

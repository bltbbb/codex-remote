import { expect, test } from "@playwright/test";

test("iPhone 14 Pro Max 视口、输入框和安全高度适配", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("电脑在线", { exact: true })).toBeVisible();

  const input = page.getByTestId("composer-input");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();
  await expect(input).toBeEnabled();

  await expect.poll(
    async () => input.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize)),
    { timeout: 15_000 },
  ).toBeGreaterThanOrEqual(16);
  await expect.poll(async () => page.locator(".app-shell").evaluate((element) => {
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    return Math.abs(element.getBoundingClientRect().height - viewportHeight);
  })).toBeLessThanOrEqual(2);
  await expect.poll(async () => page.locator(".app-shell").evaluate((element) => {
    const viewportWidth = window.visualViewport?.width ?? window.innerWidth;
    return Math.abs(element.getBoundingClientRect().width - viewportWidth);
  })).toBeLessThanOrEqual(2);

  const narrowedViewport = await page.evaluate(() => {
    const viewport = window.visualViewport;
    if (!viewport) return null;
    Object.defineProperty(viewport, "width", { configurable: true, value: 414 });
    viewport.dispatchEvent(new Event("resize"));
    return viewport.width;
  });
  expect(narrowedViewport).toBe(414);
  await expect.poll(async () => page.locator(".app-shell").evaluate((element) => Math.abs(element.getBoundingClientRect().width - 414))).toBeLessThanOrEqual(1);
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await expect.poll(async () => page.locator(".timeline").evaluate((element) => {
    const visibleRight = (window.visualViewport?.offsetLeft ?? 0) + (window.visualViewport?.width ?? window.innerWidth);
    return Math.round(visibleRight - element.getBoundingClientRect().right);
  })).toBeGreaterThanOrEqual(32);
  await expect.poll(async () => page.locator(".composer").evaluate((element) => {
    const visibleRight = (window.visualViewport?.offsetLeft ?? 0) + (window.visualViewport?.width ?? window.innerWidth);
    return Math.round(visibleRight - element.getBoundingClientRect().right);
  })).toBeGreaterThanOrEqual(32);
  await expect.poll(async () => page.locator(".connection-pill").evaluate((element) => {
    const visibleRight = (window.visualViewport?.offsetLeft ?? 0) + (window.visualViewport?.width ?? window.innerWidth);
    return Math.floor(visibleRight - element.getBoundingClientRect().right);
  })).toBeGreaterThanOrEqual(32);

  const sendButton = page.getByRole("button", { name: "发送消息" });
  await expect.poll(async () => sendButton.evaluate((button) => {
    const buttonRect = button.getBoundingClientRect();
    const iconRect = button.querySelector("svg")?.getBoundingClientRect();
    if (!iconRect) return 99;
    const horizontal = Math.abs(buttonRect.left + buttonRect.width / 2 - iconRect.left - iconRect.width / 2);
    const vertical = Math.abs(buttonRect.top + buttonRect.height / 2 - iconRect.top - iconRect.height / 2);
    return Math.max(horizontal, vertical);
  })).toBeLessThanOrEqual(1);

  const longMessage = `NATIVE_HOST_${"PHONE_OK_".repeat(30)}`;
  await input.fill(longMessage);
  await input.press("Enter");
  await expect(page.getByText(longMessage, { exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("Wi-Fi 与蜂窝网络切换后恢复连接和当前会话", async ({ page, context }) => {
  await page.addInitScript(() => window.localStorage.setItem("codex-remote-device-token", "mobile-webkit-test-token"));
  await page.goto("/");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();
  const activeTitle = await page.locator(".thread-heading strong").innerText();
  await expect(page.getByTestId("composer-input")).toBeEnabled();
  await page.evaluate(() => {
    window.sessionStorage.setItem("reconnect-skeleton-seen", "0");
    const observer = new MutationObserver(() => {
      if (document.querySelector(".timeline-loading")) window.sessionStorage.setItem("reconnect-skeleton-seen", "1");
    });
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
  });

  await context.setOffline(true);
  await expect(page.getByText("手机网络不可用", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "已配对", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "配对", exact: true })).toHaveCount(0);

  await context.setOffline(false);
  await expect(page.getByText("电脑在线", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".thread-heading strong")).toHaveText(activeTitle);
  await expect(page.getByTestId("composer-input")).toBeEnabled();
  expect(await page.evaluate(() => window.sessionStorage.getItem("reconnect-skeleton-seen"))).toBe("0");
});

test("Safari 从后台返回时保留会话且不重新读取线程", async ({ page }) => {
  const sentMethods: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", (event) => {
      if (typeof event.payload !== "string") return;
      try {
        const message = JSON.parse(event.payload) as { method?: string };
        if (message.method) sentMethods.push(message.method);
      } catch {
        // 忽略非 JSON 帧。
      }
    });
  });

  await page.goto("/");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();
  await expect(page.getByText("协议检查完成，所有测试均已通过。", { exact: true })).toBeVisible();
  const activeTitle = await page.locator(".thread-heading strong").innerText();

  sentMethods.length = 0;
  await page.evaluate(() => {
    window.sessionStorage.setItem("background-skeleton-seen", "0");
    const observer = new MutationObserver(() => {
      if (document.querySelector(".timeline-loading")) window.sessionStorage.setItem("background-skeleton-seen", "1");
    });
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });

    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    now += 6_000;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
    Date.now = realNow;
  });

  await expect(page.getByText("电脑在线", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".thread-heading strong")).toHaveText(activeTitle);
  await expect(page.getByText("协议检查完成，所有测试均已通过。", { exact: true })).toBeVisible();
  expect(sentMethods.filter((method) => method === "thread.read")).toHaveLength(0);
  expect(await page.evaluate(() => window.sessionStorage.getItem("background-skeleton-seen"))).toBe("0");
  await expect(page.getByText(/远程请求超时：thread\.read/)).toHaveCount(0);
});

test("Safari 回收页面进程后从标签页快照立即恢复会话", async ({ page }) => {
  await page.goto("/");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();
  await expect(page.getByText("协议检查完成，所有测试均已通过。", { exact: true })).toBeVisible();
  const activeTitle = await page.locator(".thread-heading strong").innerText();

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = window.sessionStorage.getItem("codex-remote-active-thread-snapshot");
    return Boolean(snapshot?.includes("协议检查完成，所有测试均已通过。"));
  })).toBe(true);

  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("watch-session-restore") !== "1") return;
    window.sessionStorage.setItem("session-restore-skeleton-seen", "0");
    const observer = new MutationObserver(() => {
      if (document.querySelector(".timeline-loading")) {
        window.sessionStorage.setItem("session-restore-skeleton-seen", "1");
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page.evaluate(() => window.sessionStorage.setItem("watch-session-restore", "1"));
  await page.reload();

  await expect(page.locator(".thread-heading strong")).toHaveText(activeTitle);
  await expect(page.getByText("协议检查完成，所有测试均已通过。", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.sessionStorage.getItem("session-restore-skeleton-seen"))).toBe("0");
  await expect(page.getByTestId("composer-input")).toBeEnabled({ timeout: 15_000 });
});

test("手机可以新建会话并立即发送消息", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("电脑在线", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();

  await page.getByRole("button", { name: "新建会话", exact: false }).click();
  const workspaceDialog = page.getByRole("dialog", { name: "选择电脑工作区" });
  await expect(workspaceDialog).toBeVisible();
  await workspaceDialog.getByRole("button", { name: /codex-remote/ }).click();
  await expect(page.locator(".thread-heading strong")).toHaveText("新会话");

  const input = page.getByTestId("composer-input");
  await expect(input).toBeEnabled();
  await input.fill("新会话手机验收");
  await input.press("Enter");
  await expect(page.getByText("新会话手机验收", { exact: true })).toBeVisible();

  const createdThreadId = await page.evaluate(() => window.localStorage.getItem("codex-remote-active-thread"));
  expect(createdThreadId).toBeTruthy();
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await expect(page.getByTestId(`thread-row-${createdThreadId}`)).toBeVisible();
});

test("手机可以停止正在运行的任务", async ({ page }) => {
  await page.goto("/");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();

  const input = page.getByTestId("composer-input");
  await input.fill("执行一个长任务等待手机停止");
  await input.press("Enter");
  const stopButton = page.getByRole("button", { name: "停止任务", exact: true });
  await expect(stopButton).toBeVisible();
  await stopButton.click();

  await expect(page.locator('[data-turn-status="interrupted"]')).toHaveCount(1);
  await expect(stopButton).toHaveCount(0);
  await expect(page.getByText("任务已完成，当前会话状态和事件流均已同步。", { exact: true })).toHaveCount(0);
});

test("手机拒绝审批后回合明确失败", async ({ page }) => {
  await page.goto("/");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();

  const input = page.getByTestId("composer-input");
  await input.fill("申请审批并由手机拒绝");
  await input.press("Enter");
  const approvalDialog = page.getByRole("dialog", { name: "批准命令执行" });
  await expect(approvalDialog).toBeVisible();
  await approvalDialog.getByRole("button", { name: "拒绝", exact: true }).click();

  await expect(page.getByText("操作已被拒绝。", { exact: true })).toBeVisible();
  await expect(page.locator('[data-turn-status="failed"]')).toHaveCount(1);
  await expect(approvalDialog).toHaveCount(0);
});

test("发送慢任务后自动跟随到最新回复", async ({ page }) => {
  await page.goto("/");
  const threadRows = page.locator('[data-testid^="thread-row-"]');
  await expect(threadRows).toHaveCount(3);
  await page.getByRole("button", { name: "打开侧栏", exact: true }).click();
  await threadRows.first().click();

  const input = page.getByTestId("composer-input");
  await input.fill("手机滚动测试并申请审批");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  const approvalDialog = page.getByRole("dialog", { name: "批准命令执行" });
  await expect(approvalDialog).toBeVisible();
  const runningTurn = page.locator('[data-turn-status="inProgress"]').last();
  await expect(runningTurn.locator(".process-flow-live .process-commentary")).toContainText("正在整理执行进度");
  await approvalDialog.getByRole("button", { name: "允许", exact: true }).click();
  await expect(page.getByText("任务已完成，当前会话状态和事件流均已同步。", { exact: true })).toBeVisible();
  const latestTurn = page.locator('[data-turn-status="completed"]').last();
  await expect(latestTurn.locator('[data-testid^="process-summary-"]')).toHaveAttribute("aria-expanded", "false");
  await expect(latestTurn.locator(".process-live-body")).toHaveCount(0);
  await expect(page.locator("#timeline-end")).toBeInViewport();
});

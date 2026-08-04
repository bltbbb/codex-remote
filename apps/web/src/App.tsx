import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyEvent,
  createInitialState,
  createRemoteId,
  setActiveThread,
  setTurnExpanded,
  type EventEnvelope,
  type RemoteAttachment,
  type RemoteItem,
  type RemoteThread,
  type RemoteThreadSummary,
  type RemoteWorkspace,
} from "@codex-remote/protocol";
import { RemoteClient } from "./client";
import { resolveBridgeUrls } from "./bridge-url";
import { ApprovalPanel } from "./components/ApprovalPanel";
import { Composer } from "./components/Composer";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { Timeline } from "./components/Timeline";
import { WorkspacePicker } from "./components/WorkspacePicker";

const { webSocketUrl: defaultUrl, httpUrl: bridgeHttpUrl } = resolveBridgeUrls(
  window.location,
  import.meta.env.VITE_BRIDGE_URL,
  import.meta.env.VITE_BRIDGE_HTTP_URL,
);

const THREAD_CACHE_KEY = "codex-remote-thread-summaries";
const ACTIVE_THREAD_KEY = "codex-remote-active-thread";
const ACTIVE_THREAD_SNAPSHOT_KEY = "codex-remote-active-thread-snapshot";
const THREAD_READ_TIMEOUT_MS = 120_000;
const MAX_SNAPSHOT_SIZE = 1_500_000;

function truncateText(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n[内容已截断]`;
}

function compactItem(item: RemoteItem): RemoteItem {
  switch (item.type) {
    case "userMessage":
    case "agentMessage":
      return { ...item, text: truncateText(item.text, 100_000) };
    case "reasoning":
      return { ...item, summary: item.summary.map((part) => truncateText(part, 20_000)), content: [] };
    case "plan":
      return { ...item, text: truncateText(item.text, 50_000) };
    case "commandExecution":
      return { ...item, output: truncateText(item.output, 20_000) };
    case "fileChange":
      return { ...item, changes: item.changes.slice(0, 100), patch: truncateText(item.patch, 20_000) };
    case "toolCall":
      return { ...item, arguments: null, output: truncateText(item.output, 20_000) };
    case "unknown":
      return { ...item, data: {} };
  }
}

function compactThreadSnapshot(thread: RemoteThread, turnLimit: number): RemoteThread {
  const turnIds = thread.turnIds.slice(-turnLimit);
  const turns: RemoteThread["turns"] = {};
  const items: RemoteThread["items"] = {};
  for (const turnId of turnIds) {
    const turn = thread.turns[turnId];
    if (!turn) continue;
    const itemIds = turn.itemIds.filter((itemId) => Boolean(thread.items[itemId]));
    turns[turnId] = { ...turn, itemIds, diff: turn.diff ? truncateText(turn.diff, 20_000) : undefined };
    for (const itemId of itemIds) items[itemId] = compactItem(thread.items[itemId]!);
  }
  return { ...thread, turnIds: turnIds.filter((turnId) => Boolean(turns[turnId])), turns, items };
}

function readActiveThreadSnapshot(): RemoteThread | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(ACTIVE_THREAD_SNAPSHOT_KEY) ?? "null") as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const thread = parsed as Partial<RemoteThread>;
    if (typeof thread.id !== "string" || !Array.isArray(thread.turnIds) || !thread.turns || !thread.items) return null;
    return thread as RemoteThread;
  } catch {
    window.sessionStorage.removeItem(ACTIVE_THREAD_SNAPSHOT_KEY);
    return null;
  }
}

function saveActiveThreadSnapshot(thread: RemoteThread): void {
  for (let turnLimit = Math.min(12, thread.turnIds.length || 1); turnLimit >= 1; turnLimit -= 1) {
    const serialized = JSON.stringify(compactThreadSnapshot(thread, turnLimit));
    if (serialized.length > MAX_SNAPSHOT_SIZE) continue;
    try {
      window.sessionStorage.setItem(ACTIVE_THREAD_SNAPSHOT_KEY, serialized);
      return;
    } catch {
      // 存储空间不足时继续尝试更少的回合。
    }
  }
}

function summaryToThread(summary: RemoteThreadSummary): RemoteThread {
  return { ...summary, turnIds: [], turns: {}, items: {} };
}

function createCachedInitialState(): ReturnType<typeof createInitialState> {
  const initial = createInitialState();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(THREAD_CACHE_KEY) ?? "[]") as unknown;
    if (!Array.isArray(parsed)) return initial;
    for (const value of parsed.slice(0, 100)) {
      if (!value || typeof value !== "object") continue;
      const item = value as Record<string, unknown>;
      if (typeof item.id !== "string" || typeof item.title !== "string" || typeof item.cwd !== "string") continue;
      const summary: RemoteThreadSummary = {
        id: item.id,
        sessionId: typeof item.sessionId === "string" ? item.sessionId : "",
        title: item.title,
        preview: typeof item.preview === "string" ? item.preview : "",
        cwd: item.cwd,
        modelProvider: typeof item.modelProvider === "string" ? item.modelProvider : "",
        createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        status: typeof item.status === "string" ? item.status : "idle",
        isPinned: item.isPinned === true,
        source: null,
      };
      initial.threads[summary.id] = summaryToThread(summary);
      initial.threadOrder.push(summary.id);
    }
  } catch {
    window.localStorage.removeItem(THREAD_CACHE_KEY);
  }
  const activeThreadId = window.localStorage.getItem(ACTIVE_THREAD_KEY);
  const activeSnapshot = readActiveThreadSnapshot();
  if (activeThreadId && activeSnapshot?.id === activeThreadId) {
    initial.threads[activeThreadId] = activeSnapshot;
    if (!initial.threadOrder.includes(activeThreadId)) initial.threadOrder.unshift(activeThreadId);
    initial.activeThreadId = activeThreadId;
  } else if (activeThreadId && initial.threads[activeThreadId]) {
    initial.activeThreadId = activeThreadId;
  }
  return initial;
}

export default function App(): React.JSX.Element {
  const [state, setState] = useState(createCachedInitialState);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [historySyncing, setHistorySyncing] = useState(false);
  const [threadLoadingId, setThreadLoadingId] = useState<string | null>(null);
  const [workspaceChoices, setWorkspaceChoices] = useState<RemoteWorkspace[] | null>(null);
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [paired, setPaired] = useState(() => Boolean(window.localStorage.getItem("codex-remote-device-token")));
  const [followOutput, setFollowOutput] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);
  const [scrollMetrics, setScrollMetrics] = useState({ top: 0, height: 800 });
  const [initialDisplayedThreadIds] = useState<Set<string>>(() => {
    const threadId = readActiveThreadSnapshot()?.id;
    return new Set(threadId ? [threadId] : []);
  });
  const clientRef = useRef<RemoteClient | null>(null);
  const conversationRef = useRef<HTMLDivElement | null>(null);
  const scrollSettleFrameRef = useRef<number | null>(null);
  const scrollSettleTimerRef = useRef<number | null>(null);
  const loadedThreadIdsRef = useRef<Set<string>>(new Set());
  const displayedThreadIdsRef = useRef<Set<string>>(initialDisplayedThreadIds);
  const needsFullRestoreRef = useRef(true);
  const activeThreadIdRef = useRef<string | null>(state.activeThreadId);
  const atBottomRef = useRef(true);
  const unreadCountRef = useRef(0);
  const pendingSubmissionRef = useRef<{ threadId: string; fingerprint: string; clientRequestId: string } | null>(null);

  useEffect(() => {
    activeThreadIdRef.current = state.activeThreadId;
  }, [state.activeThreadId]);

  function cancelPendingScrollSettling(): void {
    if (scrollSettleFrameRef.current != null) {
      window.cancelAnimationFrame(scrollSettleFrameRef.current);
      scrollSettleFrameRef.current = null;
    }
    if (scrollSettleTimerRef.current != null) {
      window.clearTimeout(scrollSettleTimerRef.current);
      scrollSettleTimerRef.current = null;
    }
  }

  function syncConversationToEnd(): void {
    const element = conversationRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
      atBottomRef.current = true;
      setAtBottom(true);
      unreadCountRef.current = 0;
      setUnreadCount(0);
      setScrollMetrics({ top: element.scrollTop, height: element.clientHeight });
    }
  }

  function scrollConversationToEnd(): void {
    cancelPendingScrollSettling();
    let remainingFrames = 4;
    const settle = (): void => {
      scrollSettleFrameRef.current = null;
      syncConversationToEnd();
      remainingFrames -= 1;
      if (remainingFrames > 0) {
        scrollSettleFrameRef.current = window.requestAnimationFrame(settle);
        return;
      }
      scrollSettleTimerRef.current = window.setTimeout(() => {
        scrollSettleTimerRef.current = null;
        syncConversationToEnd();
      }, 120);
    };
    settle();
  }

  useEffect(() => () => cancelPendingScrollSettling(), []);

  useEffect(() => {
    const client = new RemoteClient({
      url: defaultUrl,
      onEvent: (event: EventEnvelope) => {
        setState((current) => applyEvent(current, event));
        const threadId = eventThreadId(event);
        if (threadId && threadId === activeThreadIdRef.current && countsAsUnread(event)) {
          if (atBottomRef.current) {
            setFollowOutput(true);
          } else {
            unreadCountRef.current += 1;
            setUnreadCount(unreadCountRef.current);
          }
        }
        if (event.event.method === "thread.snapshot") {
          const threadId = event.event.params.thread.id;
          loadedThreadIdsRef.current.add(threadId);
          displayedThreadIdsRef.current.add(threadId);
          setThreadLoadingId((current) => current === threadId ? null : current);
        }
      },
      onSequenceReset: () => {
        needsFullRestoreRef.current = true;
        loadedThreadIdsRef.current.clear();
        const cachedThreadId = readActiveThreadSnapshot()?.id;
        displayedThreadIdsRef.current = new Set(cachedThreadId ? [cachedThreadId] : []);
        setThreadLoadingId(null);
        setState(createCachedInitialState());
      },
      onConnectionChange: (connected, message) => {
        const phase = connected ? "online" : navigator.onLine ? "connecting" : "offline";
        setState((current) => ({ ...current, connection: { phase, message } }));
        if (!connected && pendingSubmissionRef.current) {
          setNotice("连接中断，消息仍保留；电脑连接恢复后可安全重试");
        }
        if (connected) {
          if (window.localStorage.getItem("codex-remote-device-token")) setPaired(true);
          if (needsFullRestoreRef.current) {
            needsFullRestoreRef.current = false;
            setHistorySyncing(true);
            void restoreAfterConnect(client);
          } else {
            setHistorySyncing(false);
            void refreshAfterReconnect(client);
          }
        }
      },
    });
    clientRef.current = client;
    client.connect();
    return () => client.close();
  }, []);

  async function loadThreads(client = clientRef.current, searchTerm = search, cursor?: string | null, reportError = true): Promise<void> {
    if (!client) return;
    try {
      await client.request("thread.list", { limit: 100, searchTerm, cursor: cursor ?? null }, 30_000);
    } catch (error) {
      if (reportError) setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function restoreAfterConnect(client: RemoteClient): Promise<void> {
    const threadId = window.localStorage.getItem(ACTIVE_THREAD_KEY);
    const listPromise = loadThreads(client, "");
    let readPromise: Promise<unknown> | null = null;
    if (threadId) {
      setState((current) => setActiveThread(current, threadId));
      setFollowOutput(true);
      if (!loadedThreadIdsRef.current.has(threadId)) {
        if (!displayedThreadIdsRef.current.has(threadId)) setThreadLoadingId(threadId);
        readPromise = client.request("thread.read", { threadId }, THREAD_READ_TIMEOUT_MS);
      }
    }
    const [, readResult] = await Promise.allSettled([listPromise, readPromise ?? Promise.resolve()]);
    setHistorySyncing(false);
    if (!threadId || !readPromise) {
      window.requestAnimationFrame(scrollConversationToEnd);
      return;
    }
    if (readResult.status === "rejected" && !loadedThreadIdsRef.current.has(threadId)) {
      handleThreadReadFailure(threadId, readResult.reason);
      return;
    }
    if (readResult.status === "fulfilled" && isThreadLoadingAck(readResult.value)) {
      window.requestAnimationFrame(scrollConversationToEnd);
      return;
    }
    setThreadLoadingId((current) => current === threadId ? null : current);
    window.requestAnimationFrame(scrollConversationToEnd);
  }

  function refreshAfterReconnect(client: RemoteClient): void {
    // 普通重连先依赖 events.resume 回放，避免 Safari 从后台返回时重复读取整条会话。
    // 若服务端检测到回放窗口已失效，onSequenceReset 会把 needsFullRestoreRef 置为 true，
    // 下一次连接仍会走完整的 thread.read 恢复流程。
    void loadThreads(client, "", null, false);
  }

  function handleThreadReadFailure(threadId: string, reason: unknown): void {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (message.includes("远程请求超时")) {
      setNotice("会话内容较多，电脑仍在后台加载…");
      window.setTimeout(() => setThreadLoadingId((current) => current === threadId ? null : current), 60_000);
      return;
    }
    setThreadLoadingId((current) => current === threadId ? null : current);
    setNotice(message);
  }

  const threads = useMemo(
    () => state.threadOrder.map((id) => state.threads[id]).filter((thread): thread is RemoteThread => Boolean(thread)),
    [state.threadOrder, state.threads],
  );
  const activeThread = state.activeThreadId ? state.threads[state.activeThreadId] ?? null : null;
  const activeTurn = activeThread?.turnIds.length ? activeThread.turns[activeThread.turnIds.at(-1) ?? ""] : null;
  const running = activeTurn?.status === "inProgress";
  const approval = Object.values(state.approvals)[0] ?? null;
  const connectionLabel = state.connection.phase !== "online"
    ? state.connection.message || "正在连接"
    : threadLoadingId
      ? "载入会话"
      : historySyncing
        ? "同步历史"
        : "电脑在线";

  useEffect(() => {
    if (search || !threads.length) return;
    const summaries: RemoteThreadSummary[] = threads.slice(0, 100).map((thread) => ({
      id: thread.id,
      sessionId: thread.sessionId,
      title: thread.title,
      preview: thread.preview,
      cwd: thread.cwd,
      modelProvider: thread.modelProvider,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: thread.status,
      isPinned: thread.isPinned,
      source: null,
    }));
    window.localStorage.setItem(THREAD_CACHE_KEY, JSON.stringify(summaries));
  }, [search, threads]);

  useEffect(() => {
    if (!activeThread || (!loadedThreadIdsRef.current.has(activeThread.id) && !displayedThreadIdsRef.current.has(activeThread.id))) return;
    const timer = window.setTimeout(() => saveActiveThreadSnapshot(activeThread), 300);
    return () => window.clearTimeout(timer);
  }, [activeThread]);

  useEffect(() => {
    if (!followOutput) return;
    const frame = window.requestAnimationFrame(scrollConversationToEnd);
    let settleTimer: number | null = null;
    if (activeTurn && activeTurn.status !== "inProgress") {
      settleTimer = window.setTimeout(() => setFollowOutput(false), 350);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      if (settleTimer != null) window.clearTimeout(settleTimer);
    };
  }, [activeThread, activeTurn?.status, followOutput]);

  async function selectThread(threadId: string): Promise<void> {
    setState((current) => setActiveThread(current, threadId));
    pendingSubmissionRef.current = null;
    unreadCountRef.current = 0;
    setUnreadCount(0);
    atBottomRef.current = true;
    setAtBottom(true);
    window.localStorage.setItem(ACTIVE_THREAD_KEY, threadId);
    setFollowOutput(true);
    setSidebarOpen(false);
    if (loadedThreadIdsRef.current.has(threadId)) {
      window.requestAnimationFrame(scrollConversationToEnd);
      return;
    }
    if (!displayedThreadIdsRef.current.has(threadId)) setThreadLoadingId(threadId);
    try {
      const result = await clientRef.current?.request<{ loading?: boolean }>("thread.read", { threadId }, THREAD_READ_TIMEOUT_MS);
      if (!result?.loading) window.requestAnimationFrame(scrollConversationToEnd);
    } catch (error) {
      if (!loadedThreadIdsRef.current.has(threadId)) handleThreadReadFailure(threadId, error);
    } finally {
      if (loadedThreadIdsRef.current.has(threadId)) {
        setThreadLoadingId((current) => current === threadId ? null : current);
      }
    }
  }

  async function createThread(): Promise<void> {
    setWorkspaceBusy(true);
    try {
      const result = await clientRef.current?.request<{ workspaces: RemoteWorkspace[] }>("workspace.list");
      setWorkspaceChoices(result?.workspaces ?? []);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function chooseWorkspace(workspace: RemoteWorkspace): Promise<void> {
    setWorkspaceBusy(true);
    try {
      const result = await clientRef.current?.request<{ thread: RemoteThread }>("thread.create", { cwd: workspace.path });
      setWorkspaceChoices(null);
      if (result?.thread?.id) await selectThread(result.thread.id);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setWorkspaceBusy(false);
    }
  }

  async function sendMessage(text: string, attachments: RemoteAttachment[] = []): Promise<void> {
    if (!activeThread) return;
    setFollowOutput(true);
    const fingerprint = JSON.stringify({ threadId: activeThread.id, text, attachments });
    const pending = pendingSubmissionRef.current;
    const clientRequestId = pending?.threadId === activeThread.id && pending.fingerprint === fingerprint
      ? pending.clientRequestId
      : createRemoteId();
    pendingSubmissionRef.current = { threadId: activeThread.id, fingerprint, clientRequestId };
    try {
      await clientRef.current?.request("turn.start", {
        threadId: activeThread.id,
        text,
        attachments,
        clientRequestId,
      });
      pendingSubmissionRef.current = null;
      window.requestAnimationFrame(scrollConversationToEnd);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  async function stopTurn(): Promise<void> {
    if (!activeThread || !activeTurn) return;
    try {
      await clientRef.current?.request("turn.interrupt", { threadId: activeThread.id, turnId: activeTurn.id });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function resolveApproval(decision: string): Promise<void> {
    if (!approval) return;
    try {
      await clientRef.current?.request("approval.resolve", { approvalId: approval.id, decision });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  async function pairDevice(): Promise<void> {
    const code = window.prompt("请输入电脑托盘中显示的 6 位配对码");
    if (!code) return;
    const name = window.prompt("给这台设备起个名字", "iPhone 14 Pro Max") || "iPhone";
    try {
      const response = await fetch(`${bridgeHttpUrl}/api/pairing/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim(), name }),
      });
      const result = await response.json() as { token?: string; error?: string };
      if (!response.ok || !result.token) throw new Error(result.error || "配对失败");
      clientRef.current?.reconnectWithToken(result.token);
      setPaired(true);
      setNotice("设备配对成功，正在重新连接…");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    }
  }

  function resetPairing(): void {
    if (!window.confirm("确定要清除本机保存的设备令牌并重新配对吗？")) return;
    clientRef.current?.forgetTokenAndReconnect();
    setPaired(false);
    setNotice("已清除本机配对令牌");
  }

  function jumpToBottom(): void {
    setFollowOutput(true);
    scrollConversationToEnd();
  }

  return (
    <div className="app-shell">
      {sidebarOpen && <button className="sidebar-scrim mobile-only" aria-label="点击遮罩关闭侧栏" onClick={() => setSidebarOpen(false)} />}
      <ThreadSidebar
        threads={threads}
        activeThreadId={state.activeThreadId}
        search={search}
        open={sidebarOpen}
        nextCursor={state.nextThreadCursor}
        loadingMore={loadingMore}
        loadingInitial={historySyncing && threads.length === 0}
        onSearchChange={(value) => {
          setSearch(value);
          window.clearTimeout(Number(document.body.dataset.searchTimer ?? 0));
          document.body.dataset.searchTimer = String(window.setTimeout(() => void loadThreads(undefined, value), 250));
        }}
        onSelect={(threadId) => void selectThread(threadId)}
        onCreate={() => void createThread()}
        onClose={() => setSidebarOpen(false)}
        onLoadMore={() => {
          if (!state.nextThreadCursor || loadingMore) return;
          setLoadingMore(true);
          void loadThreads(undefined, search, state.nextThreadCursor).finally(() => setLoadingMore(false));
        }}
      />

      <main className="workspace">
        <header className="topbar">
          <button className="icon-button mobile-only" type="button" aria-label="打开侧栏" onClick={() => setSidebarOpen(true)}>☰</button>
          <div className="thread-heading">
            <strong>{activeThread?.title ?? "Codex Remote"}</strong>
            <span>{activeThread?.cwd ?? "选择电脑上的会话"}</span>
          </div>
          <div className={`connection-pill connection-${state.connection.phase}`}>
            <span />
            {connectionLabel}
          </div>
          {state.connection.phase !== "online" && paired && (
            <button className="paired-button" type="button" title="点击可重置配对" onClick={resetPairing}>已配对</button>
          )}
          {state.connection.phase !== "online" && !paired && (
            <button className="pair-button" type="button" onClick={() => void pairDevice()}>配对</button>
          )}
        </header>

        <div
          className="conversation-scroll"
          ref={conversationRef}
          onPointerDown={cancelPendingScrollSettling}
          onWheel={cancelPendingScrollSettling}
          onScroll={() => {
            const element = conversationRef.current;
            if (!element) return;
            const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
            const nextAtBottom = distance <= 48;
            atBottomRef.current = nextAtBottom;
            setAtBottom(nextAtBottom);
            setScrollMetrics({ top: element.scrollTop, height: element.clientHeight });
            if (nextAtBottom && unreadCountRef.current) {
              unreadCountRef.current = 0;
              setUnreadCount(0);
            }
            if (distance > 120 && followOutput) {
              setFollowOutput(false);
            }
            if (distance <= 48 && running && !followOutput) setFollowOutput(true);
          }}
        >
          <Timeline
            thread={activeThread}
            loading={Boolean(activeThread && threadLoadingId === activeThread.id)}
            expanded={state.processExpanded}
            scrollTop={scrollMetrics.top}
            viewportHeight={scrollMetrics.height}
            onToggleExpanded={(turnId, expanded) => setState((current) => setTurnExpanded(current, turnId, expanded))}
            onRetry={(text) => { void sendMessage(text, []).catch(() => undefined); }}
          />
          {(!atBottom || unreadCount > 0) && (
            <button className="jump-bottom-button" type="button" onClick={jumpToBottom}>
              {unreadCount > 0 ? `回到底部 · ${unreadCount}` : "回到底部"}
            </button>
          )}
        </div>

        <Composer
          disabled={!activeThread || state.connection.phase !== "online"}
          running={running}
          placeholder={!activeThread ? "选择一个会话后发送消息" : state.connection.phase !== "online" ? "电脑离线，连接恢复后可继续发送" : undefined}
          onSend={sendMessage}
          onStop={stopTurn}
        />
      </main>

      {notice && (
        <button className="toast" type="button" onClick={() => setNotice(null)}>
          {notice}<span>×</span>
        </button>
      )}
      <ApprovalPanel approval={approval} onResolve={resolveApproval} />
      {workspaceChoices && <WorkspacePicker workspaces={workspaceChoices} busy={workspaceBusy} onSelect={(workspace) => void chooseWorkspace(workspace)} onClose={() => { if (!workspaceBusy) setWorkspaceChoices(null); }} />}
    </div>
  );
}

function eventThreadId(event: EventEnvelope): string | null {
  const params = event.event.params as Record<string, unknown>;
  if (typeof params.threadId === "string") return params.threadId;
  const approval = params.approval;
  return approval && typeof approval === "object" && typeof (approval as Record<string, unknown>).threadId === "string"
    ? String((approval as Record<string, unknown>).threadId)
    : null;
}

function countsAsUnread(event: EventEnvelope): boolean {
  return event.event.method === "turn.started"
    || event.event.method === "turn.completed"
    || event.event.method === "item.upsert"
    || event.event.method === "item.delta"
    || event.event.method === "turn.diff.updated"
    || event.event.method === "approval.requested"
    || event.event.method === "error";
}

function isThreadLoadingAck(value: unknown): boolean {
  return Boolean(value && typeof value === "object" && (value as { loading?: unknown }).loading === true);
}

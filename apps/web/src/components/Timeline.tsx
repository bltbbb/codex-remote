import { useEffect, useMemo, useState } from "react";
import type { RemoteItem, RemoteThread, RemoteTurn } from "@codex-remote/protocol";
import { DiffView } from "./DiffView";
import { Markdown } from "./Markdown";

interface TimelineProps {
  thread: RemoteThread | null;
  loading?: boolean;
  expanded: Record<string, boolean>;
  onToggleExpanded: (turnId: string, expanded: boolean) => void;
  onRetry: (text: string) => void;
  scrollTop?: number;
  viewportHeight?: number;
}

const VIRTUAL_TURN_THRESHOLD = 80;
const ESTIMATED_TURN_HEIGHT = 280;
const LARGE_OUTPUT_LIMIT = 12_000;

function isUnifiedDiff(value: string): boolean {
  return /^(?:diff --git |--- |\+\+\+ |@@ )/m.test(value);
}

function epochMilliseconds(value: number): number {
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}

function turnDuration(turn: RemoteTurn, now: number): number | null {
  if (turn.durationMs != null) return Math.max(0, turn.durationMs);
  if (turn.startedAt == null) return null;
  const start = epochMilliseconds(turn.startedAt);
  const end = turn.completedAt == null ? now : epochMilliseconds(turn.completedAt);
  return Math.max(0, end - start);
}

function formatDuration(durationMs: number | null): string {
  if (durationMs == null) return "计时中";
  const seconds = Math.max(1, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

function useTurnDuration(turn: RemoteTurn): string {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (turn.status !== "inProgress") return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turn.status]);
  return formatDuration(turnDuration(turn, now));
}

function processedLabel(turn: RemoteTurn): string {
  if (turn.status === "failed") return "处理失败";
  if (turn.status === "interrupted") return "已停止";
  return "已处理";
}

function cleanMarkdown(value: string): string {
  return value
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*[-*#]+\s*/gm, "")
    .trim();
}

function readableReasoningLine(value: string): string {
  const cleaned = cleanMarkdown(value);
  if (!cleaned) return "";
  if (/[\u3400-\u9fff]/u.test(cleaned)) return cleaned;
  if (/verif|validat/i.test(cleaned)) return "正在验证当前状态";
  if (/confirm|acknowledg/i.test(cleaned)) return "正在确认处理结果";
  if (/plan|decid|determin/i.test(cleaned)) return "正在规划下一步";
  if (/inspect|check|read|review|explor/i.test(cleaned)) return "正在检查相关信息";
  if (/implement|updat|edit|chang|patch/i.test(cleaned)) return "正在准备修改";
  if (/test|run|execut|build/i.test(cleaned)) return "正在执行验证";
  if (/search|find|locat/i.test(cleaned)) return "正在查找相关内容";
  if (/wait|monitor/i.test(cleaned)) return "正在等待执行结果";
  return "正在分析请求并确定下一步操作";
}

function ReasoningSummary({ item }: { item: Extract<RemoteItem, { type: "reasoning" }> }): React.JSX.Element {
  const raw = item.summary.join("\n").trim();
  const lines = [...new Set(item.summary.map(readableReasoningLine).filter(Boolean))];
  return (
    <>
      <div className="reasoning-copy">{lines.join("\n") || "正在分析请求并确定下一步操作"}</div>
      {raw && !/[\u3400-\u9fff]/u.test(raw) && (
        <details className="raw-reasoning">
          <summary>查看原始摘要</summary>
          <pre>{raw}</pre>
        </details>
      )}
    </>
  );
}

function LargeOutput({ value, className = "" }: { value: string; className?: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const truncated = value.length > LARGE_OUTPUT_LIMIT;
  const visible = truncated && !expanded ? `${value.slice(0, LARGE_OUTPUT_LIMIT)}\n… 已隐藏 ${value.length - LARGE_OUTPUT_LIMIT} 个字符` : value;
  return (
    <div className="large-output">
      <pre className={className}>{visible}</pre>
      {truncated && <button type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "收起长输出" : "展开全部输出"}</button>}
    </div>
  );
}

function ProcessItem({ item }: { item: RemoteItem }): React.JSX.Element | null {
  switch (item.type) {
    case "agentMessage":
      return (
        <div className="process-item process-commentary">
          {item.text ? <Markdown value={item.text} /> : <span className="typing-indicator">正在整理当前进展…</span>}
        </div>
      );
    case "reasoning":
      return (
        <div className="process-item reasoning-item">
          <div className="process-label"><span className="spark" aria-hidden="true">✦</span> 思考</div>
          <ReasoningSummary item={item} />
        </div>
      );
    case "plan":
      return (
        <div className="process-item">
          <div className="process-label">计划</div>
          <Markdown value={item.text} className="process-markdown" />
        </div>
      );
    case "commandExecution":
      return (
        <details className="process-item process-detail-item command-item">
          <summary className="process-label">
            <span>{item.status === "inProgress" ? `正在运行 ${item.command}` : item.status === "failed" ? "命令执行失败" : "运行了命令"}</span>
            <span className={`item-pill item-${item.status}`}>{item.status === "inProgress" ? "运行中" : item.exitCode === 0 ? "完成" : "失败"}</span>
          </summary>
          <code className="command-line">{item.command}</code>
          {item.output && <LargeOutput className="terminal-output" value={item.output} />}
        </details>
      );
    case "fileChange":
      return (
        <details className="process-item process-detail-item">
          <summary className="process-label">{item.status === "inProgress" ? "正在编辑文件" : "编辑了文件"}</summary>
          {item.patch && isUnifiedDiff(item.patch)
            ? <DiffView value={item.patch} compact />
            : <LargeOutput className="file-change-json" value={item.patch || JSON.stringify(item.changes, null, 2)} />}
        </details>
      );
    case "toolCall":
      return (
        <details className="process-item process-detail-item">
          <summary className="process-label">{item.status === "inProgress" ? "正在使用" : "已使用"} {item.namespace ? `${item.namespace}/` : ""}{item.tool}</summary>
          {item.output && <LargeOutput value={item.output} />}
        </details>
      );
    case "unknown":
      return <div className="process-item"><div className="process-label">{item.originalType}</div></div>;
    default:
      return null;
  }
}

function ChevronRightIcon(): React.JSX.Element {
  return <svg className="process-chevron" viewBox="0 0 20 20" aria-hidden="true"><path d="m7.5 4.5 5 5.5-5 5.5" /></svg>;
}

function TurnView({
  turn,
  thread,
  isExpanded,
  onToggle,
  onRetry,
}: {
  turn: RemoteTurn;
  thread: RemoteThread;
  isExpanded: boolean;
  onToggle: (expanded: boolean) => void;
  onRetry: (text: string) => void;
}): React.JSX.Element {
  const items = turn.itemIds.map((id) => thread.items[id]).filter((item): item is RemoteItem => Boolean(item));
  const userMessages = items.filter((item) => item.type === "userMessage");
  const agentMessages = items.filter((item): item is Extract<RemoteItem, { type: "agentMessage" }> => item.type === "agentMessage");
  const explicitFinalMessages = agentMessages.filter((item) => item.phase === "final_answer" || item.phase === "finalAnswer" || item.phase === "final");
  const fallbackFinal = explicitFinalMessages.length === 0 && turn.status !== "inProgress" ? agentMessages.at(-1) : null;
  const finalMessages = explicitFinalMessages.length ? explicitFinalMessages : fallbackFinal ? [fallbackFinal] : [];
  const finalMessageIds = new Set(finalMessages.map((item) => item.id));
  const processItems = items.filter((item) => item.type !== "userMessage" && !finalMessageIds.has(item.id));
  const retryItem = userMessages.at(-1);
  const retryText = retryItem?.type === "userMessage" ? retryItem.text : null;
  const duration = useTurnDuration(turn);
  const hasFinalReply = finalMessages.some((item) => item.text.trim().length > 0);
  const processExpanded = !hasFinalReply || (turn.status !== "inProgress" && isExpanded);
  const hasProcess = processItems.length > 0 || Boolean(turn.diff) || turn.status === "inProgress";

  return (
    <section className="turn" data-testid={`turn-${turn.id}`} data-turn-status={turn.status}>
      {userMessages.map((item) => item.type === "userMessage" && (
        <div className="message-row user-row" key={item.id}>
          <div className="user-message">{item.text}</div>
        </div>
      ))}

      {hasProcess && (
        <div className={`process-flow ${hasFinalReply ? "process-flow-collapsed" : "process-flow-live"} ${processExpanded ? "process-flow-open" : ""}`}>
          {hasFinalReply && turn.status !== "inProgress" ? (
            <button
              data-testid={`process-summary-${turn.id}`}
              className="process-summary"
              type="button"
              onClick={() => onToggle(!processExpanded)}
              aria-expanded={processExpanded}
            >
              <span>{processedLabel(turn)}</span>
              <time>{duration}</time>
              <ChevronRightIcon />
            </button>
          ) : hasFinalReply ? (
            <div data-testid={`process-summary-${turn.id}`} className="process-summary process-summary-static" aria-expanded="false">
              <span>{processedLabel(turn)}</span>
              <time>{duration}</time>
              <ChevronRightIcon />
            </div>
          ) : (
            <div className="process-live-heading" role="status" aria-label="Codex 正在执行">
              <span>{processedLabel(turn)}</span>
              <time>{duration}</time>
            </div>
          )}

          {processExpanded && (
            <div className="process-live-body">
              {processItems.length
                ? processItems.map((item) => <ProcessItem key={item.id} item={item} />)
                : !turn.diff && <div className="process-placeholder"><span className="inline-spinner" />正在准备会话上下文</div>}
              {turn.diff && !processItems.some((item) => item.type === "fileChange" && item.patch.trim()) && (
                <details className="process-item process-detail-item">
                  <summary className="process-label">查看本回合文件差异</summary>
                  <DiffView value={turn.diff} compact />
                </details>
              )}
            </div>
          )}
        </div>
      )}

      {finalMessages.filter((item) => item.text.length > 0).map((item) => (
        <div className="message-row assistant-row final-answer-row" key={item.id}>
          <div className="assistant-message"><Markdown value={item.text} /></div>
        </div>
      ))}

      {turn.error && <div className="turn-error">{turn.error}</div>}
      {(turn.status === "failed" || turn.status === "interrupted") && retryText && (
        <button className="retry-button" type="button" onClick={() => onRetry(retryText)}>重试</button>
      )}
    </section>
  );
}

export function Timeline({ thread, loading, expanded, onToggleExpanded, onRetry, scrollTop = 0, viewportHeight = 800 }: TimelineProps): React.JSX.Element {
  const turnIds = thread?.turnIds ?? [];
  const virtual = turnIds.length >= VIRTUAL_TURN_THRESHOLD;
  const virtualRange = useMemo(() => {
    if (!virtual) return { start: 0, end: turnIds.length };
    const visibleTurns = Math.max(8, Math.ceil(viewportHeight / ESTIMATED_TURN_HEIGHT) + 12);
    const start = Math.max(0, Math.floor(scrollTop / ESTIMATED_TURN_HEIGHT) - 6);
    return { start: Math.min(start, Math.max(0, turnIds.length - visibleTurns)), end: Math.min(turnIds.length, start + visibleTurns) };
  }, [scrollTop, turnIds.length, viewportHeight, virtual]);

  if (loading) {
    return (
      <div className="timeline timeline-loading" role="status" aria-label="正在加载会话消息">
        <div className="message-skeleton message-skeleton-user" />
        <div className="process-skeleton"><span /><span /><span /></div>
        <div className="assistant-skeleton"><i /><div><span /><span /><span /></div></div>
      </div>
    );
  }
  if (!thread) {
    return (
      <div className="welcome-state">
        <div className="welcome-logo">C</div>
        <h1>从电脑继续你的 Codex 会话</h1>
        <p>选择历史会话，或创建一个新的工作线程。</p>
      </div>
    );
  }

  if (!thread.turnIds.length) {
    return (
      <div className="welcome-state compact-welcome">
        <h1>{thread.title}</h1>
        <p>发送一条消息开始此会话。</p>
      </div>
    );
  }

  const visibleTurnIds = virtual ? turnIds.slice(virtualRange.start, virtualRange.end) : turnIds;

  return (
    <div className="timeline" data-virtualized={virtual ? "true" : "false"}>
      {virtualRange.start > 0 && <div className="timeline-spacer" style={{ height: virtualRange.start * ESTIMATED_TURN_HEIGHT }} aria-hidden="true" />}
      {visibleTurnIds.map((turnId) => {
        const turn = thread.turns[turnId];
        return turn ? (
          <TurnView
            key={turn.id}
            turn={turn}
            thread={thread}
            isExpanded={expanded[turn.id] ?? turn.status === "inProgress"}
            onToggle={(value) => onToggleExpanded(turn.id, value)}
            onRetry={onRetry}
          />
        ) : null;
      })}
      {virtualRange.end < turnIds.length && <div className="timeline-spacer" style={{ height: (turnIds.length - virtualRange.end) * ESTIMATED_TURN_HEIGHT }} aria-hidden="true" />}
      <div id="timeline-end" />
    </div>
  );
}

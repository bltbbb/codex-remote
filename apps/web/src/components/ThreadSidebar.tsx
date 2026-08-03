import type { RemoteThread } from "@codex-remote/protocol";

interface ThreadSidebarProps {
  threads: RemoteThread[];
  activeThreadId: string | null;
  search: string;
  open: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  loadingInitial: boolean;
  onSearchChange: (value: string) => void;
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onClose: () => void;
  onLoadMore: () => void;
}

function projectName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || "其他会话";
}

function relativeTime(timestamp: number): string {
  if (!timestamp) return "";
  const seconds = Math.max(0, Math.floor(Date.now() / 1_000) - timestamp);
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  return `${Math.floor(seconds / 86_400)} 天前`;
}

export function ThreadSidebar(props: ThreadSidebarProps): React.JSX.Element {
  const groups = props.threads.reduce<Array<{ key: string; name: string; threads: RemoteThread[] }>>((result, thread) => {
    const key = thread.cwd || "__other__";
    const existing = result.find((group) => group.key === key);
    if (existing) existing.threads.push(thread);
    else result.push({ key, name: projectName(thread.cwd), threads: [thread] });
    return result;
  }, []);

  return (
    <aside className={`sidebar ${props.open ? "sidebar-open" : ""}`} aria-label="历史会话">
      <div className="sidebar-header">
        <div className="brand-mark">C</div>
        <div>
          <strong>Codex Remote</strong>
          <span>电脑上的会话</span>
        </div>
        <button className="icon-button mobile-only" type="button" aria-label="关闭侧栏" onClick={props.onClose}>×</button>
      </div>
      <button className="new-thread-button" type="button" onClick={props.onCreate}>
        <span>＋</span> 新建会话
      </button>
      <label className="search-box">
        <span aria-hidden="true">⌕</span>
        <input
          value={props.search}
          onChange={(event) => props.onSearchChange(event.target.value)}
          placeholder="搜索会话"
          aria-label="搜索会话"
        />
      </label>
      <div className="thread-list">
        {props.loadingInitial && (
          <div className="thread-skeleton-list" aria-label="正在加载历史会话" role="status">
            {Array.from({ length: 6 }, (_, index) => (
              <div className="thread-skeleton" key={index}>
                <span />
                <div><i /><i /></div>
              </div>
            ))}
          </div>
        )}
        {groups.map((group) => (
          <section className="thread-group" key={group.key}>
            <h2>{group.name}</h2>
            {group.threads.map((thread) => (
              <button
                type="button"
                key={thread.id}
                data-testid={`thread-row-${thread.id}`}
                className={`thread-row ${props.activeThreadId === thread.id ? "thread-row-active" : ""}`}
                onClick={() => props.onSelect(thread.id)}
              >
                <span className={`thread-status ${thread.status === "active" ? "thread-status-active" : ""}`} />
                <span className="thread-copy">
                  <strong>{thread.title}</strong>
                  <span>{thread.preview || thread.cwd}</span>
                </span>
                <time>{relativeTime(thread.updatedAt)}</time>
              </button>
            ))}
          </section>
        ))}
        {!props.loadingInitial && !props.threads.length && <p className="empty-sidebar">没有匹配的会话</p>}
        {props.nextCursor && (
          <button className="load-more-button" type="button" disabled={props.loadingMore} onClick={props.onLoadMore}>
            {props.loadingMore ? "正在加载…" : "加载更多"}
          </button>
        )}
      </div>
    </aside>
  );
}

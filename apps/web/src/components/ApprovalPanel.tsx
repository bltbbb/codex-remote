import type { ApprovalRequest } from "@codex-remote/protocol";

interface ApprovalPanelProps {
  approval: ApprovalRequest | null;
  onResolve: (decision: string) => Promise<void>;
}

export function ApprovalPanel({ approval, onResolve }: ApprovalPanelProps): React.JSX.Element | null {
  if (!approval) return null;
  return (
    <div className="approval-backdrop" role="presentation">
      <section className="approval-panel" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-icon">!</div>
        <h2 id="approval-title">{approval.title}</h2>
        <p>{approval.description}</p>
        {approval.command && <pre className="approval-command">{approval.command}</pre>}
        {approval.cwd && <div className="approval-cwd">工作目录：{approval.cwd}</div>}
        <div className="approval-actions">
          <button type="button" className="secondary-button" onClick={() => void onResolve("decline")}>拒绝</button>
          <button type="button" className="primary-button" onClick={() => void onResolve("accept")}>允许</button>
        </div>
      </section>
    </div>
  );
}


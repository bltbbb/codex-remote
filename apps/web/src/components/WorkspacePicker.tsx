import type { RemoteWorkspace } from "@codex-remote/protocol";

interface WorkspacePickerProps {
  workspaces: RemoteWorkspace[];
  busy: boolean;
  onSelect: (workspace: RemoteWorkspace) => void;
  onClose: () => void;
}

export function WorkspacePicker({ workspaces, busy, onSelect, onClose }: WorkspacePickerProps): React.JSX.Element {
  return (
    <div className="approval-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onClose();
    }}>
      <section className="workspace-picker" role="dialog" aria-modal="true" aria-labelledby="workspace-picker-title">
        <div className="workspace-picker-heading">
          <div>
            <h2 id="workspace-picker-title">选择电脑工作区</h2>
            <p>只能从电脑明确暴露的目录中创建会话。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭工作区选择" disabled={busy} onClick={onClose}>×</button>
        </div>
        <div className="workspace-options">
          {workspaces.map((workspace) => (
            <button key={workspace.id} type="button" disabled={busy} onClick={() => onSelect(workspace)}>
              <strong>{workspace.name}</strong>
              <span>{workspace.path}</span>
              <small>{workspace.source === "configured" ? "电脑配置" : "历史会话"}</small>
            </button>
          ))}
        </div>
        {!workspaces.length && <p className="workspace-empty">电脑端尚未配置可用工作区。</p>}
      </section>
    </div>
  );
}

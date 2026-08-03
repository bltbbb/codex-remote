interface DiffLine {
  kind: "add" | "remove" | "context" | "header";
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

function parseHunkHeader(value: string): { oldLine: number; newLine: number } | null {
  const match = value.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  return match?.[1] && match?.[2] ? { oldLine: Number(match[1]), newLine: Number(match[2]) } : null;
}

export function parseUnifiedDiff(value: string): DiffLine[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const output: DiffLine[] = [];
  let oldLine: number | null = null;
  let newLine: number | null = null;
  for (const line of lines) {
    const hunk = parseHunkHeader(line);
    if (hunk) {
      oldLine = hunk.oldLine;
      newLine = hunk.newLine;
      output.push({ kind: "header", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("diff ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
      output.push({ kind: "header", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (oldLine == null || newLine == null) {
      if (line) output.push({ kind: "context", text: line, oldLine: null, newLine: null });
      continue;
    }
    if (line.startsWith("+")) {
      output.push({ kind: "add", text: line.slice(1), oldLine: null, newLine });
      newLine += 1;
    } else if (line.startsWith("-")) {
      output.push({ kind: "remove", text: line.slice(1), oldLine, newLine: null });
      oldLine += 1;
    } else {
      output.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line, oldLine, newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return output;
}

function changeStats(lines: DiffLine[]): { additions: number; deletions: number } {
  return lines.reduce((stats, line) => {
    if (line.kind === "add") stats.additions += 1;
    if (line.kind === "remove") stats.deletions += 1;
    return stats;
  }, { additions: 0, deletions: 0 });
}

export function DiffView({ value, compact = false }: { value: string; compact?: boolean }): React.JSX.Element {
  const lines = parseUnifiedDiff(value);
  const maxLines = 5_000;
  const truncated = lines.length > maxLines;
  const visibleLines = truncated ? lines.slice(0, maxLines) : lines;
  const stats = changeStats(lines);
  if (!value.trim()) return <div className="diff-empty">没有可显示的文件差异</div>;
  return (
    <div className={`diff-view ${compact ? "diff-view-compact" : ""}`}>
      <div className="diff-toolbar">
        <span>文件差异{truncated ? "（已截断）" : ""}</span>
        <span className="diff-stats"><b className="diff-addition">+{stats.additions}</b><b className="diff-deletion">−{stats.deletions}</b></span>
      </div>
      <div className="diff-lines" role="table" aria-label="文件差异">
        {visibleLines.map((line, index) => (
          <div className={`diff-line diff-line-${line.kind}`} role="row" key={`${index}-${line.text}`}>
            <span className="diff-line-number" aria-hidden="true">{line.oldLine ?? ""}</span>
            <span className="diff-line-number" aria-hidden="true">{line.newLine ?? ""}</span>
            <code>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}{line.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

import type { ReactNode } from "react";

type MarkdownBlock =
  | { kind: "code"; language: string; value: string }
  | { kind: "heading"; level: number; value: string }
  | { kind: "quote"; value: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "paragraph"; value: string };

function safeHref(value: string): string | null {
  try {
    const base = typeof window === "undefined" ? "https://localhost/" : window.location.href;
    const url = new URL(value, base);
    if (!["http:", "https:", "mailto:"].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function renderParagraph(value: string, key: string): ReactNode[] {
  return value.split("\n").flatMap((line, index) => [
    ...(index > 0 ? [<br key={`${key}-br-${index}`} />] : []),
    ...renderInline(line),
  ]);
}

function Heading({ level, value }: { level: number; value: string }): React.JSX.Element {
  const content = renderInline(value);
  if (level <= 1) return <h1>{content}</h1>;
  if (level === 2) return <h2>{content}</h2>;
  if (level === 3) return <h3>{content}</h3>;
  if (level === 4) return <h4>{content}</h4>;
  if (level === 5) return <h5>{content}</h5>;
  return <h6>{content}</h6>;
}

function renderInline(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = value;
  let key = 0;
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_([^_\n]+)_|\[([^\]\n]+)\]\(([^)\n]+)\))/;
  while (rest) {
    const match = token.exec(rest);
    if (!match || match.index < 0) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) nodes.push(rest.slice(0, match.index));
    const valueAt = match[0];
    if (!valueAt) break;
    if (valueAt.startsWith("`") && valueAt.endsWith("`")) {
      nodes.push(<code className="inline-code" key={`inline-${key++}`}>{valueAt.slice(1, -1)}</code>);
    } else if ((valueAt.startsWith("**") && valueAt.endsWith("**")) || (valueAt.startsWith("__") && valueAt.endsWith("__"))) {
      nodes.push(<strong key={`inline-${key++}`}>{renderInline(valueAt.slice(2, -2))}</strong>);
    } else if (valueAt.startsWith("~~") && valueAt.endsWith("~~")) {
      nodes.push(<del key={`inline-${key++}`}>{renderInline(valueAt.slice(2, -2))}</del>);
    } else if (valueAt.startsWith("*") || valueAt.startsWith("_")) {
      nodes.push(<em key={`inline-${key++}`}>{renderInline(valueAt.slice(1, -1))}</em>);
    } else {
      const linkMatch = valueAt.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const href = linkMatch?.[2] ? safeHref(linkMatch[2]) : null;
      nodes.push(href ? <a key={`inline-${key++}`} href={href} target="_blank" rel="noreferrer">{linkMatch?.[1]}</a> : valueAt);
    }
    rest = rest.slice(match.index + valueAt.length);
  }
  return nodes;
}

function parseBlocks(value: string): MarkdownBlock[] {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let paragraph: string[] = [];
  let code: string[] | null = null;
  let language = "";
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) blocks.push({ kind: "paragraph", value: paragraph.join("\n") });
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push({ kind: "list", ordered: list.ordered, items: list.items });
    list = null;
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^ ]*)\s*$/);
    if (code) {
      if (fence) {
        blocks.push({ kind: "code", language, value: code.join("\n") });
        code = null;
        language = "";
      } else {
        code.push(line);
      }
      continue;
    }
    if (fence) {
      flushParagraph();
      flushList();
      code = [];
      language = fence[1] || "text";
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 1, value: heading[2] ?? "" });
      continue;
    }
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blocks.push({ kind: "quote", value: quote[1] ?? "" });
      continue;
    }
    const listItem = line.match(/^\s*([-+*]|\d+[.)])\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[1] ?? "");
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(listItem[2] ?? "");
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line);
  }
  if (code) blocks.push({ kind: "code", language, value: code.join("\n") });
  flushParagraph();
  flushList();
  return blocks;
}

export interface MarkdownProps {
  value: string;
  className?: string;
}

export function Markdown({ value, className = "" }: MarkdownProps): React.JSX.Element {
  const blocks = parseBlocks(value);
  return (
    <div className={`markdown ${className}`.trim()}>
      {blocks.map((block, index) => {
        const key = `markdown-${index}`;
        switch (block.kind) {
          case "code":
            return <pre className="markdown-code" key={key}><code data-language={block.language}>{block.value}</code></pre>;
          case "heading": {
            return <Heading key={key} level={block.level} value={block.value} />;
          }
          case "quote":
            return <blockquote key={key}>{renderInline(block.value)}</blockquote>;
          case "list": {
            const Tag = block.ordered ? "ol" : "ul";
            return <Tag key={key}>{block.items.map((item, itemIndex) => <li key={`${key}-${itemIndex}`}>{renderInline(item)}</li>)}</Tag>;
          }
          case "paragraph":
            return <p key={key}>{renderParagraph(block.value, key)}</p>;
        }
      })}
    </div>
  );
}

export function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  return parseBlocks(value);
}

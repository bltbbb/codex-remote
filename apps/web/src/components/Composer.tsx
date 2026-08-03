import { useEffect, useRef, useState } from "react";
import { createRemoteId, type RemoteAttachment } from "@codex-remote/protocol";

interface ComposerProps {
  disabled: boolean;
  running: boolean;
  placeholder?: string;
  onSend: (text: string, attachments: RemoteAttachment[]) => Promise<void>;
  onStop: () => Promise<void>;
}

function PaperclipIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.5 12 20a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.9-2.8l8.5-8.5" /></svg>;
}

function ArrowUpIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 18V6M7 11l5-5 5 5" /></svg>;
}

function StopIcon(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1.5" /></svg>;
}

export function Composer({ disabled, running, placeholder, onSend, onStop }: ComposerProps): React.JSX.Element {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<RemoteAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [text]);

  async function submit(): Promise<void> {
    const value = text.trim();
    if ((!value && !attachments.length) || disabled || sending) return;
    setSending(true);
    setSubmitError(null);
    try {
      await onSend(value, attachments);
      setText("");
      setAttachments([]);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  async function readAttachment(file: File): Promise<RemoteAttachment> {
    const kind: RemoteAttachment["kind"] = file.type.startsWith("image/") ? "image" : file.type.startsWith("audio/") ? "audio" : "file";
    const base: RemoteAttachment = { id: createRemoteId(), name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, kind };
    if (file.size > 10 * 1024 * 1024) throw new Error(`${file.name} 超过 10 MiB 附件限制`);
    if (kind === "image" || kind === "audio") {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`读取附件失败：${file.name}`));
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.readAsDataURL(file);
      });
      return { ...base, dataUrl };
    }
    const textLike = file.type.startsWith("text/") || /\.(md|txt|json|ya?ml|xml|csv|ts|tsx|js|jsx|css|html|log)$/i.test(file.name);
    return textLike ? { ...base, text: (await file.text()).slice(0, 200_000) } : base;
  }

  async function handleFiles(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []).slice(0, 4);
    event.target.value = "";
    if (!files.length) return;
    setAttachmentError(null);
    try {
      const incoming = await Promise.all(files.map(readAttachment));
      const total = [...attachments, ...incoming].reduce((sum, attachment) => sum + attachment.size, 0);
      if (total > 10 * 1024 * 1024) throw new Error("附件总大小不能超过 10 MiB");
      setAttachments((current) => [...current, ...incoming].slice(0, 4));
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }

  return (
    <div className="composer-shell">
      <div className="composer">
        <input ref={fileInput} className="attachment-input" type="file" accept="image/*,audio/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.css,.html,.xml,.yaml,.yml,.log" multiple onChange={(event) => void handleFiles(event)} disabled={disabled || running || sending} />
        <button className="composer-tool" type="button" aria-label="添加附件" onClick={() => fileInput.current?.click()} disabled={disabled || running || sending}><PaperclipIcon /></button>
        <textarea
          data-testid="composer-input"
          ref={textarea}
          value={text}
          disabled={disabled}
          placeholder={placeholder ?? (disabled ? "选择一个会话后发送消息" : "向电脑上的 Codex 发送消息")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          rows={1}
        />
        {running ? (
          <button className="send-button stop-button" type="button" aria-label="停止任务" disabled={disabled || sending} onClick={() => void onStop()}><StopIcon /></button>
        ) : (
          <button className="send-button" type="button" aria-label="发送消息" disabled={(!text.trim() && !attachments.length) || disabled || sending} onClick={() => void submit()}><ArrowUpIcon /></button>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="attachment-list" aria-label="已选附件">
          {attachments.map((attachment) => (
            <span className="attachment-chip" key={attachment.id}>
              <span>{attachment.kind === "image" ? "图片" : attachment.kind === "audio" ? "音频" : "文件"} · {attachment.name}</span>
              <button type="button" aria-label={`移除附件 ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button>
            </span>
          ))}
        </div>
      )}
      {attachmentError && <div className="composer-error">{attachmentError}</div>}
      {submitError && <div className="composer-error">提交失败，内容仍保留：{submitError}</div>}
      <div className="composer-meta">
        <span>{sending ? "正在提交…" : running ? "电脑正在处理…" : "电脑执行"}</span>
      </div>
    </div>
  );
}

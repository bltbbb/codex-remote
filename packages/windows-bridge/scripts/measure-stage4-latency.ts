import { performance } from "node:perf_hooks";
import WebSocket from "ws";

type RpcRecord = Record<string, unknown>;
type PendingRequest = {
  resolve: (value: RpcRecord) => void;
  reject: (error: Error) => void;
};

const token = process.env.CODEX_REMOTE_TEST_TOKEN;
const baseUrl = process.env.CODEX_REMOTE_TEST_URL ?? "ws://100.67.122.52:18787/ws";
const origin = baseUrl.replace(/^ws/, "http").replace(/\/ws$/, "");

if (!token) throw new Error("缺少 CODEX_REMOTE_TEST_TOKEN");

const connectStarted = performance.now();
const socket = new WebSocket(`${baseUrl}?token=${encodeURIComponent(token)}`, { origin });
await new Promise<void>((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
const connectMs = Math.round(performance.now() - connectStarted);
const pending = new Map<string, PendingRequest>();
let sequence = 0;

socket.on("message", (data) => {
  const message = JSON.parse(data.toString()) as RpcRecord;
  if (message.kind !== "response" || typeof message.id !== "string") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok === true) request.resolve((message.result as RpcRecord | undefined) ?? {});
  else request.reject(new Error(String((message.error as RpcRecord | undefined)?.message ?? "RPC 失败")));
});

async function request(method: string, params: RpcRecord = {}): Promise<{ result: RpcRecord; durationMs: number }> {
  const id = `measure-${++sequence}`;
  const started = performance.now();
  const result = await new Promise<RpcRecord>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ kind: "request", id, method, params }));
  });
  return { result, durationMs: Math.round(performance.now() - started) };
}

try {
  const resume = await request("events.resume", { afterSequence: 0, clientId: "latency-measure" });
  const list = await request("thread.list", { limit: 100, searchTerm: "", cursor: null });
  const threads = Array.isArray(list.result.threads) ? (list.result.threads as RpcRecord[]) : [];
  const target = threads.find((thread) => thread.title === "排查远程连接失败") ?? threads[0];
  const read = target && typeof target.id === "string"
    ? await request("thread.read", { threadId: target.id })
    : null;
  const info = await request("connection.info");

  console.log(JSON.stringify({
    connectMs,
    resumeMs: resume.durationMs,
    threadListMs: list.durationMs,
    threadCount: threads.length,
    threadReadMs: read?.durationMs ?? null,
    targetTitle: typeof target?.title === "string" ? target.title : null,
    connectionInfoMs: info.durationMs,
  }, null, 2));
} finally {
  socket.close();
}

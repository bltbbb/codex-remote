import WebSocket from "ws";
import { createRemoteId, parseWireMessage, type ServerResponseEnvelope } from "@codex-remote/protocol";

const publicBaseUrl = (process.env.CODEX_REMOTE_CLOUDFLARE_URL ?? "https://codex-remote.bltbbbego.store").replace(/\/$/, "");
const localBaseUrl = (process.env.CODEX_REMOTE_CLOUDFLARE_LOCAL_URL ?? "http://127.0.0.1:18791").replace(/\/$/, "");

async function retryFetch(input: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return await fetch(input, init);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function localJson(path: string, init: RequestInit = {}): Promise<Response> {
  return retryFetch(`${localBaseUrl}${path}`, { ...init, headers: { Origin: localBaseUrl, ...(init.headers ?? {}) } });
}

async function publicJson(path: string, init: RequestInit = {}): Promise<Response> {
  return retryFetch(`${publicBaseUrl}${path}`, { ...init, headers: { Origin: publicBaseUrl, ...(init.headers ?? {}) } });
}

async function requestOverWebSocket(token: string): Promise<unknown> {
  const url = `${publicBaseUrl.replace(/^https:/, "wss:").replace(/^http:/, "ws:")}/ws`;
  const socket = new WebSocket(url, ["codex-remote", `token.${token}`], { origin: publicBaseUrl });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  try {
    const id = createRemoteId();
    socket.send(JSON.stringify({ kind: "request", id, method: "connection.info", params: {} }));
    return await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("等待 Cloudflare WebSocket 响应超时")), 15_000);
      socket.on("message", (data) => {
        const message = parseWireMessage(data.toString());
        if (message.kind !== "response" || message.id !== id) return;
        clearTimeout(timeout);
        const response = message as ServerResponseEnvelope;
        if (response.ok) resolve(response.result);
        else reject(new Error(response.error?.message ?? "Cloudflare WebSocket 请求失败"));
      });
    });
  } finally {
    socket.close();
  }
}

async function main(): Promise<void> {
  let deviceId = "";
  try {
    const index = await retryFetch(`${publicBaseUrl}/`, { redirect: "error" });
    if (!index.ok) throw new Error(`Cloudflare Web 页面失败：HTTP ${index.status}`);
    const hsts = index.headers.get("strict-transport-security") ?? "";
    if (!hsts.includes("max-age=")) throw new Error("Cloudflare Web 页面缺少 HSTS");
    const publicHealth = await publicJson("/healthz");
    if (!publicHealth.ok) throw new Error(`Cloudflare 健康检查失败：HTTP ${publicHealth.status}`);
    const publicHealthValue = await publicHealth.json() as { sequence?: unknown };
    if ("sequence" in publicHealthValue) throw new Error("公网健康检查不应暴露事件序号");
    const publicPairingStart = await publicJson("/api/pairing/start", { method: "POST" });
    if (publicPairingStart.status !== 403) throw new Error(`公网配对码入口应返回 403，实际 ${publicPairingStart.status}`);

    const pairingStart = await localJson("/api/pairing/start", { method: "POST" });
    if (!pairingStart.ok) throw new Error(`本机配对码入口失败：HTTP ${pairingStart.status}`);
    const pairing = await pairingStart.json() as { code?: string };
    if (!pairing.code) throw new Error("本机配对码为空");

    const paired = await publicJson("/api/pairing/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairing.code, name: "Cloudflare 自动验证" }),
    });
    if (!paired.ok) throw new Error(`Cloudflare 配对失败：HTTP ${paired.status}`);
    const pairedValue = await paired.json() as { token?: string; device?: { id?: string } };
    if (!pairedValue.token || !pairedValue.device?.id) throw new Error("Cloudflare 配对响应缺少设备令牌");
    deviceId = pairedValue.device.id;

    const connection = await requestOverWebSocket(pairedValue.token);
    console.log(JSON.stringify({
      ok: true,
      evidence: {
        publicBaseUrl,
        https: true,
        remoteAdminRejected: true,
        paired: true,
        webSocket: true,
        connection,
      },
    }, null, 2));
  } finally {
    if (deviceId) await localJson(`/api/devices/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import WebSocket from "ws";

const baseUrl = process.env.CODEX_REMOTE_VERIFY_HTTP_URL ?? "http://127.0.0.1:18790";
const webSocketUrl = baseUrl.replace(/^http/, "ws") + "/ws";

async function expectWebSocketStatus(origin: string, expectedStatus: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl, { origin });
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error(`等待 WebSocket HTTP ${expectedStatus} 超时`));
    }, 5_000);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.close();
      reject(new Error(`WebSocket 意外连接成功，预期 HTTP ${expectedStatus}`));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      if (response.statusCode !== expectedStatus) {
        reject(new Error(`WebSocket 返回 HTTP ${response.statusCode}，预期 ${expectedStatus}`));
        return;
      }
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function jsonRequest(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Origin: baseUrl, ...(init.headers ?? {}) },
  });
}

async function main(): Promise<void> {
  const evidence: Record<string, unknown> = {};

  const health = await jsonRequest("/healthz");
  if (!health.ok) throw new Error(`健康检查失败：HTTP ${health.status}`);
  evidence.health = await health.json();

  const index = await fetch(`${baseUrl}/`);
  if (!index.ok) throw new Error(`Web UI 加载失败：HTTP ${index.status}`);
  const csp = index.headers.get("content-security-policy");
  if (!csp?.includes("frame-ancestors 'none'")) throw new Error("Web UI 缺少预期 CSP");
  evidence.securityHeaders = {
    contentSecurityPolicy: csp,
    frameOptions: index.headers.get("x-frame-options"),
    referrerPolicy: index.headers.get("referrer-policy"),
  };

  await expectWebSocketStatus(baseUrl, 401);
  evidence.requiredAuth = true;
  await expectWebSocketStatus("https://evil.example", 403);
  evidence.crossSiteWebSocketRejected = true;

  const pairingStart = await jsonRequest("/api/pairing/start", { method: "POST" });
  if (!pairingStart.ok) throw new Error(`本机生成配对码失败：HTTP ${pairingStart.status}`);
  const pairing = await pairingStart.json() as { code?: string };
  if (!pairing.code || !/^\d{6}$/.test(pairing.code)) throw new Error("配对码格式无效");
  evidence.localPairingStart = true;

  const statuses: number[] = [];
  for (let index = 0; index < 9; index += 1) {
    const response = await jsonRequest("/api/pairing/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "invalid", name: "stage4-check" }),
    });
    statuses.push(response.status);
  }
  if (statuses.slice(0, 8).some((status) => status !== 400) || statuses[8] !== 429) {
    throw new Error(`配对限速状态不正确：${statuses.join(",")}`);
  }
  evidence.pairingRateLimit = statuses;

  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientRequest, type ServerResponseEnvelope } from "@codex-remote/protocol";
import { BridgeRequestError, CodexBridgeEngine } from "./bridge-engine";
import type { DeviceStore, DeviceSummary } from "./device-store";

type AuthMode = "off" | "optional" | "required";
type ConnectedClient = { socket: WebSocket; clientId: string; device: DeviceSummary | null; unsubscribe: () => void };

const DEFAULT_ALLOWED_ORIGINS = [
  "http://127.0.0.1:15173",
  "http://localhost:15173",
  "http://127.0.0.1:15174",
  "http://localhost:15174",
  "http://127.0.0.1:4173",
  "http://localhost:4173",
];

const STATIC_SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Permitted-Cross-Domain-Policies": "none",
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function normalizeAddress(address: string | undefined): string {
  return (address ?? "").replace(/^::ffff:/, "").split("%")[0] ?? "";
}

function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1";
}

export function trustedProxyClientAddress(
  remoteAddress: string | undefined,
  cfConnectingIp: string | undefined,
  xForwardedFor: string | undefined,
): string {
  if (!isLoopbackAddress(remoteAddress)) return "";
  const forwarded = cfConnectingIp?.trim() || xForwardedFor?.split(",")[0]?.trim() || "";
  return normalizeAddress(forwarded);
}

export function extractWebSocketToken(protocolHeader: string | string[] | undefined): string {
  const value = Array.isArray(protocolHeader) ? protocolHeader.join(",") : protocolHeader ?? "";
  const protocol = value.split(",").map((item) => item.trim()).find((item) => item.startsWith("token."));
  return protocol?.slice("token.".length) ?? "";
}

export function isLocalMachineAddress(remoteAddress: string | undefined, localAddress: string | undefined, forwardedAddress = ""): boolean {
  if (forwardedAddress) return false;
  const remote = normalizeAddress(remoteAddress);
  const local = normalizeAddress(localAddress);
  return remote === "127.0.0.1" || remote === "::1" || Boolean(remote && local && remote === local);
}

export function isAllowedBrowserOrigin(origin: string | undefined, requestHost: string | undefined, forwardedProto: string | undefined, allowedOrigins: ReadonlySet<string>): boolean {
  if (!origin) return true;
  const proto = forwardedProto?.split(",")[0]?.trim() || "http";
  if (requestHost && origin === `${proto}://${requestHost}`) return true;
  return allowedOrigins.has(origin);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > 64 * 1024) throw new Error("请求体超过 64 KiB");
    chunks.push(value);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

export interface BridgeHttpServerOptions {
  host: string;
  port: number;
  staticRoot: string;
  authMode: AuthMode;
  allowedOrigins?: string[];
  engine: CodexBridgeEngine;
  devices: DeviceStore;
  onShutdown: () => void;
}

export class BridgeHttpServer {
  private readonly clients = new Set<ConnectedClient>();
  private readonly allowedOrigins: ReadonlySet<string>;
  private readonly pairingAttempts = new Map<string, { count: number; resetAt: number }>();
  private readonly server;
  private readonly webSocketServer;

  constructor(private readonly options: BridgeHttpServerOptions) {
    this.allowedOrigins = new Set([...DEFAULT_ALLOWED_ORIGINS, ...(options.allowedOrigins ?? [])]);
    this.server = createServer((request, response) => void this.handleHttp(request, response));
    this.webSocketServer = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols) => protocols.has("codex-remote") ? "codex-remote" : false,
    });
    this.server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (url.pathname !== "/ws") {
        socket.destroy();
        return;
      }
      if (!this.isAllowedOrigin(request)) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const protocolToken = extractWebSocketToken(request.headers["sec-websocket-protocol"]);
      void this.authorize(protocolToken || url.searchParams.get("token") || "").then((device) => {
        if (device === false) {
          socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          socket.destroy();
          return;
        }
        this.webSocketServer.handleUpgrade(request, socket, head, (webSocket) => this.acceptWebSocket(webSocket, device));
      }).catch(() => socket.destroy());
    });
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, resolve);
    });
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.unsubscribe();
      client.socket.close(1001, "Bridge 正在关闭");
    }
    this.clients.clear();
    await new Promise<void>((resolve) => this.webSocketServer.close(() => resolve()));
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  closeDevice(deviceId: string): void {
    for (const client of this.clients) {
      if (client.device?.id === deviceId) client.socket.close(1008, "设备已撤销");
    }
  }

  get baseUrl(): string {
    const displayHost = this.options.host === "0.0.0.0" ? "127.0.0.1" : this.options.host;
    return `http://${displayHost}:${this.options.port}`;
  }

  private async authorize(token: string): Promise<DeviceSummary | null | false> {
    if (this.options.authMode === "off") return null;
    if (token) return (await this.options.devices.verifyToken(token)) ?? false;
    if (this.options.authMode === "required" || this.options.devices.hasActiveDevices) return false;
    return null;
  }

  private acceptWebSocket(socket: WebSocket, device: DeviceSummary | null): void {
    const clientId = device?.id ?? `anonymous-${Math.random().toString(36).slice(2)}`;
    const unsubscribe = this.options.engine.journal.subscribe((event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    const client: ConnectedClient = { socket, clientId, device, unsubscribe };
    this.clients.add(client);

    socket.on("message", (data) => {
      void this.handleWebSocketRequest(client, data.toString());
    });
    socket.on("close", () => {
      unsubscribe();
      this.clients.delete(client);
    });
    this.options.engine.announceOnline();
  }

  private async handleWebSocketRequest(client: ConnectedClient, input: string): Promise<void> {
    let id = "invalid-request";
    try {
      const request = parseClientRequest(input);
      id = request.id;
      let result: unknown;
      if (request.method === "pairing.complete") {
        result = await this.options.devices.completePairing(String(request.params.code ?? ""), String(request.params.name ?? "iPhone"));
      } else if (request.method === "device.list") {
        result = { devices: this.options.devices.list() };
      } else if (request.method === "device.revoke") {
        const deviceId = String(request.params.deviceId ?? "");
        const revoked = await this.options.devices.revoke(deviceId);
        if (revoked) this.closeDevice(deviceId);
        result = { deviceId, revoked };
      } else {
        result = await this.options.engine.handle(request, client.clientId);
      }
      this.sendResponse(client.socket, { kind: "response", id, ok: true, result });
    } catch (error) {
      const bridgeError = error instanceof BridgeRequestError ? error : null;
      this.sendResponse(client.socket, {
        kind: "response",
        id,
        ok: false,
        error: {
          code: bridgeError?.code ?? "bridge_error",
          message: error instanceof Error ? error.message : String(error),
          details: bridgeError?.details,
        },
      });
    }
  }

  private sendResponse(socket: WebSocket, response: ServerResponseEnvelope): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(response));
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      if (!this.isAllowedOrigin(request)) {
        this.writeJson(request, response, 403, { ok: false, error: "请求来源不受信任" });
        return;
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, {
          ...this.corsHeaders(request),
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
        });
        response.end();
        return;
      }
      if (url.pathname === "/healthz" || url.pathname === "/readyz") {
        this.writeJson(request, response, 200, {
          ok: true,
          mode: "bridge",
          ...(this.isLocalMachine(request) ? { sequence: this.options.engine.journal.latestSequence } : {}),
        });
        return;
      }
      if (url.pathname === "/api/pairing/start" && request.method === "POST") {
        if (!this.isLocalMachine(request)) return this.writeJson(request, response, 403, { ok: false, error: "只能在电脑本机生成配对码" });
        this.writeJson(request, response, 200, this.options.devices.startPairing());
        return;
      }
      if (url.pathname === "/api/pairing/complete" && request.method === "POST") {
        if (!this.allowPairingAttempt(request)) {
          this.writeJson(request, response, 429, { ok: false, error: "配对尝试过多，请 5 分钟后重试" });
          return;
        }
        const body = await readJson(request);
        try {
          const result = await this.options.devices.completePairing(String(body.code ?? ""), String(body.name ?? "iPhone"));
          this.pairingAttempts.delete(this.clientAddress(request));
          this.writeJson(request, response, 200, result);
        } catch (error) {
          this.writeJson(request, response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (url.pathname === "/api/devices" && request.method === "GET") {
        if (!this.isLocalMachine(request)) return this.writeJson(request, response, 403, { ok: false, error: "只能在电脑本机管理设备" });
        this.writeJson(request, response, 200, { devices: this.options.devices.list() });
        return;
      }
      if (url.pathname.startsWith("/api/devices/") && request.method === "DELETE") {
        if (!this.isLocalMachine(request)) return this.writeJson(request, response, 403, { ok: false, error: "只能在电脑本机撤销设备" });
        const deviceId = decodeURIComponent(url.pathname.slice("/api/devices/".length));
        const revoked = await this.options.devices.revoke(deviceId);
        if (revoked) this.closeDevice(deviceId);
        this.writeJson(request, response, 200, { deviceId, revoked });
        return;
      }
      if (url.pathname === "/api/shutdown" && request.method === "POST") {
        if (!this.isLocalMachine(request)) return this.writeJson(request, response, 403, { ok: false, error: "只能在电脑本机退出 Bridge" });
        this.writeJson(request, response, 202, { ok: true });
        setImmediate(this.options.onShutdown);
        return;
      }
      await this.serveStatic(request, url.pathname, response);
    } catch (error) {
      this.writeJson(request, response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async serveStatic(request: IncomingMessage, pathname: string, response: ServerResponse): Promise<void> {
    const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidate = path.resolve(this.options.staticRoot, relative);
    const root = path.resolve(this.options.staticRoot);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
      response.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...this.securityHeaders(request) });
      response.end(JSON.stringify({ ok: false, error: "无效静态资源路径" }));
      return;
    }
    let filePath = candidate;
    try {
      if (!(await stat(filePath)).isFile()) throw new Error("not-file");
    } catch {
      filePath = path.join(root, "index.html");
    }
    try {
      const content = await readFile(filePath);
      response.writeHead(200, {
        "Content-Type": MIME_TYPES[path.extname(filePath)] ?? "application/octet-stream",
        "Cache-Control": path.basename(filePath) === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
        ...this.securityHeaders(request),
      });
      response.end(content);
    } catch {
      response.writeHead(404, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...this.securityHeaders(request) });
      response.end(JSON.stringify({ ok: false, error: "Web UI 尚未构建，请先运行 pnpm build" }));
    }
  }

  private isAllowedOrigin(request: IncomingMessage): boolean {
    const forwardedProto = Array.isArray(request.headers["x-forwarded-proto"])
      ? request.headers["x-forwarded-proto"][0]
      : request.headers["x-forwarded-proto"];
    return isAllowedBrowserOrigin(request.headers.origin, request.headers.host, forwardedProto, this.allowedOrigins);
  }

  private corsHeaders(request: IncomingMessage): Record<string, string> {
    const origin = request.headers.origin;
    return origin && this.isAllowedOrigin(request) ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {};
  }

  private writeJson(request: IncomingMessage, response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...this.securityHeaders(request),
      ...this.corsHeaders(request),
    });
    response.end(JSON.stringify(value));
  }

  private securityHeaders(request: IncomingMessage): Record<string, string> {
    const forwardedProto = Array.isArray(request.headers["x-forwarded-proto"])
      ? request.headers["x-forwarded-proto"][0]
      : request.headers["x-forwarded-proto"];
    const isHttps = forwardedProto?.split(",")[0]?.trim() === "https"
      || Boolean((request.socket as typeof request.socket & { encrypted?: boolean }).encrypted);
    return {
      ...STATIC_SECURITY_HEADERS,
      ...(isHttps ? { "Strict-Transport-Security": "max-age=31536000; includeSubDomains" } : {}),
    };
  }

  private isLocalMachine(request: IncomingMessage): boolean {
    return isLocalMachineAddress(request.socket.remoteAddress, request.socket.localAddress, this.forwardedClientAddress(request));
  }

  private clientAddress(request: IncomingMessage): string {
    return this.forwardedClientAddress(request) || normalizeAddress(request.socket.remoteAddress) || "unknown";
  }

  private forwardedClientAddress(request: IncomingMessage): string {
    const cfConnectingIp = Array.isArray(request.headers["cf-connecting-ip"])
      ? request.headers["cf-connecting-ip"][0]
      : request.headers["cf-connecting-ip"];
    const xForwardedFor = Array.isArray(request.headers["x-forwarded-for"])
      ? request.headers["x-forwarded-for"][0]
      : request.headers["x-forwarded-for"];
    return trustedProxyClientAddress(request.socket.remoteAddress, cfConnectingIp, xForwardedFor);
  }

  private allowPairingAttempt(request: IncomingMessage, now = Date.now()): boolean {
    const key = this.clientAddress(request);
    const current = this.pairingAttempts.get(key);
    if (!current || current.resetAt <= now) {
      this.pairingAttempts.set(key, { count: 1, resetAt: now + 5 * 60_000 });
      return true;
    }
    if (current.count >= 8) return false;
    current.count += 1;
    return true;
  }
}

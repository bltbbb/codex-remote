import WebSocket from "ws";

export type RpcId = string | number;

type RpcRecord = Record<string, unknown>;
type NotificationListener = (method: string, params: unknown) => void;
type RequestListener = (id: RpcId, method: string, params: unknown) => void;

function record(value: unknown): RpcRecord {
  return value && typeof value === "object" ? (value as RpcRecord) : {};
}

export interface CodexRpcTransport {
  request(method: string, params?: unknown): Promise<unknown>;
  respond(id: RpcId, result: unknown): void;
  respondError(id: RpcId, code: number, message: string): void;
  onNotification(listener: NotificationListener): () => void;
  onRequest(listener: RequestListener): () => void;
  close(): Promise<void>;
}

export interface CodexInitializeInfo {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export class WebSocketCodexRpc implements CodexRpcTransport {
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly notificationListeners = new Set<NotificationListener>();
  private readonly requestListeners = new Set<RequestListener>();

  private constructor(private readonly socket: WebSocket) {
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("close", () => this.rejectPending(new Error("Codex app-server 连接已关闭")));
    socket.on("error", (error) => this.rejectPending(error));
  }

  static async connect(url: string, timeoutMs = 15_000, bearerToken?: string): Promise<WebSocketCodexRpc> {
    const socket = new WebSocket(url, bearerToken ? { headers: { Authorization: `Bearer ${bearerToken}` } } : undefined);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`连接 Codex app-server 超时：${url}`)), timeoutMs);
      socket.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    return new WebSocketCodexRpc(socket);
  }

  async initialize(): Promise<CodexInitializeInfo> {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_remote_bridge", title: "Codex Remote Bridge", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    const value = record(result);
    return {
      userAgent: String(value.userAgent ?? ""),
      codexHome: String(value.codexHome ?? ""),
      platformFamily: String(value.platformFamily ?? ""),
      platformOs: String(value.platformOs ?? ""),
    };
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.send(params === undefined ? { method, id } : { method, id, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  respond(id: RpcId, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } });
  }

  onNotification(listener: NotificationListener): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: RequestListener): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      this.socket.once("close", resolve);
      this.socket.close();
      setTimeout(resolve, 1_000);
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send(params === undefined ? { method } : { method, params });
  }

  private send(message: RpcRecord): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server 尚未连接");
    this.socket.send(JSON.stringify(message));
  }

  private receive(input: string): void {
    let message: RpcRecord;
    try {
      message = record(JSON.parse(input));
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : null;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (method && id != null) {
      for (const listener of this.requestListeners) listener(id, method, message.params);
      return;
    }
    if (method) {
      for (const listener of this.notificationListeners) listener(method, message.params);
      return;
    }
    if (id == null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      const error = record(message.error);
      pending.reject(new Error(String(error.message ?? "Codex app-server 请求失败")));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

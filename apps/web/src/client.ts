import {
  createRemoteId,
  createRequest,
  parseWireMessage,
  type ClientMethod,
  type EventEnvelope,
  type ServerResponseEnvelope,
} from "@codex-remote/protocol";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: number;
};

export interface RemoteClientOptions {
  url: string;
  onEvent: (event: EventEnvelope) => void;
  onConnectionChange: (connected: boolean, message: string) => void;
  onSequenceReset?: () => void;
}

export class RemoteClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private reconnectTimer: number | null = null;
  private ackTimer: number | null = null;
  private heartbeatTimer: number | null = null;
  private heartbeatInFlight = false;
  private reconnectAttempt = 0;
  private lifecycleAttached = false;
  private closedByUser = false;
  private resuming = false;
  private queuedEvents: EventEnvelope[] = [];
  private lastSequence = 0;
  private hiddenAt: number | null = null;
  private readonly clientId = createRemoteId();

  constructor(private readonly options: RemoteClientOptions) {}

  private readonly handleOnline = (): void => this.wake();
  private readonly handleOffline = (): void => {
    this.options.onConnectionChange(false, "手机网络不可用");
    this.stopHeartbeat();
    this.socket?.close(4001, "手机网络不可用");
  };
  private readonly handleVisibilityChange = (): void => {
    if (document.visibilityState !== "visible") {
      this.hiddenAt = Date.now();
      return;
    }
    const backgroundDuration = this.hiddenAt == null ? 0 : Date.now() - this.hiddenAt;
    this.hiddenAt = null;
    this.wake(backgroundDuration >= 5_000);
  };
  private readonly handlePageShow = (event: PageTransitionEvent): void => this.wake(event.persisted);

  connect(): void {
    this.closedByUser = false;
    this.attachLifecycle();
    this.openSocket();
  }

  private openSocket(): void {
    if (this.closedByUser) return;
    if (!navigator.onLine) {
      this.options.onConnectionChange(false, "手机网络不可用");
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING) return;
    this.options.onConnectionChange(false, "正在连接电脑…");
    const token = window.localStorage.getItem("codex-remote-device-token");
    const secure = new URL(this.options.url, window.location.href).protocol === "wss:";
    const socket = token && secure
      ? new WebSocket(this.socketUrl(), ["codex-remote", `token.${token}`])
      : new WebSocket(this.socketUrl(token && !secure ? token : undefined));
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnectAttempt = 0;
      this.resuming = true;
      void this.resumeEvents().finally(() => {
        if (this.socket !== socket) return;
        this.resuming = false;
        this.flushQueuedEvents();
        this.options.onConnectionChange(true, "电脑已连接");
        this.startHeartbeat();
      });
    });

    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) return;
      try {
        const parsed = parseWireMessage(String(message.data));
        if (parsed.kind === "event") {
          if (this.resuming) this.queuedEvents.push(parsed);
          else this.acceptEvent(parsed);
          return;
        }
        if (parsed.kind === "response") this.resolveResponse(parsed);
      } catch (error) {
        this.options.onConnectionChange(true, error instanceof Error ? error.message : String(error));
      }
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopHeartbeat();
      this.options.onConnectionChange(false, navigator.onLine ? "连接已断开，正在重试…" : "手机网络不可用");
      this.resuming = false;
      this.queuedEvents = [];
      this.rejectAll(new Error("连接已断开"));
      if (!this.closedByUser) this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.options.onConnectionChange(false, "无法连接 Windows Bridge");
    });
  }

  private resolveResponse(response: ServerResponseEnvelope): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    window.clearTimeout(pending.timeoutId);
    if (response.ok) pending.resolve(response.result);
    else pending.reject(new Error(response.error?.message ?? "远程请求失败"));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null || this.closedByUser || !navigator.onLine) return;
    const delay = Math.min(1_000 * 2 ** this.reconnectAttempt, 15_000);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, delay);
  }

  private async resumeEvents(): Promise<void> {
    try {
      const result = await this.request<{ events?: EventEnvelope[]; latestSequence?: number; resetRequired?: boolean }>("events.resume", {
        afterSequence: this.lastSequence,
        clientId: this.clientId,
      });
      if (result.resetRequired) {
        this.lastSequence = 0;
        this.queuedEvents = [];
        this.options.onSequenceReset?.();
        return;
      }
      if (typeof result.latestSequence === "number" && result.latestSequence < this.lastSequence) {
        this.lastSequence = 0;
        this.options.onSequenceReset?.();
        return;
      }
      this.queuedEvents.push(...(Array.isArray(result.events) ? result.events : []));
    } catch {
      // 首次连接或旧模拟器没有重放能力时，仍然处理实时事件。
    }
  }

  private flushQueuedEvents(): void {
    const events = [...this.queuedEvents].sort((left, right) => left.sequence - right.sequence);
    this.queuedEvents = [];
    for (const event of events) this.acceptEvent(event);
  }

  private acceptEvent(event: EventEnvelope): void {
    if (event.sequence <= this.lastSequence) return;
    this.lastSequence = event.sequence;
    this.options.onEvent(event);
    this.scheduleAck();
  }

  private scheduleAck(): void {
    if (this.ackTimer != null) return;
    this.ackTimer = window.setTimeout(() => {
      this.ackTimer = null;
      void this.request("events.ack", { clientId: this.clientId, sequence: this.lastSequence }).catch(() => undefined);
    }, 100);
  }

  private socketUrl(queryToken?: string): string {
    const url = new URL(this.options.url, window.location.href);
    if (queryToken) url.searchParams.set("token", queryToken);
    return url.toString();
  }

  request<T>(method: ClientMethod, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("电脑尚未连接"));
    }
    const request = createRequest(method, params);
    return new Promise<T>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`远程请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(request.id, { resolve: (value) => resolve(value as T), reject, timeoutId });
      try {
        this.socket?.send(JSON.stringify(request));
      } catch (error) {
        window.clearTimeout(timeoutId);
        this.pending.delete(request.id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  wake(forceReconnect = false): void {
    if (this.closedByUser) return;
    if (!navigator.onLine) {
      this.options.onConnectionChange(false, "手机网络不可用");
      return;
    }
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (forceReconnect && (this.socket?.readyState === WebSocket.OPEN || this.socket?.readyState === WebSocket.CONNECTING)) {
      this.options.onConnectionChange(false, "正在恢复电脑连接…");
      this.restartSocket();
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      void this.probeConnection(3_000);
      return;
    }
    if (this.socket?.readyState !== WebSocket.CONNECTING) this.openSocket();
  }

  close(): void {
    this.closedByUser = true;
    this.detachLifecycle();
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.ackTimer != null) window.clearTimeout(this.ackTimer);
    this.ackTimer = null;
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.rejectAll(new Error("客户端已关闭"));
  }

  reconnectWithToken(token: string): void {
    window.localStorage.setItem("codex-remote-device-token", token);
    this.restartSocket();
  }

  forgetTokenAndReconnect(): void {
    window.localStorage.removeItem("codex-remote-device-token");
    this.restartSocket();
  }

  private restartSocket(): void {
    this.closedByUser = false;
    this.attachLifecycle();
    this.stopHeartbeat();
    this.socket?.close();
    this.socket = null;
    this.resuming = false;
    this.queuedEvents = [];
    this.rejectAll(new Error("连接正在恢复"));
    if (this.reconnectTimer != null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, 50);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private attachLifecycle(): void {
    if (this.lifecycleAttached) return;
    this.lifecycleAttached = true;
    window.addEventListener("online", this.handleOnline);
    window.addEventListener("offline", this.handleOffline);
    window.addEventListener("pageshow", this.handlePageShow);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private detachLifecycle(): void {
    if (!this.lifecycleAttached) return;
    this.lifecycleAttached = false;
    window.removeEventListener("online", this.handleOnline);
    window.removeEventListener("offline", this.handleOffline);
    window.removeEventListener("pageshow", this.handlePageShow);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = window.setInterval(() => void this.probeConnection(), 20_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer != null) window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.heartbeatInFlight = false;
  }

  private async probeConnection(timeoutMs = 8_000): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN || this.heartbeatInFlight) return;
    this.heartbeatInFlight = true;
    try {
      await this.request("connection.info", {}, timeoutMs);
    } catch {
      if (this.socket === socket && socket.readyState === WebSocket.OPEN) socket.close(4000, "连接探测超时");
    } finally {
      this.heartbeatInFlight = false;
    }
  }
}

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { WebSocketCodexRpc } from "../src/codex-rpc";
import { discoverNativeHost } from "../src/native-host-discovery";

type RpcId = string | number;
type RpcRecord = Record<string, unknown>;

function record(value: unknown): RpcRecord {
  return value && typeof value === "object" ? (value as RpcRecord) : {};
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

class StdioRpc {
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly notifications: Array<{ method: string; params: unknown }> = [];

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.once("exit", (code) => this.rejectAll(new Error(`Native Host 已退出，代码 ${String(code)}`)));
  }

  async initialize(): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo: { name: "codex_remote_native_host_test_desktop", title: "Native Host 测试 Desktop", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return result;
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    this.write(params === undefined ? { id, method } : { id, method, params });
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  private write(message: RpcRecord): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string): void {
    let message: RpcRecord;
    try {
      message = record(JSON.parse(line));
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : null;
    const id = typeof message.id === "string" || typeof message.id === "number" ? message.id : null;
    if (method) {
      this.notifications.push({ method, params: message.params });
      return;
    }
    if (id == null) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    if (message.error) {
      pending.reject(new Error(String(record(message.error).message ?? "stdio RPC 失败")));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 10_000): Promise<number | null> {
  if (child.exitCode != null) return child.exitCode;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve(child.exitCode);
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function main(): Promise<void> {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const projectRoot = path.resolve(scriptDir, "..", "..", "..");
  const artifact = path.join(projectRoot, "artifacts", "native-host-win-x64", "codex-remote-native-host.exe");
  const realCodex = path.join(projectRoot, "work", "stage0", "desktop-native", "codex.exe");
  const nativeLogs: string[] = [];
  const child = spawn(artifact, ["-c", "features.code_mode_host=true", "app-server", "--analytics-default-enabled"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CODEX_REMOTE_REAL_CODEX_PATH: realCodex,
      CODEX_REMOTE_NATIVE_HOST_ALLOW_NON_DESKTOP_PARENT: "1",
      CODEX_REMOTE_NATIVE_HOST_TRACE: "1",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf8").split(/\r?\n/).filter(Boolean).map((line) => (line.length > 1_000 ? `${line.slice(0, 1_000)}…` : line));
    nativeLogs.push(...lines);
    for (const line of lines) {
      if (line.includes("native-host-trace") || line.includes("codex app-server") || line.includes("listening on:") || line.includes("readyz:")) {
        console.error(line);
      }
    }
    if (nativeLogs.length > 200) nativeLogs.splice(0, nativeLogs.length - 200);
  });

  const desktop = new StdioRpc(child);
  let bridge: WebSocketCodexRpc | null = null;
  let threadId: string | null = null;
  try {
    console.error("[verify-native-host] 初始化 stdio Desktop 客户端");
    const desktopInitialize = record(await withTimeout(desktop.initialize(), "stdio Desktop initialize", 60_000));
    console.error("[verify-native-host] 读取 Native Host 发现状态");
    const host = await withTimeout(discoverNativeHost(15_000), "Native Host 发现");
    console.error("[verify-native-host] 连接 Bridge WebSocket 客户端");
    bridge = await withTimeout(WebSocketCodexRpc.connect(host.endpoint, 15_000, host.capabilityToken), "Bridge WebSocket 连接");
    const bridgeInitialize = await withTimeout(bridge.initialize(), "Bridge initialize", 60_000);

    console.error("[verify-native-host] Bridge 创建测试线程");
    const started = record(
      await withTimeout(bridge.request("thread/start", {
        cwd: projectRoot,
        ephemeral: false,
        approvalPolicy: "never",
        sandbox: "workspace-write",
      }), "Bridge thread/start", 60_000),
    );
    threadId = String(record(started.thread).id ?? "");
    if (!threadId) throw new Error("Native Host 集成测试未返回 threadId");

    console.error("[verify-native-host] 写入本地测试项以生成可恢复历史");
    await withTimeout(bridge.request("thread/inject_items", {
      threadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "codex-remote Native Host 集成测试" }],
        },
      ],
    }), "Bridge thread/inject_items", 30_000);

    console.error("[verify-native-host] stdio Desktop 恢复同一测试线程");
    const resumed = record(await withTimeout(desktop.request("thread/resume", { threadId }), "Desktop thread/resume", 30_000));
    const resumedThreadId = String(record(resumed.thread).id ?? "");
    if (resumedThreadId !== threadId) {
      throw new Error(`Desktop 与 Bridge 未恢复同一线程：${resumedThreadId} != ${threadId}`);
    }

    await withTimeout(bridge.request("thread/delete", { threadId }), "Bridge thread/delete");
    threadId = null;
    console.log(
      JSON.stringify(
        {
          ok: true,
          evidence: {
            hostPid: host.hostPid,
            codexPid: host.codexPid,
            endpoint: host.endpoint,
            codexVersion: host.codexVersion,
            desktopUserAgent: String(desktopInitialize.userAgent ?? ""),
            bridgeUserAgent: bridgeInitialize.userAgent,
            sameThreadResumed: true,
            desktopNotificationCount: desktop.notifications.length,
          },
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(nativeLogs.slice(-80).join("\n"));
    throw error;
  } finally {
    if (bridge && threadId) {
      try {
        await bridge.request("thread/delete", { threadId });
      } catch {
      }
    }
    await bridge?.close();
    child.stdin.end();
    await waitForExit(child);
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { access } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { WebSocketCodexRpc, type CodexInitializeInfo } from "./codex-rpc";
import { discoverNativeHost, type NativeHostInfo } from "./native-host-discovery";

const execFileAsync = promisify(execFile);
export const SUPPORTED_CODEX_VERSION = "0.146.0-alpha.9.2";
export const SUPPORTED_DESKTOP_VERSION = "26.727.6591.0";
export const SUPPORTED_SOURCE_TAG = "rust-v0.146.0-alpha.9.2";
export const SUPPORTED_CODEX_SHA256 = "ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F";

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export interface ManagedAppServer {
  rpc: WebSocketCodexRpc;
  initializeInfo: CodexInitializeInfo;
  executable: string | null;
  version: string;
  url: string;
  mode: "native-host" | "explicit" | "independent";
  nativeHost: NativeHostInfo | null;
  logs: () => string[];
  close: () => Promise<void>;
}

export async function discoverCodexExecutable(projectRoot: string): Promise<string> {
  const explicit = process.env.CODEX_EXECUTABLE;
  if (explicit && (await exists(explicit))) return path.resolve(explicit);

  const stageZeroCopy = path.join(projectRoot, "work", "stage0", "desktop-native", "codex.exe");
  if (await exists(stageZeroCopy)) return stageZeroCopy;

  throw new Error("未找到可安全启动的 Codex Desktop 原生副本；请设置 CODEX_EXECUTABLE，或先完成阶段 0 的原生文件复制");
}

export async function readCodexVersion(executable: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 10_000 });
  const output = `${stdout}\n${stderr}`.trim();
  const match = output.match(/(?:codex-cli\s+)?([^\s]+)$/m);
  if (!match?.[1]) throw new Error(`无法识别 Codex 版本：${output}`);
  return match[1];
}

function assertVersion(version: string): void {
  const expected = process.env.CODEX_REMOTE_EXPECTED_VERSION ?? SUPPORTED_CODEX_VERSION;
  if (version !== expected && process.env.CODEX_REMOTE_ALLOW_VERSION_MISMATCH !== "1") {
    throw new Error(`Codex 协议版本不匹配：当前 ${version}，Bridge 已验证 ${expected}；如已人工完成兼容测试，可设置 CODEX_REMOTE_ALLOW_VERSION_MISMATCH=1`);
  }
}

function assertNativeHostCompatibility(info: NativeHostInfo): void {
  if (info.desktopVersion !== SUPPORTED_DESKTOP_VERSION) {
    throw new Error(`Native Host Desktop 版本不匹配：当前 ${info.desktopVersion}，Bridge 已验证 ${SUPPORTED_DESKTOP_VERSION}`);
  }
  if (info.sourceTag !== SUPPORTED_SOURCE_TAG) {
    throw new Error(`Native Host 源码标签不匹配：当前 ${info.sourceTag}，Bridge 已验证 ${SUPPORTED_SOURCE_TAG}`);
  }
  if (info.codexSha256.toUpperCase() !== SUPPORTED_CODEX_SHA256) {
    throw new Error(`Native Host Codex SHA-256 不匹配：当前 ${info.codexSha256}`);
  }
}

type ManagedChild = ChildProcessByStdio<null, Readable, Readable>;

async function waitUntilReady(url: string, child: ManagedChild, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const readyUrl = new URL("/readyz", url.replace(/^ws:/, "http:").replace(/^wss:/, "https:"));
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error(`Codex app-server 已退出，代码 ${child.exitCode}`);
    try {
      const response = await fetch(readyUrl);
      if (response.ok) return;
    } catch {
      // 启动窗口内继续探测。
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Codex app-server 未在 15 秒内就绪");
}

function parseUserAgentVersion(userAgent: string): string | null {
  const match = userAgent.match(/(?:codex[_/-](?:cli[_/-])?(?:rs[_/-])?)?([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?)/i);
  return match?.[1] ?? null;
}

export async function startManagedAppServer(projectRoot: string): Promise<ManagedAppServer> {
  const attachUrl = process.env.CODEX_APP_SERVER_URL;
  const allowIndependent = process.env.CODEX_REMOTE_ALLOW_INDEPENDENT_APP_SERVER === "1";
  let child: ManagedChild | null = null;
  let executable: string | null = null;
  let version = "attached";
  let url: string;
  let bearerToken: string | undefined;
  let mode: ManagedAppServer["mode"];
  let nativeHost: NativeHostInfo | null = null;
  const logLines: string[] = [];

  if (attachUrl) {
    url = attachUrl;
    bearerToken = process.env.CODEX_APP_SERVER_TOKEN?.trim() || undefined;
    mode = "explicit";
  } else if (!allowIndependent) {
    nativeHost = await discoverNativeHost();
    assertNativeHostCompatibility(nativeHost);
    url = nativeHost.endpoint;
    bearerToken = nativeHost.capabilityToken;
    version = nativeHost.codexVersion;
    assertVersion(version);
    mode = "native-host";
  } else {
    executable = await discoverCodexExecutable(projectRoot);
    version = await readCodexVersion(executable);
    assertVersion(version);
    const port = await availablePort();
    url = `ws://127.0.0.1:${port}`;
    mode = "independent";
    const spawned = spawn(executable, ["-c", "features.code_mode_host=true", "app-server", "--listen", url], {
      cwd: projectRoot,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = spawned;
    const collect = (chunk: Buffer) => {
      logLines.push(...chunk.toString("utf8").split(/\r?\n/).filter(Boolean));
      if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
    };
    spawned.stdout.on("data", collect);
    spawned.stderr.on("data", collect);
    await waitUntilReady(url, spawned);
  }

  const rpc = await WebSocketCodexRpc.connect(url, 15_000, bearerToken);
  const initializeInfo = await rpc.initialize();
  const initializedVersion = parseUserAgentVersion(initializeInfo.userAgent);
  if (initializedVersion) {
    assertVersion(initializedVersion);
    version = initializedVersion;
  }

  return {
    rpc,
    initializeInfo,
    executable,
    version,
    url,
    mode,
    nativeHost,
    logs: () => [...logLines],
    close: async () => {
      await rpc.close();
      if (child && child.exitCode == null) child.kill();
    },
  };
}

import net from "node:net";

const DEFAULT_PIPE_PATH = String.raw`\\.\pipe\codex-remote-native-v1`;
const MAX_RESPONSE_BYTES = 64 * 1024;

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" ? (value as UnknownRecord) : {};
}

export interface NativeHostInfo {
  protocolVersion: number;
  endpoint: string;
  capabilityToken: string;
  hostPid: number;
  codexPid: number;
  codexVersion: string;
  desktopVersion: string;
  sourceTag: string;
  codexSha256: string;
}

export function parseNativeHostInfo(input: string): NativeHostInfo {
  const value = record(JSON.parse(input));
  const endpoint = String(value.endpoint ?? "");
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Native Host 返回了无效的 app-server 地址");
  }
  if (url.protocol !== "ws:" || (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "[::1]")) {
    throw new Error(`Native Host app-server 必须只监听本机回环地址：${endpoint}`);
  }

  const capabilityToken = String(value.capabilityToken ?? "");
  if (capabilityToken.length < 40) throw new Error("Native Host 未返回有效的 WebSocket 能力令牌");

  const info: NativeHostInfo = {
    protocolVersion: Number(value.protocolVersion),
    endpoint: url.toString().replace(/\/$/, ""),
    capabilityToken,
    hostPid: Number(value.hostPid),
    codexPid: Number(value.codexPid),
    codexVersion: String(value.codexVersion ?? ""),
    desktopVersion: String(value.desktopVersion ?? ""),
    sourceTag: String(value.sourceTag ?? ""),
    codexSha256: String(value.codexSha256 ?? ""),
  };
  if (info.protocolVersion !== 1) throw new Error(`不支持的 Native Host 协议版本：${info.protocolVersion}`);
  if (!Number.isSafeInteger(info.hostPid) || info.hostPid <= 0 || !Number.isSafeInteger(info.codexPid) || info.codexPid <= 0) {
    throw new Error("Native Host 返回了无效的进程信息");
  }
  return info;
}

export async function discoverNativeHost(timeoutMs = 3_000): Promise<NativeHostInfo> {
  const pipePath = process.env.CODEX_REMOTE_NATIVE_HOST_PIPE?.trim() || DEFAULT_PIPE_PATH;
  return new Promise<NativeHostInfo>((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    let settled = false;
    let response = "";
    const finish = (error?: Error, info?: NativeHostInfo) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      if (error) reject(error);
      else resolve(info as NativeHostInfo);
    };
    const timeout = setTimeout(
      () => finish(new Error("未发现正在由 Codex Desktop 使用的 Native Host；请先安装 Native Host 并完全重启 Codex Desktop")),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write('{"command":"status"}\n'));
    socket.on("data", (chunk: Buffer | string) => {
      response += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(response, "utf8") > MAX_RESPONSE_BYTES) {
        finish(new Error("Native Host 发现响应超过 64 KiB"));
        return;
      }
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, parseNativeHostInfo(response.slice(0, newline).trim()));
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", () =>
      finish(new Error("未发现正在由 Codex Desktop 使用的 Native Host；独立 app-server 已禁用，避免手机与桌面会话分叉")),
    );
    socket.once("close", () => {
      if (!settled) finish(new Error("Native Host 在返回状态前关闭了发现管道"));
    });
  });
}

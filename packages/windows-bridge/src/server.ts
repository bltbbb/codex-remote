import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startManagedAppServer } from "./app-server-process";
import { CodexBridgeEngine } from "./bridge-engine";
import { DeviceStore, DpapiProtector } from "./device-store";
import { EventJournal } from "./event-journal";
import { BridgeHttpServer } from "./http-server";
import { defaultPipeName, NamedPipeControlServer } from "./named-pipe";
import { startTray } from "./tray";

const BRIDGE_VERSION = "0.1.0";
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "..", "..", "..");
const host = process.env.CODEX_REMOTE_HOST ?? "0.0.0.0";
const port = Number(process.env.CODEX_REMOTE_PORT ?? 18787);
const authMode = process.env.CODEX_REMOTE_AUTH_MODE === "required" ? "required" : process.env.CODEX_REMOTE_AUTH_MODE === "off" ? "off" : "optional";
const pipeName = process.env.CODEX_REMOTE_PIPE ?? defaultPipeName();
const publicUrl = process.env.CODEX_REMOTE_PUBLIC_URL?.replace(/\/$/, "") || null;
const allowedOrigins = (process.env.CODEX_REMOTE_ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const workspacePaths = (process.env.CODEX_REMOTE_WORKSPACES ?? "")
  .split(";")
  .map((value) => value.trim())
  .filter(Boolean);

async function main(): Promise<void> {
  const devices = new DeviceStore(process.env.CODEX_REMOTE_DEVICE_STORE ?? DeviceStore.defaultPath(), new DpapiProtector());
  await devices.load();
  const managed = await startManagedAppServer(projectRoot);
  const journal = new EventJournal();
  const engine = new CodexBridgeEngine(
    managed.rpc,
    journal,
    {
      bridgeVersion: BRIDGE_VERSION,
      codexVersion: managed.version,
      codexUserAgent: managed.initializeInfo.userAgent,
      codexHome: managed.initializeInfo.codexHome,
      appServerUrl: managed.url,
      appServerMode: managed.mode,
      desktopVersion: managed.nativeHost?.desktopVersion ?? null,
      nativeHostPid: managed.nativeHost?.hostPid ?? null,
      codexPid: managed.nativeHost?.codexPid ?? null,
      namedPipe: pipeName,
    },
    workspacePaths.length ? workspacePaths : [projectRoot],
  );

  let tray: ChildProcess | null = null;
  let shuttingDown = false;
  let http: BridgeHttpServer;
  let pipe: NamedPipeControlServer;

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    engine.announceError("Bridge 正在关闭");
    tray?.kill();
    await pipe.close();
    await http.close();
    engine.dispose();
    await managed.close();
  };

  http = new BridgeHttpServer({
    host,
    port,
    staticRoot: path.join(projectRoot, "apps", "web", "dist"),
    authMode,
    allowedOrigins,
    engine,
    devices,
    onShutdown: () => void shutdown().then(() => process.exit(0)),
  });

  pipe = new NamedPipeControlServer(pipeName, async (request) => {
    switch (request.command) {
      case "status":
        return {
          ok: true,
          pid: process.pid,
          baseUrl: http.baseUrl,
          publicUrl,
          bridgeVersion: BRIDGE_VERSION,
          codexVersion: managed.version,
          appServerUrl: managed.url,
          appServerMode: managed.mode,
          nativeHostPid: managed.nativeHost?.hostPid ?? null,
          codexPid: managed.nativeHost?.codexPid ?? null,
        };
      case "pairing.start":
        return devices.startPairing();
      case "device.list":
        return { devices: devices.list() };
      case "device.revoke": {
        const deviceId = String(request.params?.deviceId ?? "");
        const revoked = await devices.revoke(deviceId);
        if (revoked) http.closeDevice(deviceId);
        return { deviceId, revoked };
      }
      case "open-ui":
        spawn("explorer.exe", [http.baseUrl], { detached: true, windowsHide: true, stdio: "ignore" }).unref();
        return { opened: true, url: http.baseUrl };
      case "shutdown":
        setImmediate(() => void shutdown().then(() => process.exit(0)));
        return { accepted: true };
      default:
        throw new Error(`未知命名管道命令：${request.command}`);
    }
  });

  await http.start();
  await pipe.start();
  engine.announceOnline();
  void engine.warmInitialState().catch((error) => {
    console.warn("预热历史会话失败：", error instanceof Error ? error.message : String(error));
  });

  if (process.env.CODEX_REMOTE_TRAY === "1") tray = startTray(process.pid, http.baseUrl, publicUrl ?? http.baseUrl);

  console.log(`Codex Remote Bridge 已启动：${http.baseUrl}`);
  console.log(`手机访问地址：http://${host === "0.0.0.0" ? "<电脑局域网或 Tailscale IP>" : host}:${port}/`);
  if (publicUrl) console.log(`公开访问地址：${publicUrl}/`);
  console.log(`鉴权模式：${authMode}`);
  console.log(`Codex app-server：${managed.url}（${managed.version}，${managed.mode}）`);
  console.log(`实例发现命名管道：${pipeName}`);

  process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

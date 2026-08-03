import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export function startTray(bridgePid: number, localBaseUrl: string, publicUrl = localBaseUrl): ChildProcess {
  const scriptPath = fileURLToPath(new URL("../scripts/tray.ps1", import.meta.url));
  return spawn(
    "powershell.exe",
    [
      "-NoLogo", "-NoProfile", "-Sta", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      "-BridgePid", String(bridgePid),
      "-LocalBaseUrl", localBaseUrl,
      "-PublicUrl", publicUrl,
    ],
    { detached: false, windowsHide: true, stdio: "ignore" },
  );
}

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SecretProtector {
  protect(value: Buffer): Promise<Buffer>;
  unprotect(value: Buffer): Promise<Buffer>;
}

async function runDpapi(mode: "Protect" | "Unprotect", scriptPath: string, value: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, "-Mode", mode],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`DPAPI 操作失败：${Buffer.concat(stderr).toString("utf8").trim()}`));
        return;
      }
      try {
        resolve(Buffer.from(Buffer.concat(stdout).toString("utf8").trim(), "base64"));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(value.toString("base64"));
  });
}

export class DpapiProtector implements SecretProtector {
  constructor(private readonly scriptPath = fileURLToPath(new URL("../scripts/dpapi.ps1", import.meta.url))) {}

  protect(value: Buffer): Promise<Buffer> {
    return runDpapi("Protect", this.scriptPath, value);
  }

  unprotect(value: Buffer): Promise<Buffer> {
    return runDpapi("Unprotect", this.scriptPath, value);
  }
}

export interface DeviceRecord {
  id: string;
  name: string;
  token: string;
  createdAt: number;
  lastSeenAt: number;
  revokedAt: number | null;
}

export interface DeviceSummary extends Omit<DeviceRecord, "token"> {}

type PairingSession = { code: string; expiresAt: number };

export class DeviceStore {
  private devices: DeviceRecord[] = [];
  private pairing: PairingSession | null = null;

  constructor(
    private readonly filePath: string,
    private readonly protector: SecretProtector,
  ) {}

  static defaultPath(): string {
    const base = process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? process.cwd(), "AppData", "Local");
    return path.join(base, "CodexRemote", "devices.dat");
  }

  async load(): Promise<void> {
    try {
      const protectedValue = await readFile(this.filePath);
      const plain = await this.protector.unprotect(protectedValue);
      const parsed: unknown = JSON.parse(plain.toString("utf8"));
      this.devices = Array.isArray(parsed) ? (parsed as DeviceRecord[]) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      this.devices = [];
    }
  }

  startPairing(now = Date.now()): { code: string; expiresAt: number } {
    this.pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: now + 5 * 60_000 };
    return { ...this.pairing };
  }

  async completePairing(code: string, name: string, now = Date.now()): Promise<{ device: DeviceSummary; token: string }> {
    if (!this.pairing || this.pairing.expiresAt < now || !safeTextEqual(this.pairing.code, code)) {
      throw new Error("配对码无效或已经过期");
    }
    this.pairing = null;
    const device: DeviceRecord = {
      id: randomBytes(16).toString("hex"),
      name: name.trim().slice(0, 80) || "iPhone",
      token: randomBytes(32).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      revokedAt: null,
    };
    this.devices.push(device);
    await this.save();
    return { device: summarize(device), token: device.token };
  }

  async verifyToken(token: string, now = Date.now()): Promise<DeviceSummary | null> {
    const device = this.devices.find((candidate) => candidate.revokedAt == null && safeTextEqual(candidate.token, token));
    if (!device) return null;
    device.lastSeenAt = now;
    await this.save();
    return summarize(device);
  }

  list(): DeviceSummary[] {
    return this.devices.map(summarize);
  }

  async revoke(deviceId: string, now = Date.now()): Promise<boolean> {
    const device = this.devices.find((candidate) => candidate.id === deviceId && candidate.revokedAt == null);
    if (!device) return false;
    device.revokedAt = now;
    await this.save();
    return true;
  }

  get hasActiveDevices(): boolean {
    return this.devices.some((device) => device.revokedAt == null);
  }

  private async save(): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const protectedValue = await this.protector.protect(Buffer.from(JSON.stringify(this.devices), "utf8"));
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, protectedValue, { mode: 0o600 });
    await rename(temporary, this.filePath);
  }
}

function summarize(device: DeviceRecord): DeviceSummary {
  const { token: _token, ...summary } = device;
  return summary;
}

function safeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

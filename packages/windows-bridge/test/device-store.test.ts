import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceStore, type SecretProtector } from "../src/device-store";

class TestProtector implements SecretProtector {
  async protect(value: Buffer): Promise<Buffer> { return Buffer.from(value.map((byte) => byte ^ 0xaa)); }
  async unprotect(value: Buffer): Promise<Buffer> { return Buffer.from(value.map((byte) => byte ^ 0xaa)); }
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("设备密钥存储", () => {
  it("完成配对、持久化加密内容并支持撤销", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "codex-remote-device-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "devices.dat");
    const store = new DeviceStore(file, new TestProtector());
    await store.load();
    const pairing = store.startPairing(1_000);
    const paired = await store.completePairing(pairing.code, "iPhone 14 Pro Max", 2_000);

    expect(await store.verifyToken(paired.token, 3_000)).toMatchObject({ name: "iPhone 14 Pro Max" });
    expect((await readFile(file)).toString("utf8")).not.toContain(paired.token);
    expect(await store.revoke(paired.device.id, 4_000)).toBe(true);
    expect(await store.verifyToken(paired.token, 5_000)).toBeNull();
  });
});

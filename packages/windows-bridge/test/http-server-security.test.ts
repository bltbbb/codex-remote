import { describe, expect, it } from "vitest";
import {
  extractWebSocketToken,
  isAllowedBrowserOrigin,
  isLocalMachineAddress,
  trustedProxyClientAddress,
} from "../src/http-server";

describe("HTTP 与 WebSocket 来源限制", () => {
  const allowed = new Set(["http://127.0.0.1:15173"]);

  it("允许同源 Tailscale 地址和显式开发来源", () => {
    expect(isAllowedBrowserOrigin("http://100.64.10.20:18787", "100.64.10.20:18787", undefined, allowed)).toBe(true);
    expect(isAllowedBrowserOrigin("http://127.0.0.1:15173", "100.64.10.20:18787", undefined, allowed)).toBe(true);
  });

  it("拒绝跨站来源并支持反向代理协议", () => {
    expect(isAllowedBrowserOrigin("https://evil.example", "100.64.10.20:18787", undefined, allowed)).toBe(false);
    expect(isAllowedBrowserOrigin("https://codex.example.com", "codex.example.com", "https", allowed)).toBe(true);
  });

  it("只把回环或同一块本机地址视为电脑本机", () => {
    expect(isLocalMachineAddress("127.0.0.1", "127.0.0.1")).toBe(true);
    expect(isLocalMachineAddress("::ffff:100.64.10.20", "100.64.10.20")).toBe(true);
    expect(isLocalMachineAddress("100.64.10.30", "100.64.10.20")).toBe(false);
    expect(isLocalMachineAddress("127.0.0.1", "127.0.0.1", "203.0.113.9")).toBe(false);
  });

  it("只信任来自回环代理的 Cloudflare 客户端地址", () => {
    expect(trustedProxyClientAddress("127.0.0.1", "203.0.113.9", undefined)).toBe("203.0.113.9");
    expect(trustedProxyClientAddress("127.0.0.1", undefined, "198.51.100.4, 127.0.0.1")).toBe("198.51.100.4");
    expect(trustedProxyClientAddress("100.64.10.20", "203.0.113.9", undefined)).toBe("");
  });

  it("从 WebSocket 子协议读取设备令牌", () => {
    expect(extractWebSocketToken("codex-remote, token.abc_DEF-123")).toBe("abc_DEF-123");
    expect(extractWebSocketToken(undefined)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { resolveBridgeUrls } from "../src/bridge-url";

describe("Bridge 地址", () => {
  it("Cloudflare HTTPS 使用同源 WSS 且不追加本地端口", () => {
    expect(resolveBridgeUrls({ origin: "https://codex-remote.example.com" })).toEqual({
      webSocketUrl: "wss://codex-remote.example.com/ws",
      httpUrl: "https://codex-remote.example.com",
    });
  });

  it("Tailscale HTTP 保留页面端口", () => {
    expect(resolveBridgeUrls({ origin: "http://100.67.122.52:18787" })).toEqual({
      webSocketUrl: "ws://100.67.122.52:18787/ws",
      httpUrl: "http://100.67.122.52:18787",
    });
  });

  it("开发环境可以显式覆盖地址", () => {
    expect(resolveBridgeUrls(
      { origin: "http://127.0.0.1:15174" },
      "ws://127.0.0.1:18789/ws",
      "http://127.0.0.1:18789",
    )).toEqual({
      webSocketUrl: "ws://127.0.0.1:18789/ws",
      httpUrl: "http://127.0.0.1:18789",
    });
  });
});

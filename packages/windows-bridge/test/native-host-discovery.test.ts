import { describe, expect, it } from "vitest";
import { parseNativeHostInfo } from "../src/native-host-discovery";

const validInfo = {
  protocolVersion: 1,
  endpoint: "ws://127.0.0.1:43123",
  capabilityToken: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
  hostPid: 101,
  codexPid: 102,
  codexVersion: "0.146.0-alpha.9.2",
  desktopVersion: "26.727.6591.0",
  sourceTag: "rust-v0.146.0-alpha.9.2",
  codexSha256: "ECD7A3EAFF5E42723DBBA03B5C91514B3986B5DB5CBCA8F34619620B5356F31F",
};

describe("Native Host 发现响应", () => {
  it("接受受能力令牌保护的回环 WebSocket", () => {
    expect(parseNativeHostInfo(JSON.stringify(validInfo))).toMatchObject(validInfo);
  });

  it("拒绝非回环监听地址", () => {
    expect(() => parseNativeHostInfo(JSON.stringify({ ...validInfo, endpoint: "ws://0.0.0.0:43123" }))).toThrow("必须只监听本机回环地址");
  });

  it("拒绝缺少能力令牌的响应", () => {
    expect(() => parseNativeHostInfo(JSON.stringify({ ...validInfo, capabilityToken: "short" }))).toThrow("能力令牌");
  });
});

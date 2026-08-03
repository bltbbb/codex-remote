import type { ClientRequestEnvelope, WireMessage } from "./types";
import { createRemoteId } from "./id";

export function parseWireMessage(input: string): WireMessage {
  const value: unknown = JSON.parse(input);
  if (!value || typeof value !== "object" || !("kind" in value)) {
    throw new Error("远程协议消息缺少 kind");
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "request" && kind !== "response" && kind !== "event") {
    throw new Error(`未知远程协议消息类型：${String(kind)}`);
  }
  return value as WireMessage;
}

export function parseClientRequest(input: string): ClientRequestEnvelope {
  const value = parseWireMessage(input);
  if (value.kind !== "request") {
    throw new Error("预期收到 request 消息");
  }
  if (!value.id || !value.method || !value.params || typeof value.params !== "object") {
    throw new Error("request 消息字段不完整");
  }
  return value;
}

export function createRequest(method: ClientRequestEnvelope["method"], params: Record<string, unknown> = {}): ClientRequestEnvelope {
  return {
    kind: "request",
    id: createRemoteId(),
    method,
    params,
  };
}

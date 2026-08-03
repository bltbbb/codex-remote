import { WebSocketServer } from "ws";
import { parseClientRequest } from "@codex-remote/protocol";
import { MockEngine } from "./engine";
import { ProtocolFaultInjector } from "./fault-injector";

const port = Number(process.env.REMOTE_CODEX_MOCK_PORT ?? 18787);
const stepDelayMs = Number(process.env.REMOTE_CODEX_MOCK_STEP_MS ?? 180);
const sharedEngine = new MockEngine({ stepDelayMs });
const isolatedConnections = process.env.REMOTE_CODEX_MOCK_ISOLATED === "1";
const host = process.env.REMOTE_CODEX_MOCK_HOST ?? "0.0.0.0";
const server = new WebSocketServer({ port, host, path: "/ws" });
// 隔离连接只隔离线程数据；事件序号仍需跨连接单调递增，模拟真实 Bridge 的回放语义。
const sequenceEpoch = Date.now() * 1_000;
let isolatedConnectionIndex = 0;

server.on("connection", (socket) => {
  const sequenceOffset = isolatedConnections ? sequenceEpoch + isolatedConnectionIndex++ * 1_000_000 : 0;
  const engine = isolatedConnections ? new MockEngine({ stepDelayMs, sequenceOffset }) : sharedEngine;
  const output = (message: unknown) => socket.send(JSON.stringify(message));
  const faults = new ProtocolFaultInjector(output);
  const emit = faults.emit.bind(faults);
  engine.connect(emit);
  socket.on("message", (data) => {
    try {
      const request = parseClientRequest(data.toString());
      if (request.method === "mock.fault.configure") {
        faults.configure(request.params);
        output({ kind: "response", id: request.id, ok: true, result: { configured: true } });
        return;
      }
      if (request.method === "mock.fault.release") {
        faults.release();
        output({ kind: "response", id: request.id, ok: true, result: { released: true } });
        return;
      }
      void engine.handle(request, emit);
    } catch (error) {
      emit({
        kind: "response",
        id: "invalid-request",
        ok: false,
        error: { code: "invalid_request", message: error instanceof Error ? error.message : String(error) },
      });
    }
  });
});

console.log(`Codex Remote 协议模拟器已启动：ws://${host}:${port}/ws`);

function shutdown(): void {
  server.close(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

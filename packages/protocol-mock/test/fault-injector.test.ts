import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@codex-remote/protocol";
import { ProtocolFaultInjector } from "../src/fault-injector";

function event(sequence: number): EventEnvelope {
  return { kind: "event", sequence, eventId: `event-${sequence}`, event: { method: "connection.status", params: { phase: "online" } } };
}

describe("协议故障注入器", () => {
  it("支持暂停和释放", () => {
    const output: EventEnvelope[] = [];
    const injector = new ProtocolFaultInjector((message) => { if (message.kind === "event") output.push(message); });
    injector.configure({ paused: true });
    injector.emit(event(1));
    expect(output).toEqual([]);
    injector.release();
    expect(output.map((item) => item.sequence)).toEqual([1]);
  });

  it("支持丢包、重复和相邻乱序", () => {
    const output: EventEnvelope[] = [];
    const injector = new ProtocolFaultInjector((message) => { if (message.kind === "event") output.push(message); });
    injector.configure({ dropNext: 1 });
    injector.emit(event(1));
    injector.configure({ duplicateNext: 1 });
    injector.emit(event(2));
    injector.configure({ reorderNextPair: true });
    injector.emit(event(3));
    injector.emit(event(4));
    expect(output.map((item) => item.sequence)).toEqual([2, 2, 4, 3]);
  });
});

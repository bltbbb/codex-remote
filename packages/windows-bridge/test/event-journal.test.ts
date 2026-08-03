import { describe, expect, it, vi } from "vitest";
import { EventJournal } from "../src/event-journal";

describe("事件日志", () => {
  it("为事件排序、广播、确认并重放", () => {
    const journal = new EventJournal(3);
    const listener = vi.fn();
    journal.subscribe(listener);
    for (let index = 0; index < 4; index += 1) {
      journal.publish({ method: "connection.status", params: { phase: "online", message: String(index) } });
    }

    expect(listener).toHaveBeenCalledTimes(4);
    expect(journal.replay(1).map((event) => event.sequence)).toEqual([2, 3, 4]);
    expect(journal.acknowledge("iphone", 3)).toBe(3);
    expect(journal.acknowledge("iphone", 2)).toBe(3);
  });

  it("超过移动端重放上限时要求完整同步", () => {
    const journal = new EventJournal();
    journal.publish({ method: "raw", params: { method: "diagnostic", data: "x".repeat(128) } });
    const result = journal.replayBounded(0, 64);
    expect(result.events).toEqual([]);
    expect(result.truncated).toBe(true);
  });
});

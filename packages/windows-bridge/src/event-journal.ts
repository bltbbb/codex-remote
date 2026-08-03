import { randomUUID } from "node:crypto";
import type { EventEnvelope, RemoteEvent } from "@codex-remote/protocol";

export type EventListener = (event: EventEnvelope) => void;

export type ReplayResult = {
  events: EventEnvelope[];
  truncated: boolean;
};

export class EventJournal {
  private sequence = 0;
  private readonly events: EventEnvelope[] = [];
  private readonly listeners = new Set<EventListener>();
  private readonly acknowledged = new Map<string, number>();

  constructor(private readonly capacity = 2_000) {}

  publish(event: RemoteEvent): EventEnvelope {
    const envelope: EventEnvelope = {
      kind: "event",
      sequence: ++this.sequence,
      eventId: randomUUID(),
      event,
    };
    this.events.push(envelope);
    if (this.events.length > this.capacity) this.events.splice(0, this.events.length - this.capacity);
    for (const listener of this.listeners) listener(envelope);
    return envelope;
  }

  replay(afterSequence: number): EventEnvelope[] {
    return this.events.filter((event) => event.sequence > afterSequence);
  }

  /**
   * 为移动端恢复连接提供有上限的事件重放。
   * 超过上限时不返回半截事件序列，而是让客户端走一次完整状态同步，
   * 避免把大段会话内容塞进 events.resume 响应。
   */
  replayBounded(afterSequence: number, maxBytes = 512 * 1024): ReplayResult {
    const events: EventEnvelope[] = [];
    let bytes = 0;
    for (const event of this.events) {
      if (event.sequence <= afterSequence) continue;
      const eventBytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (bytes + eventBytes > maxBytes) return { events: [], truncated: true };
      bytes += eventBytes;
      events.push(event);
    }
    return { events, truncated: false };
  }

  acknowledge(clientId: string, sequence: number): number {
    const bounded = Math.min(Math.max(0, sequence), this.sequence);
    this.acknowledged.set(clientId, Math.max(this.acknowledged.get(clientId) ?? 0, bounded));
    return this.acknowledged.get(clientId) ?? 0;
  }

  acknowledgedSequence(clientId: string): number {
    return this.acknowledged.get(clientId) ?? 0;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get latestSequence(): number {
    return this.sequence;
  }
}

import type { EventEnvelope, ServerResponseEnvelope } from "@codex-remote/protocol";

type Output = EventEnvelope | ServerResponseEnvelope;
type Emit = (message: Output) => void;

export interface FaultConfiguration {
  paused?: boolean;
  dropNext?: number;
  duplicateNext?: number;
  reorderNextPair?: boolean;
}

/**
 * 只扰动事件，不扰动请求响应，确保测试端仍能控制故障脚本。
 */
export class ProtocolFaultInjector {
  private paused = false;
  private dropNext = 0;
  private duplicateNext = 0;
  private reorderNextPair = false;
  private held: EventEnvelope | null = null;
  private readonly queue: EventEnvelope[] = [];

  constructor(private readonly output: Emit) {}

  configure(configuration: FaultConfiguration): void {
    if (typeof configuration.paused === "boolean") this.paused = configuration.paused;
    if (typeof configuration.dropNext === "number") this.dropNext = Math.max(0, Math.floor(configuration.dropNext));
    if (typeof configuration.duplicateNext === "number") this.duplicateNext = Math.max(0, Math.floor(configuration.duplicateNext));
    if (typeof configuration.reorderNextPair === "boolean") this.reorderNextPair = configuration.reorderNextPair;
  }

  emit(message: Output): void {
    if (message.kind !== "event") {
      this.output(message);
      return;
    }
    if (this.paused) {
      this.queue.push(message);
      return;
    }
    this.dispatch(message);
  }

  release(): void {
    this.paused = false;
    for (const event of this.queue.splice(0)) this.dispatch(event);
    this.flushHeld();
  }

  flushHeld(): void {
    if (!this.held) return;
    const held = this.held;
    this.held = null;
    this.output(held);
  }

  private dispatch(event: EventEnvelope): void {
    if (this.dropNext > 0) {
      this.dropNext -= 1;
      return;
    }
    if (this.reorderNextPair) {
      if (!this.held) {
        this.held = event;
        return;
      }
      const held = this.held;
      this.held = null;
      this.reorderNextPair = false;
      this.output(event);
      this.output(held);
      return;
    }
    this.output(event);
    if (this.duplicateNext > 0) {
      this.duplicateNext -= 1;
      this.output(structuredClone(event));
    }
  }
}

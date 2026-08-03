import WebSocket from "ws";
import { createRemoteId, parseWireMessage, type EventEnvelope } from "@codex-remote/protocol";

const url = process.env.CODEX_REMOTE_DIAGNOSE_URL ?? "ws://100.67.122.52:18787/ws";
const token = process.env.CODEX_REMOTE_DEVICE_TOKEN;
const threadId = process.env.CODEX_REMOTE_THREAD_ID;
const turnId = process.env.CODEX_REMOTE_TURN_ID;

if (!token) throw new Error("CODEX_REMOTE_DEVICE_TOKEN is required");
if (!threadId) throw new Error("CODEX_REMOTE_THREAD_ID is required");

function related(event: EventEnvelope): boolean {
  const params = event.event.params as Record<string, unknown>;
  const eventThreadId = params.threadId ?? (params.thread as { id?: string } | undefined)?.id;
  const eventTurnId = params.turnId ?? (params.turn as { id?: string } | undefined)?.id ?? (params.item as { turnId?: string } | undefined)?.turnId;
  return eventThreadId === threadId && (!turnId || eventTurnId === turnId);
}

function summarize(event: EventEnvelope): Record<string, unknown> {
  const params = event.event.params as Record<string, unknown>;
  const item = params.item as { type?: string; status?: string; text?: string } | undefined;
  const turn = params.turn as { id?: string; status?: string } | undefined;
  return {
    sequence: event.sequence,
    method: event.event.method,
    turnId: params.turnId ?? turn?.id,
    turnStatus: turn?.status,
    itemType: item?.type,
    itemStatus: item?.status,
    itemTextLength: typeof item?.text === "string" ? item.text.length : undefined,
    deltaTarget: params.target,
    deltaLength: typeof params.delta === "string" ? params.delta.length : undefined,
  };
}

async function main(): Promise<void> {
  const socketUrl = new URL(url);
  socketUrl.searchParams.set("token", token);
  const socket = new WebSocket(socketUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  const requestId = createRemoteId();
  socket.send(JSON.stringify({ kind: "request", id: requestId, method: "events.resume", params: { afterSequence: 0, clientId: "stage4-diagnostic" } }));
  const events = await new Promise<EventEnvelope[]>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("events.resume timed out")), 10_000);
    socket.on("message", (data) => {
      const message = parseWireMessage(data.toString());
      if (message.kind === "response" && message.id === requestId) {
        clearTimeout(timeout);
        if (!message.ok) reject(new Error(message.error?.message ?? "events.resume failed"));
        else resolve(((message.result as { events?: EventEnvelope[] } | undefined)?.events ?? []));
      }
    });
  });

  const relatedEvents = events.filter(related);
  console.log(JSON.stringify({
    ok: true,
    totalEvents: events.length,
    relatedEvents: relatedEvents.length,
    latest: relatedEvents.slice(-40).map(summarize),
  }, null, 2));
  socket.close();
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});

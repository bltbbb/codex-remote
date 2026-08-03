import net from "node:net";
import os from "node:os";

export interface PipeRequest {
  id?: string;
  command: string;
  params?: Record<string, unknown>;
}

export type PipeHandler = (request: PipeRequest) => Promise<unknown>;

export function defaultPipeName(): string {
  const user = os.userInfo().username.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `\\\\.\\pipe\\codex-remote-${user}`;
}

export class NamedPipeControlServer {
  private server: net.Server | null = null;

  constructor(
    readonly pipeName: string,
    private readonly handler: PipeHandler,
  ) {}

  async start(): Promise<void> {
    if (this.server) return;
    this.server = net.createServer((socket) => {
      socket.setEncoding("utf8");
      let buffer = "";
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) void this.handleLine(line, socket);
          newline = buffer.indexOf("\n");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(this.pipeName, resolve);
    });
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleLine(line: string, socket: net.Socket): Promise<void> {
    let request: PipeRequest | undefined;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || typeof (parsed as PipeRequest).command !== "string") {
        throw new Error("命名管道请求缺少 command");
      }
      request = parsed as PipeRequest;
      const result = await this.handler(request);
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({ id: request?.id, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
    }
  }
}

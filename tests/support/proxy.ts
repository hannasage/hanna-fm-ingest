import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { localStack } from "./env.ts";

/** What the proxy does with one write request to the plays table. */
export type Rule =
  | { pass: true }
  | { status: number; body: string };

export type Proxy = {
  /** The address to give the command as SUPABASE_URL. */
  url: string;
  /** How many writes to the plays table the proxy has seen. */
  writes: () => number;
  close: () => Promise<void>;
};

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A local pass-through in front of the local Supabase stack. It lets a test make one
 * chosen write fail or answer oddly, while every other request reaches the real database.
 * `rule` gets the number of the write (1 is the first) and says what to do with it.
 */
export async function startProxy(rule: (write: number) => Rule): Promise<Proxy> {
  const target = localStack().url;
  let writes = 0;

  const server: Server = createServer((request, response) => {
    void (async () => {
      const body = await readBody(request);
      const isWrite = request.method === "POST" && (request.url ?? "").startsWith("/rest/v1/plays");
      if (isWrite) {
        writes += 1;
        const decision = rule(writes);
        if (!("pass" in decision)) {
          response.writeHead(decision.status, { "content-type": "application/json" });
          response.end(decision.body);
          return;
        }
      }
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (typeof value === "string" && !["host", "content-length", "connection"].includes(name)) {
          headers[name] = value;
        }
      }
      const upstream = await fetch(`${target}${request.url ?? ""}`, {
        method: request.method,
        headers,
        body: body.length > 0 ? new Uint8Array(body) : undefined,
      });
      const text = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(text);
    })().catch(() => {
      response.writeHead(502);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    writes: () => writes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/** One request the fake server saw. */
export type Seen = {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
};

export type Answer = { status: number; body: string; headers?: Record<string, string> };
export type Handler = (request: Seen) => Answer;

export type FakeSpotify = {
  /** Give this as both SPOTIFY_ACCOUNTS_BASE and SPOTIFY_API_BASE. */
  url: string;
  tokenRequests: Seen[];
  recentRequests: Seen[];
  close: () => Promise<void>;
};

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}): Answer => ({
  status,
  body: JSON.stringify(value),
  headers,
});

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * A small fake of the two Spotify addresses the poller uses: POST /api/token and
 * GET /me/player/recently-played. It records every request. Synthetic data only.
 */
export async function startFakeSpotify(handlers: { token: Handler; recent: Handler }): Promise<FakeSpotify> {
  const tokenRequests: Seen[] = [];
  const recentRequests: Seen[] = [];

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake.invalid");
      const seen: Seen = {
        method: request.method ?? "",
        path: url.pathname,
        query: url.searchParams,
        headers: request.headers,
        body: await readBody(request),
      };
      let answer: Answer = { status: 404, body: "{}" };
      if (seen.method === "POST" && seen.path === "/api/token") {
        tokenRequests.push(seen);
        answer = handlers.token(seen);
      } else if (seen.method === "GET" && seen.path === "/me/player/recently-played") {
        recentRequests.push(seen);
        answer = handlers.recent(seen);
      }
      response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
      response.end(answer.body);
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    tokenRequests,
    recentRequests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An address nothing listens on: a server is started, then stopped. */
export async function deadAddress(): Promise<string> {
  const fake = await startFakeSpotify({
    token: () => ({ status: 500, body: "{}" }),
    recent: () => ({ status: 500, body: "{}" }),
  });
  await fake.close();
  return fake.url;
}

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
export type Handler = (request: Seen) => Answer | Promise<Answer>;

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
        answer = await handlers.token(seen);
      } else if (seen.method === "GET" && seen.path === "/me/player/recently-played") {
        recentRequests.push(seen);
        answer = await handlers.recent(seen);
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

/**
 * A recently-played handler that behaves like Spotify's paging: newest first, at most `limit`
 * items, `after` and `before` as exclusive Unix times in milliseconds. Spotify refuses both at once,
 * so this answers 400 when it sees both.
 */
export function recentFrom(all: Record<string, unknown>[]): Handler {
  const time = (item: Record<string, unknown>) => Date.parse(String(item.played_at));
  const byNewest = [...all].sort((a, b) => time(b) - time(a));
  return (request) => {
    const after = request.query.get("after");
    const before = request.query.get("before");
    if (after !== null && before !== null) return json({ error: { status: 400 } }, 400);
    const limit = Number(request.query.get("limit") ?? "20");
    const items = byNewest
      .filter((item) => after === null || time(item) > Number(after))
      .filter((item) => before === null || time(item) < Number(before))
      .slice(0, limit);
    return json({ href: "https://synthetic.invalid/page", limit, next: null, cursors: null, items });
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

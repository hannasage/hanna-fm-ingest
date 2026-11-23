import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseCache } from "../../src/item-store.ts";
import { MusicBrainz, RateLimitedQueue } from "../../src/musicbrainz.ts";
import type { Reply, Seen } from "./fake-mb.ts";
import { parseFields } from "./fake-mb.ts";

export const USER_AGENT = "SYNTH-resolve-test/0.0 ( synthetic-contact.invalid )";

/** A request the client made. `at` is read from the fake clock, so a test needs no real waiting. */
export type Call = Seen & { url: string; redirect: RequestInit["redirect"] };

/** What a fake fetch does: answer, or fail the way a network failure does. */
export type FetchReply = Reply & { text?: string };
export type Fail = { fail: unknown };

/** A network failure shaped like the one Node's fetch throws: a TypeError that holds the system's error as its cause. */
export function networkError(code: string, message: string): Error {
  return Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });
}

/**
 * A MusicBrainz client that runs in this process: a fake fetch, a fake clock (time moves only when the queue
 * sleeps), and the real cache table in the local database. Fast, and exact about timing.
 */
export function inProcess(
  db: SupabaseClient,
  respond: (call: Call, count: number) => FetchReply | Fail,
  options: { intervalMs?: number } = {},
) {
  const clock = { now: 0 };
  const queue = new RateLimitedQueue(
    options.intervalMs ?? 1000,
    async (ms) => {
      clock.now += ms;
    },
    () => clock.now,
  );
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const call: Call = {
      at: clock.now,
      url: url.toString(),
      path: url.pathname,
      fields: parseFields(url.searchParams.get("query") ?? ""),
      params: url.searchParams,
      userAgent: headers.get("user-agent") ?? undefined,
      accept: headers.get("accept") ?? undefined,
      redirect: init?.redirect,
    };
    calls.push(call);
    const reply = respond(call, calls.length);
    if ("fail" in reply) throw reply.fail;
    const body = reply.text ?? (reply.body === undefined ? "" : JSON.stringify(reply.body));
    return new Response(body === "" ? null : body, { status: reply.status, headers: reply.headers });
  }) as typeof fetch;
  const musicbrainz = new MusicBrainz({
    base: "https://musicbrainz.invalid/ws/2",
    userAgent: USER_AGENT,
    cache: new SupabaseCache(db),
    queue,
    fetch: fetchImpl,
  });
  return { musicbrainz, calls, clock, queue };
}

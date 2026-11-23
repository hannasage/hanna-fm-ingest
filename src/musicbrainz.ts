import { UserError } from "./files.ts";
import { readCandidates, type Candidate } from "./matching.ts";
import {
  MB_BACKOFF_BASE_MS,
  MB_MATCH_FETCH_LIMIT,
  MB_MAX_ATTEMPTS,
  MB_MAX_RESPONSE_BYTES,
  MB_MIN_INTERVAL_MS,
  MB_REQUEST_TIMEOUT_MS,
  MB_RETRY_AFTER_MAX_MS,
} from "./settings.ts";

/**
 * Every answer MusicBrainz gave, kept by request, as the parsed candidates and never the whole body.
 * `get` returns undefined for a request never seen, or seen too long ago.
 */
export type Cache = {
  get(url: string): Promise<unknown>;
  put(url: string, candidates: Candidate[]): Promise<void>;
  remove(url: string): Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const realClock = (): number => performance.now();

/**
 * The one queue every MusicBrainz request goes through. It runs one request at a time, and starts
 * the next one no sooner than `intervalMs` after the last one ended. That keeps the rate under
 * the one request a second that MusicBrainz allows, even when a caller asks for many at once.
 * `holdFor` is the one global cool-down: whoever asks for a wait delays every later request.
 */
export class RateLimitedQueue {
  /** Requests sent so far. */
  requests = 0;
  private nextAt = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly intervalMs: number = MB_MIN_INTERVAL_MS,
    private readonly sleep: (ms: number) => Promise<void> = realSleep,
    private readonly clock: () => number = realClock,
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      // A timer can fire a little early, so check the clock again after each sleep.
      for (let wait = this.nextAt - this.clock(); wait > 0; wait = this.nextAt - this.clock()) {
        await this.sleep(wait);
      }
      this.requests += 1;
      try {
        return await task();
      } finally {
        this.holdFor(this.intervalMs);
      }
    });
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Delay the next request to at least `ms` from now. It never brings the next request closer. */
  holdFor(ms: number): void {
    this.nextAt = Math.max(this.nextAt, this.clock() + ms);
  }
}

export type SearchEntity = "recording" | "release-group" | "artist";

/**
 * The answer to a search, or the reason there is none. The three are never mixed up:
 * - ok: the candidates, and whether they came from the cache;
 * - unavailable: MusicBrainz could not answer after every try. `kind` is a fixed word (http_503, dns, timeout...);
 * - rejected: MusicBrainz refused this one question (a 4xx other than 401, 403 and 429). It is this item's problem.
 */
export type SearchResult =
  | { outcome: "ok"; candidates: Candidate[]; cached: boolean }
  | { outcome: "unavailable"; kind: string }
  | { outcome: "rejected"; status: number };

type Attempt =
  | { type: "response"; status: number; text: string | null; retryAfterMs: number | undefined }
  | { type: "error"; kind: string };

/** Busy (429) and any server error (5xx) are worth another try. */
const retryable = (status: number): boolean => status === 429 || status >= 500;

/**
 * Retry-After is a number of seconds, or an HTTP date. A longer wait than MB_RETRY_AFTER_MAX_MS is cut to it.
 * A value that is neither is ignored.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (header === null) return undefined;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Math.min(Number(text) * 1000, MB_RETRY_AFTER_MAX_MS);
  const date = Date.parse(text);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - Date.now(), 0), MB_RETRY_AFTER_MAX_MS);
}

/**
 * Names a network failure with a fixed word. It never returns the error's own text, which can hold a host,
 * an address or a path. Node's fetch throws a TypeError whose `cause` is the system error with its `code`.
 */
export function failureKind(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause = error instanceof Error ? (error as { cause?: unknown }).cause : undefined;
  const code = typeof (cause as { code?: unknown } | undefined)?.code === "string" ? (cause as { code: string }).code : "";
  const message = cause instanceof Error ? cause.message : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "dns";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return "connection_reset";
  if (code.startsWith("CERT_") || code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || /^(UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO|HOSTNAME_MISMATCH)/.test(code)) return "tls";
  if (/redirect/i.test(message)) return "redirect";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT" || code === "UND_ERR_BODY_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  return "network";
}

/** Reads a body as text, and returns null as soon as it passes `max` bytes, without reading the rest. */
async function readCapped(response: Response, max: number): Promise<string | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export type MusicBrainzOptions = {
  base: string;
  userAgent: string;
  cache: Cache;
  queue?: RateLimitedQueue;
  fetch?: typeof fetch;
  /**
   * Runs before every HTTP attempt, retries included, and before the wait that attempt may need.
   * The command uses it to refresh its lock lease, and it throws when the lock is lost, which stops the lookup.
   */
  beforeAttempt?: () => Promise<void>;
};

/**
 * Searches MusicBrainz through the queue and the cache.
 *
 * MusicBrainz asks for: JSON (fmt=json), a User-Agent that says who calls and how to reach them,
 * and never more than one request a second. A 503 means the limit was passed or the service is busy.
 * Search takes `limit` from 1 to 100, and gives each hit a `score`.
 */
export class MusicBrainz {
  /** Searches answered from the cache. */
  cacheHits = 0;
  private readonly base: string;
  private readonly queue: RateLimitedQueue;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: MusicBrainzOptions) {
    this.base = options.base.replace(/\/+$/, "");
    this.queue = options.queue ?? new RateLimitedQueue();
    this.fetchImpl = options.fetch ?? fetch;
  }

  /** Requests sent to MusicBrainz so far, retries included. */
  get requests(): number {
    return this.queue.requests;
  }

  /**
   * `parse` turns an answer into candidates, and throws a UserError when the answer has the wrong shape.
   * Only the candidates of an answer that parses are cached.
   *
   * Throws a UserError for what no later item can fix: a 401 or 403, an answer that is not JSON, in the wrong
   * shape, or over MB_MAX_RESPONSE_BYTES, and any other unexpected status.
   */
  async search(entity: SearchEntity, query: string, parse: (body: unknown) => Candidate[]): Promise<SearchResult> {
    const params = new URLSearchParams({ query, fmt: "json", limit: String(MB_MATCH_FETCH_LIMIT) });
    const url = `${this.base}/${entity}?${params.toString()}`;

    const cached = await this.options.cache.get(url);
    if (cached !== undefined) {
      try {
        const candidates = readCandidates(cached);
        this.cacheHits += 1;
        return { outcome: "ok", candidates, cached: true };
      } catch {
        // A row in a shape this command does not read is dropped, and the answer is fetched again.
        await this.options.cache.remove(url);
      }
    }

    let kind = "network";
    for (let attempt = 1; attempt <= MB_MAX_ATTEMPTS; attempt += 1) {
      // The lease is refreshed first, so the wait this attempt may have to sit through (a Retry-After) is inside it.
      await this.options.beforeAttempt?.();
      const result = await this.queue.run(() => this.attempt(url));

      if (result.type === "response") {
        if (result.status === 200) {
          if (result.text === null) {
            throw new UserError("MusicBrainz sent an answer larger than the 1 MB this command reads. Nothing was stored for it.");
          }
          let body: unknown;
          try {
            body = JSON.parse(result.text);
          } catch {
            throw new UserError("MusicBrainz sent an answer that is not JSON. Nothing was stored for it. Run the command again later.");
          }
          const candidates = parse(body);
          await this.options.cache.put(url, candidates);
          return { outcome: "ok", candidates, cached: false };
        }
        if (result.status === 401 || result.status === 403) {
          throw new UserError(
            `MusicBrainz refused a request (status ${result.status}). Check MB_USER_AGENT and MB_API_BASE, then run the command again: items already settled are kept.`,
          );
        }
        if (result.status >= 400 && result.status < 500 && result.status !== 429) {
          return { outcome: "rejected", status: result.status };
        }
        if (!retryable(result.status)) {
          throw new UserError(`MusicBrainz sent an unexpected status (${result.status}). Nothing was stored for it. Run the command again later.`);
        }
        kind = `http_${result.status}`;
      } else {
        kind = result.kind;
      }

      // Wait the growing backoff, or the Retry-After if it is longer. After the last try there is no backoff,
      // but a Retry-After still holds the queue, so the next item is not sent into a server that said wait.
      const retryAfter = result.type === "response" ? (result.retryAfterMs ?? 0) : 0;
      const backoff = attempt < MB_MAX_ATTEMPTS ? MB_BACKOFF_BASE_MS * 2 ** (attempt - 1) : 0;
      this.queue.holdFor(Math.max(backoff, retryAfter));
    }
    return { outcome: "unavailable", kind };
  }

  /** One request. A network failure or a timeout is an error with a fixed kind, so the caller treats it as unavailable. */
  private async attempt(url: string): Promise<Attempt> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { "User-Agent": this.options.userAgent, Accept: "application/json" },
        // A redirect is an error: the command never follows one to another host.
        redirect: "error",
        signal: AbortSignal.timeout(MB_REQUEST_TIMEOUT_MS),
      });
      const retryAfter = retryAfterMs(response.headers.get("retry-after"));
      if (response.status !== 200) {
        await response.body?.cancel();
        return { type: "response", status: response.status, text: null, retryAfterMs: retryAfter };
      }
      return { type: "response", status: 200, text: await readCapped(response, MB_MAX_RESPONSE_BYTES), retryAfterMs: retryAfter };
    } catch (error) {
      return { type: "error", kind: failureKind(error) };
    }
  }
}

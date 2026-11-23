import { UserError } from "./files.ts";
import {
  MB_BACKOFF_BASE_MS,
  MB_MAX_ATTEMPTS,
  MB_MIN_INTERVAL_MS,
  MB_REQUEST_TIMEOUT_MS,
  MB_RETRY_AFTER_MAX_MS,
} from "./settings.ts";

/** Every answer MusicBrainz gave, kept by request, so a repeat lookup sends nothing. */
export type Cache = {
  get(key: string): Promise<unknown>;
  put(key: string, body: unknown): Promise<void>;
};

const realSleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));
const realClock = (): number => performance.now();

/**
 * The one queue every MusicBrainz request goes through. It runs one request at a time, and starts
 * the next one no sooner than `intervalMs` after the last one ended. That keeps the rate under
 * the one request a second that MusicBrainz allows, even when a caller asks for many at once.
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

/** The answer to a search, or the fact that MusicBrainz could not answer. The two are never mixed up. */
export type SearchResult<T> = { outcome: "ok"; value: T } | { outcome: "unavailable" };

type Attempt = { status: number; text: string; retryAfterMs: number | undefined };

/** Statuses worth another try: busy (429, 503) and other transient server errors. */
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

function retryAfterMs(header: string | null): number | undefined {
  if (header === null || !/^\d+$/.test(header.trim())) return undefined;
  return Math.min(Number(header.trim()) * 1000, MB_RETRY_AFTER_MAX_MS);
}

export type MusicBrainzOptions = {
  base: string;
  userAgent: string;
  cache: Cache;
  queue?: RateLimitedQueue;
  fetch?: typeof fetch;
};

/**
 * Searches MusicBrainz through the queue and the cache.
 *
 * MusicBrainz asks for: JSON (fmt=json), a User-Agent that says who calls and how to reach them,
 * and never more than one request a second. A 503 means the limit was passed or the service is busy.
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
   * `parse` turns an answer into a value, and throws a UserError when the answer has the wrong shape.
   * Only an answer that parses is cached.
   */
  async search<T>(entity: SearchEntity, query: string, parse: (body: unknown) => T): Promise<SearchResult<T>> {
    const params = new URLSearchParams({ query, fmt: "json", limit: "1" });
    const url = `${this.base}/${entity}?${params.toString()}`;

    const cached = await this.options.cache.get(url);
    if (cached !== undefined) {
      this.cacheHits += 1;
      return { outcome: "ok", value: parse(cached) };
    }

    for (let attempt = 1; attempt <= MB_MAX_ATTEMPTS; attempt += 1) {
      const result = await this.queue.run(() => this.attempt(url));
      if (result.status === 200) {
        let body: unknown;
        try {
          body = JSON.parse(result.text);
        } catch {
          throw new UserError("MusicBrainz sent an answer that is not JSON. Nothing was stored for it. Run the command again later.");
        }
        const value = parse(body);
        await this.options.cache.put(url, body);
        return { outcome: "ok", value };
      }
      if (result.status !== 0 && !RETRYABLE.has(result.status)) {
        throw new UserError(
          `MusicBrainz refused a request (status ${result.status}). Check MB_USER_AGENT and MB_API_BASE, then run the command again: items already settled are kept.`,
        );
      }
      if (attempt < MB_MAX_ATTEMPTS) {
        const backoff = MB_BACKOFF_BASE_MS * 2 ** (attempt - 1);
        this.queue.holdFor(Math.max(backoff, result.retryAfterMs ?? 0));
      }
    }
    return { outcome: "unavailable" };
  }

  /** One request. A network failure or a timeout is status 0, so the caller treats it as unavailable. */
  private async attempt(url: string): Promise<Attempt> {
    try {
      const response = await this.fetchImpl(url, {
        headers: { "User-Agent": this.options.userAgent, Accept: "application/json" },
        signal: AbortSignal.timeout(MB_REQUEST_TIMEOUT_MS),
      });
      const text = await response.text();
      return { status: response.status, text, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
    } catch {
      return { status: 0, text: "", retryAfterMs: undefined };
    }
  }
}

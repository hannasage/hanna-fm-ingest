import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { UserError } from "../src/files.ts";
import { parseCandidates } from "../src/matching.ts";
import {
  MB_CACHE_MAX_AGE_MS,
  MB_MATCH_FETCH_LIMIT,
  MB_MAX_RESPONSE_BYTES,
  MB_RETRY_AFTER_MAX_MS,
} from "../src/settings.ts";
import { clearTables, id } from "./support/data.ts";
import { adminClient } from "./support/env.ts";
import { answer } from "./support/fake-mb.ts";
import { inProcess, networkError, USER_AGENT } from "./support/inproc.ts";

const db = adminClient();
const parse = (body: unknown) => parseCandidates(body, "artists", "name");
const QUERY = 'artist:"SYNTH Artist"';
const OK = { status: 200, body: answer.artist({ id: id(1), score: 100, name: "SYNTH Artist" }) };

beforeEach(async () => {
  await clearTables(db);
});

describe("request", () => {
  it("asks for JSON, the first MB_MATCH_FETCH_LIMIT hits, the exact User-Agent, and refuses redirects", async () => {
    const { musicbrainz, calls } = inProcess(db, () => OK);

    await musicbrainz.search("artist", QUERY, parse);

    expect(MB_MATCH_FETCH_LIMIT).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params.get("fmt")).toBe("json");
    expect(calls[0]?.params.get("limit")).toBe("5");
    expect(calls[0]?.userAgent).toBe(USER_AGENT);
    expect(calls[0]?.accept).toBe("application/json");
    expect(calls[0]?.redirect).toBe("error");
  });

  it("returns every candidate, and says whether it came from the cache", async () => {
    const { musicbrainz } = inProcess(db, () => OK);

    const first = await musicbrainz.search("artist", QUERY, parse);
    const second = await musicbrainz.search("artist", QUERY, parse);

    expect(first).toMatchObject({ outcome: "ok", cached: false });
    expect(second).toMatchObject({ outcome: "ok", cached: true });
    expect(first.outcome === "ok" && first.candidates).toEqual([{ mbid: id(1), score: 100, name: "SYNTH Artist", aliases: [], credits: [] }]);
    expect(musicbrainz.cacheHits).toBe(1);
  });
});

describe("cache", () => {
  it("keys each answer by the SHA-256 of the request URL, and keeps only the parsed candidates", async () => {
    const { musicbrainz, calls } = inProcess(db, () => OK);

    await musicbrainz.search("artist", QUERY, parse);

    const { data, error } = await db.from("mb_cache").select("*");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
    const row = data![0] as { request_hash: string; candidates: unknown };
    expect(row.request_hash).toBe(createHash("sha256").update(calls[0]!.url).digest("hex"));
    expect(row.candidates).toEqual([{ mbid: id(1), score: 100, name: "SYNTH Artist", aliases: [], credits: [] }]);
    expect(JSON.stringify(row)).not.toContain("created");
  });

  it("caches a lookup for a very long name, which would overflow an index row if the key were the text", async () => {
    const long = "x".repeat(20_000);
    const { musicbrainz } = inProcess(db, () => OK);

    const result = await musicbrainz.search("artist", `artist:"${long}"`, parse);

    expect(result.outcome).toBe("ok");
    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(1);
  });

  it("expires an answer after 90 days, measured from fetched_at, and fetches it again", async () => {
    expect(MB_CACHE_MAX_AGE_MS).toBe(90 * 24 * 60 * 60 * 1000);
    const { musicbrainz, calls } = inProcess(db, () => OK);
    await musicbrainz.search("artist", QUERY, parse);

    const ago = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    await db.from("mb_cache").update({ fetched_at: ago(89) }).neq("request_hash", "");
    await musicbrainz.search("artist", QUERY, parse);
    expect(calls).toHaveLength(1);

    await db.from("mb_cache").update({ fetched_at: ago(91) }).neq("request_hash", "");
    const again = await musicbrainz.search("artist", QUERY, parse);
    expect(calls).toHaveLength(2);
    expect(again).toMatchObject({ outcome: "ok", cached: false });
    const { data } = await db.from("mb_cache").select("fetched_at");
    expect(Date.now() - new Date((data![0] as { fetched_at: string }).fetched_at).getTime()).toBeLessThan(60_000);
  });

  it("deletes a cached row that does not parse, and fetches it again", async () => {
    const { musicbrainz, calls } = inProcess(db, () => OK);
    await musicbrainz.search("artist", QUERY, parse);
    await db.from("mb_cache").update({ candidates: { recordings: [] } }).neq("request_hash", "");

    const result = await musicbrainz.search("artist", QUERY, parse);

    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({ outcome: "ok", cached: false });
    const { data } = await db.from("mb_cache").select("candidates");
    expect(data).toEqual([{ candidates: [{ mbid: id(1), score: 100, name: "SYNTH Artist", aliases: [], credits: [] }] }]);
  });

  it("caches nothing for an answer that is not usable", async () => {
    for (const reply of [{ status: 200, text: "<html>" }, { status: 200, body: { count: 1 } }, { status: 503 }, { status: 400 }]) {
      const { musicbrainz } = inProcess(db, () => reply);
      await musicbrainz.search("artist", QUERY, parse).catch(() => undefined);
    }
    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });
});

describe("response size", () => {
  const padded = (bytes: number): string => {
    const base = JSON.stringify({ count: 0, offset: 0, artists: [], pad: "" });
    return JSON.stringify({ count: 0, offset: 0, artists: [], pad: "x".repeat(bytes - Buffer.byteLength(base)) });
  };

  it("reads an answer of exactly MB_MAX_RESPONSE_BYTES, and refuses one byte more, with nothing cached", async () => {
    expect(MB_MAX_RESPONSE_BYTES).toBe(1024 * 1024);
    const exact = padded(MB_MAX_RESPONSE_BYTES);
    expect(Buffer.byteLength(exact)).toBe(MB_MAX_RESPONSE_BYTES);
    const fits = inProcess(db, () => ({ status: 200, text: exact }));
    expect(await fits.musicbrainz.search("artist", QUERY, parse)).toMatchObject({ outcome: "ok", candidates: [] });

    await clearTables(db);
    const over = inProcess(db, () => ({ status: 200, text: padded(MB_MAX_RESPONSE_BYTES + 1) }));
    await expect(over.musicbrainz.search("artist", QUERY, parse)).rejects.toThrow(UserError);
    const { count } = await db.from("mb_cache").select("*", { count: "exact", head: true });
    expect(count).toBe(0);
  });
});

describe("answers that cannot be used", () => {
  it.each([
    ["text that is not JSON", { status: 200, text: "<html>" }],
    ["an answer with no result list", { status: 200, body: { count: 1 } }],
    ["a status of 204", { status: 204 }],
  ])("stops the run for %s", async (_name, reply) => {
    const { musicbrainz } = inProcess(db, () => reply);
    await expect(musicbrainz.search("artist", QUERY, parse)).rejects.toThrow(UserError);
  });

  it.each([401, 403])("stops the run for a %i, and says what to check", async (status) => {
    const { musicbrainz, calls } = inProcess(db, () => ({ status }));
    await expect(musicbrainz.search("artist", QUERY, parse)).rejects.toThrow(/status \d+.*MB_USER_AGENT/);
    expect(calls).toHaveLength(1);
  });

  it.each([400, 404, 414, 422])("settles only this lookup, with no retry, for a %i", async (status) => {
    const { musicbrainz, calls } = inProcess(db, () => ({ status, body: { error: "synthetic" } }));
    expect(await musicbrainz.search("artist", QUERY, parse)).toEqual({ outcome: "rejected", status });
    expect(calls).toHaveLength(1);
  });
});

describe("unavailable, and why", () => {
  it.each([
    ["a 503", "http_503", { status: 503 }],
    ["a 429", "http_429", { status: 429 }],
    ["a 500", "http_500", { status: 500 }],
    ["a 502", "http_502", { status: 502 }],
    ["a 504", "http_504", { status: 504 }],
    ["an unlisted 5xx", "http_507", { status: 507 }],
    ["a name that does not resolve", "dns", { fail: networkError("ENOTFOUND", "getaddrinfo ENOTFOUND musicbrainz.invalid") }],
    ["a name lookup that times out", "dns", { fail: networkError("EAI_AGAIN", "getaddrinfo EAI_AGAIN") }],
    ["a refused connection", "connection_refused", { fail: networkError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:1") }],
    ["a reset connection", "connection_reset", { fail: networkError("ECONNRESET", "read ECONNRESET") }],
    ["a certificate that cannot be verified", "tls", { fail: networkError("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify") }],
    ["an expired certificate", "tls", { fail: networkError("CERT_HAS_EXPIRED", "certificate has expired") }],
    ["a timeout", "timeout", { fail: new DOMException("The operation was aborted due to timeout", "TimeoutError") }],
    ["a redirect", "redirect", { fail: Object.assign(new TypeError("fetch failed"), { cause: new Error("unexpected redirect") }) }],
    ["any other failure", "network", { fail: new Error("something with a secret in it") }],
  ])("tries three times, then reports %s as unavailable with the kind %s", async (_name, kind, reply) => {
    const { musicbrainz, calls } = inProcess(db, () => reply);

    const result = await musicbrainz.search("artist", QUERY, parse);

    expect(result).toEqual({ outcome: "unavailable", kind });
    expect(calls).toHaveLength(3);
  });

  it("reports only a fixed kind, never the text of the error, the host or the URL", async () => {
    const { musicbrainz } = inProcess(db, () => ({ fail: networkError("ENOTFOUND", "getaddrinfo ENOTFOUND secret-host.invalid") }));
    const result = await musicbrainz.search("artist", QUERY, parse);
    expect(JSON.stringify(result)).not.toMatch(/secret|invalid|musicbrainz/);
  });

  it("waits 1 s, then 2 s, between the three tries, and 1 s before the next lookup", async () => {
    const { musicbrainz, calls } = inProcess(db, () => ({ status: 503 }));

    await musicbrainz.search("artist", QUERY, parse);
    await musicbrainz.search("artist", 'artist:"SYNTH Other"', parse);

    const gaps = calls.slice(1).map((call, index) => call.at - calls[index]!.at);
    expect(gaps).toEqual([1000, 2000, 1000, 1000, 2000]);
  });

  it("settles when a retry works", async () => {
    const { musicbrainz, calls } = inProcess(db, (_call, count) => (count < 3 ? { status: 503 } : OK));
    expect(await musicbrainz.search("artist", QUERY, parse)).toMatchObject({ outcome: "ok" });
    expect(calls).toHaveLength(3);
  });
});

describe("Retry-After and the one global cool-down", () => {
  it("honours a Retry-After in seconds, and a longer one wins over the growing wait", async () => {
    const { musicbrainz, calls } = inProcess(db, (_call, count) =>
      count === 1 ? { status: 503, headers: { "retry-after": "7" } } : OK,
    );

    await musicbrainz.search("artist", QUERY, parse);

    expect(calls[1]!.at - calls[0]!.at).toBe(7000);
  });

  it("honours Retry-After after the last try too, so the next lookup is not sent into a server that said wait", async () => {
    const { musicbrainz, calls } = inProcess(db, (_call, count) =>
      count <= 3 ? { status: 503, headers: { "retry-after": "9" } } : OK,
    );

    const first = await musicbrainz.search("artist", QUERY, parse);
    const second = await musicbrainz.search("artist", 'artist:"SYNTH Other"', parse);

    expect(first).toMatchObject({ outcome: "unavailable" });
    expect(second).toMatchObject({ outcome: "ok" });
    expect(calls).toHaveLength(4);
    expect(calls[3]!.at - calls[2]!.at).toBe(9000);
  });

  it("reads Retry-After given as an HTTP date", async () => {
    const date = new Date(Date.now() + 20_000).toUTCString();
    const { musicbrainz, calls } = inProcess(db, (_call, count) =>
      count === 1 ? { status: 429, headers: { "retry-after": date } } : OK,
    );

    await musicbrainz.search("artist", QUERY, parse);

    // The date has whole seconds, and a few seconds may pass while the test runs.
    expect(calls[1]!.at - calls[0]!.at).toBeGreaterThan(14_000);
    expect(calls[1]!.at - calls[0]!.at).toBeLessThanOrEqual(20_000);
  });

  it("cuts a wait longer than MB_RETRY_AFTER_MAX_MS to that cap of 120 seconds, and ignores a header it cannot read", async () => {
    expect(MB_RETRY_AFTER_MAX_MS).toBe(120_000);
    const { musicbrainz, calls } = inProcess(db, (_call, count) =>
      count === 1 ? { status: 503, headers: { "retry-after": "86400" } } : count === 2 ? { status: 503, headers: { "retry-after": "soon" } } : OK,
    );

    await musicbrainz.search("artist", QUERY, parse);

    expect(calls[1]!.at - calls[0]!.at).toBe(MB_RETRY_AFTER_MAX_MS);
    expect(calls[2]!.at - calls[1]!.at).toBe(2000);
  });
});

describe("the lease, refreshed before every attempt", () => {
  it("runs the hook before each try, retries included, and before nothing else", async () => {
    const log: string[] = [];
    const { musicbrainz } = inProcess(
      db,
      (_call, count) => {
        log.push(`send ${count}`);
        return count < 3 ? { status: 503 } : OK;
      },
      { beforeAttempt: async () => void log.push("refresh") },
    );

    await musicbrainz.search("artist", QUERY, parse);
    // A repeat is answered from the cache: no request, so no refresh.
    await musicbrainz.search("artist", QUERY, parse);

    expect(log).toEqual(["refresh", "send 1", "refresh", "send 2", "refresh", "send 3"]);
  });

  it("stops the lookup when the hook says the lock is lost, and sends nothing more", async () => {
    let refreshes = 0;
    const { musicbrainz, calls } = inProcess(db, () => ({ status: 503 }), {
      beforeAttempt: async () => {
        refreshes += 1;
        if (refreshes === 2) throw new UserError("lock lost");
      },
    });

    await expect(musicbrainz.search("artist", QUERY, parse)).rejects.toThrow("lock lost");
    expect(calls).toHaveLength(1);
  });

  it("never lets one item outlive the lease: a Retry-After of ten minutes waits 120 seconds, and each try starts with a fresh lease", async () => {
    const LEASE_MS = 200_000;
    let expiresAt = 0;
    const lapsed: number[] = [];
    const harness = inProcess(
      db,
      (call) => {
        if (call.at >= expiresAt) lapsed.push(call.at);
        return { status: 503, headers: { "retry-after": "600" } };
      },
      { beforeAttempt: async () => void (expiresAt = harness.clock.now + LEASE_MS) },
    );

    await harness.musicbrainz.search("artist", QUERY, parse);

    expect(harness.calls.map((call) => call.at)).toEqual([0, 120_000, 240_000]);
    expect(lapsed).toEqual([]);
  });
});

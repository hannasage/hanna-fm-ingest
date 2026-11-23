import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_SCOPES, SPOTIFY_REDIRECT_URI } from "../src/settings.ts";
import { loginMessages, loginRedirectUri, runLogin } from "../src/spotify-login.ts";
import { setState } from "../src/set-state.ts";
import { adminClient } from "./support/env.ts";
import { deadAddress, json, startFakeSpotify, type Answer, type FakeSpotify, type Handler } from "./support/fake-spotify.ts";
import {
  ACCESS_TOKEN,
  BODY_MARKER,
  CLIENT_ID,
  CLIENT_SECRET,
  CODE,
  REFRESH_TOKEN,
  expectNoSecrets,
  freePort,
  hit,
  isClosed,
  occupy,
  startLogin,
  type Started,
} from "./support/login-harness.ts";
import { SPOTIFY_SCOPE_NAMES } from "./support/spotify-scopes.ts";

// Real HTTP to the helper's listener, a fake Spotify accounts server, synthetic data only.
// The TTY check is injected here (`isTty`). The real pseudo terminal run is in spotify-login-cli.test.ts.

const GOOD_TOKEN = {
  access_token: ACCESS_TOKEN,
  token_type: "Bearer",
  scope: LOGIN_SCOPES.join(" "),
  expires_in: 3600,
  refresh_token: REFRESH_TOKEN,
};

let fake: FakeSpotify;
let answer: Handler;

beforeEach(async () => {
  answer = () => json(GOOD_TOKEN);
  fake = await startFakeSpotify({ token: (seen) => answer(seen), recent: () => json({}, 500) });
});

afterEach(async () => {
  await fake.close();
});

/** No output holds the client secret, the code, the access token or any word of a response body. */
function expectClean(run: Started): void {
  expect(expectNoSecrets(run.all())).toEqual([]);
}

function tokenLines(run: Started): string[] {
  return run.out.join("").split("\n").filter((line) => line.startsWith("SPOTIFY_REFRESH_TOKEN="));
}

describe("the settings", () => {
  it("names the redirect address the app owner registered", () => {
    expect(SPOTIFY_REDIRECT_URI).toBe("http://127.0.0.1:8765/callback");
  });

  it("asks for three scopes, each on Spotify's Scopes page", () => {
    expect([...LOGIN_SCOPES]).toEqual(["user-read-recently-played", "user-read-currently-playing", "playlist-read-private"]);
    for (const scope of LOGIN_SCOPES) expect(SPOTIFY_SCOPE_NAMES).toContain(scope);
  });

  it("changes only the port when SPOTIFY_LOGIN_PORT is set", () => {
    expect(loginRedirectUri(undefined)).toBe(SPOTIFY_REDIRECT_URI);
    expect(loginRedirectUri("")).toBe(SPOTIFY_REDIRECT_URI);
    expect(loginRedirectUri("9001")).toBe("http://127.0.0.1:9001/callback");
  });

  it.each(["0", "80", "1023", "65536", "-1", "abc", "8765x", "87.65", " 8765", "0x2255", "1e4"])("refuses the port %j", (port) => {
    expect(() => loginRedirectUri(port)).toThrow(loginMessages.badPort);
  });
});

describe("the authorization URL", () => {
  it("carries the exact client id, redirect address, scopes and a state", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 400 });
    const params = run.authorizeUrl.searchParams;
    expect(`${run.authorizeUrl.origin}${run.authorizeUrl.pathname}`).toBe(`${fake.url}/authorize`);
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(run.redirectUri);
    expect(params.get("scope")).toBe("user-read-recently-played user-read-currently-playing playlist-read-private");
    expect([...params.keys()].sort()).toEqual(["client_id", "redirect_uri", "response_type", "scope", "state"]);
    expect(run.state).not.toBe("");
    await run.done;
    expectClean(run);
  });

  it("uses a state of at least 128 bits, new every run", async () => {
    const first = await startLogin(fake.url, { timeoutMs: 300 });
    const second = await startLogin(fake.url, { timeoutMs: 300 });
    for (const run of [first, second]) {
      expect(run.state).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(Buffer.from(run.state, "base64url").length).toBeGreaterThanOrEqual(16);
    }
    expect(first.state).not.toBe(second.state);
    await Promise.all([first.done, second.done]);
  });

  it("never prints the client secret", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 300 });
    await run.done;
    expect(run.all()).not.toContain(CLIENT_SECRET);
  });
});

describe("a good callback", () => {
  it("exchanges the code and prints the scopes and the refresh token line, once", async () => {
    const run = await startLogin(fake.url);
    const reply = await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(reply.status).toBe(200);
    expect(reply.body).not.toContain(CODE);
    expect(await run.done).toBe(0);

    expect(fake.tokenRequests).toHaveLength(1);
    const seen = fake.tokenRequests[0]!;
    expect(seen.method).toBe("POST");
    expect(seen.path).toBe("/api/token");
    expect(seen.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(seen.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    const form = new URLSearchParams(seen.body);
    expect([...form.keys()].sort()).toEqual(["code", "grant_type", "redirect_uri"]);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE);
    expect(form.get("redirect_uri")).toBe(run.redirectUri);

    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expect(run.out.join("")).toContain(`Granted scopes: ${LOGIN_SCOPES.join(" ")}`);
    expect(run.all().split(REFRESH_TOKEN)).toHaveLength(2);
    expect(run.all()).not.toContain(ACCESS_TOKEN);
    expectClean(run);
    expect(await isClosed(run.port)).toBe(true);
  });

  it("says plainly when a requested scope was not granted", async () => {
    answer = () => json({ ...GOOD_TOKEN, scope: "user-read-recently-played" });
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    const err = run.err.join("");
    expect(err).toContain("user-read-currently-playing");
    expect(err).toContain("playlist-read-private");
    expectClean(run);
  });
});

describe("a callback that is not accepted", () => {
  it.each([
    ["a wrong state", (run: Started) => run.callback({ code: CODE, state: `${run.state}x` })],
    ["a state of another length", (run: Started) => run.callback({ code: CODE, state: "a" })],
    ["a missing state", (run: Started) => run.callback({ code: CODE })],
    ["an empty state", (run: Started) => run.callback({ code: CODE, state: "" })],
    ["a doubled state", (run: Started) => `/callback?code=${CODE}&state=${run.state}&state=${run.state}`],
    ["a missing code", (run: Started) => run.callback({ state: run.state })],
    ["an empty code", (run: Started) => run.callback({ code: "", state: run.state })],
  ])("stops on %s: no exchange, exit 1, listener closed", async (_name, query) => {
    const run = await startLogin(fake.url);
    const reply = await hit(run.port, query(run));
    expect(reply.status).toBe(400);
    expect(await run.done).toBe(1);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(tokenLines(run)).toEqual([]);
    expectClean(run);
    expect(await isClosed(run.port)).toBe(true);
  });

  it("refuses a second request to the callback once the first came", async () => {
    // The token answer waits, so the second request arrives while the exchange is in flight.
    let release: (value: Answer) => void = () => undefined;
    answer = () => new Promise<Answer>((resolve) => (release = resolve));
    const run = await startLogin(fake.url);

    const first = await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(first.status).toBe(200);
    await expect(hit(run.port, run.callback({ code: CODE, state: run.state }))).rejects.toThrow("ECONNREFUSED");
    await expect(hit(run.port, run.callback({ code: "SYNTH_OTHER", state: "other" }))).rejects.toThrow("ECONNREFUSED");

    release(json(GOOD_TOKEN));
    expect(await run.done).toBe(0);
    expect(fake.tokenRequests).toHaveLength(1);
    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expectClean(run);
  });

  it("does not let a second request change a failed run", async () => {
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: "wrong" }));
    await expect(hit(run.port, run.callback({ code: CODE, state: run.state }))).rejects.toThrow("ECONNREFUSED");
    expect(await run.done).toBe(1);
    expect(fake.tokenRequests).toHaveLength(0);
  });
});

describe("the other paths", () => {
  it.each(["/", "/favicon.ico", "/callback/", "/callbackx", "/callback/extra", "/Callback", "/authorize", "//callback", "/%63allback"])(
    "answers %s with 404 and keeps waiting",
    async (path) => {
      const run = await startLogin(fake.url);
      const reply = await hit(run.port, `${path}?code=${CODE}&state=${run.state}`);
      expect(reply.status).toBe(404);
      expect(reply.body).not.toContain(CODE);
      expect(fake.tokenRequests).toHaveLength(0);
      // The real callback still works: the 404 did not use up the one request.
      expect((await hit(run.port, run.callback({ code: CODE, state: run.state }))).status).toBe(200);
      expect(await run.done).toBe(0);
      expectClean(run);
    },
  );

  it("answers a request that is not a GET with 405 and keeps waiting", async () => {
    const run = await startLogin(fake.url);
    expect((await hit(run.port, run.callback({ code: CODE, state: run.state }), "POST")).status).toBe(405);
    expect(fake.tokenRequests).toHaveLength(0);
    expect((await hit(run.port, run.callback({ code: CODE, state: run.state }))).status).toBe(200);
    expect(await run.done).toBe(0);
  });
});

describe("a refusal from Spotify", () => {
  it("stops on access_denied with a plain message and exit 1", async () => {
    const run = await startLogin(fake.url);
    const reply = await hit(run.port, run.callback({ error: "access_denied", state: run.state }));
    expect(reply.status).toBe(400);
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.denied}\n`);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(tokenLines(run)).toEqual([]);
    expect(await isClosed(run.port)).toBe(true);
    expectClean(run);
  });

  it("stops on any other error, and does not repeat the value it was given", async () => {
    const run = await startLogin(fake.url);
    const hostile = "\u001b[31mSYNTH_ESCAPE";
    await hit(run.port, run.callback({ error: hostile, state: run.state }));
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.refused}\n`);
    expect(run.all()).not.toContain("SYNTH_ESCAPE");
    expect(run.all()).not.toContain("\u001b");
  });

  it("stops on an error even when a code comes with it", async () => {
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ error: "server_error", code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(fake.tokenRequests).toHaveLength(0);
    expectClean(run);
  });

  it("checks the state before it reads an error", async () => {
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ error: "access_denied", state: "wrong" }));
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.badState}\n`);
  });
});

describe("a failure at the token endpoint", () => {
  const body = { error: "invalid_grant", error_description: BODY_MARKER, note: BODY_MARKER };

  it.each<[string, Answer]>([
    ["a 400 invalid_grant", json(body, 400)],
    ["a 400 invalid_client", json({ ...body, error: "invalid_client" }, 400)],
    ["a 401", json(body, 401)],
    ["a 429 with a retry hint", json(body, 429, { "retry-after": "30" })],
    ["a 500", { status: 500, body: `oops ${BODY_MARKER}` }],
    ["an answer that is not JSON", { status: 200, body: `<html>${BODY_MARKER}</html>` }],
    ["an answer that is JSON of the wrong shape", json([BODY_MARKER])],
    ["an answer larger than 1 MB", { status: 200, body: `{"note":"${BODY_MARKER}${"x".repeat(1024 * 1024)}"}` }],
  ])("exits 1 on %s and leaks no body", async (_name, reply) => {
    answer = () => reply;
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(tokenLines(run)).toEqual([]);
    expect(run.err.join("")).not.toBe("");
    expectClean(run);
    expect(run.all()).not.toContain("<html>");
  });

  it("says the code or the redirect address was refused on invalid_grant", async () => {
    answer = () => json(body, 400);
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.grant}\n`);
  });

  it("exits 1 when the answer has no refresh token, and prints no token line", async () => {
    answer = () => json({ access_token: ACCESS_TOKEN, token_type: "Bearer", scope: "x", expires_in: 3600, note: BODY_MARKER });
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.noRefreshToken}\n`);
    expect(tokenLines(run)).toEqual([]);
    expectClean(run);
  });

  it.each([
    ["an empty refresh token", ""],
    ["a refresh token that is not a string", 42],
    ["a refresh token with a line break", "SYNTH\nSPOTIFY_REFRESH_TOKEN=forged"],
    ["a refresh token with an escape character", "SYNTH\u001b[31m"],
    ["a refresh token with a space", "SYNTH TOKEN"],
  ])("refuses %s", async (_name, value) => {
    answer = () => json({ ...GOOD_TOKEN, refresh_token: value });
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(tokenLines(run)).toEqual([]);
    expect(run.all()).not.toContain("forged");
    expectClean(run);
  });

  it("does not follow a redirect", async () => {
    let followed = false;
    const target = await startFakeSpotify({
      token: () => {
        followed = true;
        return json(GOOD_TOKEN);
      },
      recent: () => json({}, 500),
    });
    answer = () => ({ status: 302, body: "", headers: { location: `${target.url}/api/token` } });
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(followed).toBe(false);
    expect(tokenLines(run)).toEqual([]);
    await target.close();
  });

  it("exits 1 with a plain message when Spotify cannot be reached", async () => {
    const dead = await deadAddress();
    const run = await startLogin(dead);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.network}\n`);
    expectClean(run);
  });
});

describe("waiting, and the listener", () => {
  it("gives up after the time limit, closes the listener and exits 1", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 300 });
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.timeout}\n`);
    expect(await isClosed(run.port)).toBe(true);
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("stops the time limit once the callback came", async () => {
    answer = () => json(GOOD_TOKEN);
    const run = await startLogin(fake.url, { timeoutMs: 1500 });
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
  });

  it("gives a plain message and exit 1 when the port is busy, and prints no URL", async () => {
    const port = await freePort();
    const busy = await occupy(port);
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runLogin({
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        accountsBase: fake.url,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        scopes: LOGIN_SCOPES,
        isTty: true,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        timeoutMs: 5000,
        recordAuthorized: null,
      });
      expect(code).toBe(1);
      expect(out.join("")).toBe("");
      expect(err.join("")).toBe(`${loginMessages.busy(port)}\n`);
      expect(err.join("")).toContain("SPOTIFY_LOGIN_PORT");
    } finally {
      await new Promise<void>((resolve) => busy.close(() => resolve()));
    }
  });

  const outside = Object.values(networkInterfaces())
    .flatMap((list) => list ?? [])
    .find((entry) => entry.family === "IPv4" && !entry.internal);

  it.skipIf(outside === undefined)("listens on 127.0.0.1 only, not on this computer's other address", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 1500 });
    const code = await new Promise<string>((resolve) => {
      const req = request({ host: outside!.address, port: run.port, path: "/callback", agent: false }, () => resolve("answered"));
      req.on("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
      req.end();
    });
    expect(code).toBe("ECONNREFUSED");
    await run.done;
  });
});

describe("a terminal that is not interactive", () => {
  it("refuses with exit 2 before it listens, and prints no token and no URL", async () => {
    const run = await startLogin(fake.url, { isTty: false });
    expect(await run.done).toBe(2);
    expect(run.out.join("")).toBe("");
    expect(run.err.join("")).toBe(`${loginMessages.notTerminal}\n`);
    expect(await isClosed(run.port)).toBe(true);
    expect(fake.tokenRequests).toHaveLength(0);
    expectClean(run);
  });
});

describe("recording when the login was authorized", () => {
  it("records today's date in UTC, through the set-state path, and still prints the token", async () => {
    const recorded: string[] = [];
    const run = await startLogin(fake.url, {
      now: () => new Date("2026-03-01T23:30:00-05:00"),
      recordAuthorized: async (date) => void recorded.push(date),
    });
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    // 23:30 in UTC minus 5 is 04:30 on the next UTC day.
    expect(recorded).toEqual(["2026-03-02"]);
    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expect(run.out.join("")).toContain("Recorded spotify_authorized_at.");
    expect(run.out.join("")).not.toContain("2026-03-02");
  });

  it("writes the row in the local database", async () => {
    const db = adminClient();
    await db.from("poller_state").delete().neq("key", "");
    const run = await startLogin(fake.url, {
      recordAuthorized: (date) => setState(db, "spotify_authorized_at", date),
    });
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    const { data } = await db.from("poller_state").select("key,value");
    expect(data).toEqual([{ key: "spotify_authorized_at", value: new Date().toISOString().slice(0, 10) }]);
  });

  it("prints a plain note and still exits 0 when recording fails, without the error text", async () => {
    const run = await startLogin(fake.url, {
      recordAuthorized: () => Promise.reject(new Error(`SYNTH_DB_ERROR ${BODY_MARKER}`)),
    });
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expect(run.err.join("")).toContain(loginMessages.notRecorded(new Date().toISOString().slice(0, 10)));
    expect(run.all()).not.toContain("SYNTH_DB_ERROR");
    expectClean(run);
  });

  it("tells the person the command to run when the database variables are not set", async () => {
    const run = await startLogin(fake.url, { recordAuthorized: null });
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    expect(run.err.join("")).toContain(`npm run set-state -- spotify_authorized_at ${new Date().toISOString().slice(0, 10)}`);
  });

  it("does not record when the login failed", async () => {
    answer = () => json({ error: "invalid_grant" }, 400);
    const recorded: string[] = [];
    const run = await startLogin(fake.url, { recordAuthorized: async (date) => void recorded.push(date) });
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(recorded).toEqual([]);
  });
});

import { request } from "node:http";
import { networkInterfaces } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATER_LOGIN_SCOPES, LOGIN_SCOPES, SPOTIFY_REDIRECT_URI } from "../src/settings.ts";
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
  challengeFor,
  expectNoSecrets,
  freePort,
  hit,
  hitRaw,
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

/**
 * A token answer that checks PKCE the way Spotify does: the form's code_verifier, hashed with SHA-256 and written
 * in base64url, must equal the code_challenge the authorization request carried. Otherwise it refuses the code.
 */
function checkingPkce(challenge: string | null): Handler {
  return (seen) => {
    const verifier = new URLSearchParams(seen.body).get("code_verifier");
    if (challenge === null || verifier === null || challengeFor(verifier) !== challenge) {
      return json({ error: "invalid_grant", error_description: BODY_MARKER }, 400);
    }
    return json(GOOD_TOKEN);
  };
}

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

  it("requests only the scope the poller needs, and it is on Spotify's Scopes page", () => {
    expect([...LOGIN_SCOPES]).toEqual(["user-read-recently-played"]);
    for (const scope of LOGIN_SCOPES) expect(SPOTIFY_SCOPE_NAMES).toContain(scope);
  });

  it("lists the scopes a later feature adds, each on Spotify's Scopes page, and requests none of them", () => {
    expect([...LATER_LOGIN_SCOPES]).toEqual(["user-read-currently-playing", "playlist-read-private"]);
    for (const scope of LATER_LOGIN_SCOPES) {
      expect(SPOTIFY_SCOPE_NAMES).toContain(scope);
      expect(LOGIN_SCOPES as readonly string[]).not.toContain(scope);
    }
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
    expect(params.get("scope")).toBe("user-read-recently-played");
    expect([...params.keys()].sort()).toEqual([
      "client_id",
      "code_challenge",
      "code_challenge_method",
      "redirect_uri",
      "response_type",
      "scope",
      "state",
    ]);
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

describe("PKCE", () => {
  it("sends an S256 code challenge with the authorization request", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 300 });
    const params = run.authorizeUrl.searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    // SHA-256 is 32 bytes: 43 characters of base64url with no padding.
    expect(params.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await run.done;
    expectClean(run);
  });

  it("sends the matching verifier with the token request, and keeps the client secret header", async () => {
    const run = await startLogin(fake.url);
    answer = checkingPkce(run.authorizeUrl.searchParams.get("code_challenge"));
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);

    expect(fake.tokenRequests).toHaveLength(1);
    const seen = fake.tokenRequests[0]!;
    expect(seen.headers.authorization).toBe(`Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`);
    const verifier = new URLSearchParams(seen.body).get("code_verifier") ?? "";
    expect(challengeFor(verifier)).toBe(run.authorizeUrl.searchParams.get("code_challenge"));
    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
  });

  it("uses a verifier of 128 characters from the set Spotify allows, new every run", async () => {
    const verifiers: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const run = await startLogin(fake.url);
      answer = checkingPkce(run.authorizeUrl.searchParams.get("code_challenge"));
      await hit(run.port, run.callback({ code: CODE, state: run.state }));
      expect(await run.done).toBe(0);
      verifiers.push(new URLSearchParams(fake.tokenRequests.at(-1)!.body).get("code_verifier") ?? "");
    }
    for (const verifier of verifiers) {
      // The page allows 43 to 128 characters of letters, digits, underscore, period, hyphen and tilde.
      expect(verifier).toMatch(/^[A-Za-z0-9._~-]{128}$/);
    }
    expect(verifiers[0]).not.toBe(verifiers[1]);
  });

  it("never prints the verifier, and never puts it in the authorization address", async () => {
    const run = await startLogin(fake.url);
    answer = checkingPkce(run.authorizeUrl.searchParams.get("code_challenge"));
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    const verifier = new URLSearchParams(fake.tokenRequests[0]!.body).get("code_verifier") ?? "";
    expect(verifier).not.toBe("");
    expect(run.all()).not.toContain(verifier);
    expect(run.authorizeUrl.href).not.toContain(verifier);
  });

  it("stops with the plain grant message when the server refuses the verifier", async () => {
    const run = await startLogin(fake.url);
    // The server holds the challenge of another verifier, so the one sent cannot match.
    answer = checkingPkce(challengeFor("SYNTH_OTHER_VERIFIER".padEnd(64, "x")));
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(fake.tokenRequests).toHaveLength(1);
    expect(run.err.join("")).toBe(`${loginMessages.grant}\n`);
    expect(tokenLines(run)).toEqual([]);
    expectClean(run);
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
    expect([...form.keys()].sort()).toEqual(["client_id", "code", "code_verifier", "grant_type", "redirect_uri"]);
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe(CODE);
    expect(form.get("redirect_uri")).toBe(run.redirectUri);

    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expect(run.out.join("")).toContain("Granted scopes: user-read-recently-played\n");
    expect(run.all().split(REFRESH_TOKEN)).toHaveLength(2);
    expect(run.all()).not.toContain(ACCESS_TOKEN);
    expectClean(run);
    expect(await isClosed(run.port)).toBe(true);
  });

  it("says plainly when a requested scope was not granted", async () => {
    answer = () => json({ ...GOOD_TOKEN, scope: "user-read-private" });
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    const err = run.err.join("");
    expect(err).toContain(loginMessages.notGranted(["user-read-recently-played"]));
    expectClean(run);
  });

  it("prints a reminder on stderr, after the token line, to store the token and clear the scrollback", async () => {
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(0);
    expect(run.err.join("")).toContain(`${loginMessages.clearReminder}\n`);
    expect(loginMessages.clearReminder).toContain("GitHub environment secret");
    expect(loginMessages.clearReminder).toContain("clear && printf '\\e[3J'");
    expect(loginMessages.clearReminder).toMatch(/tmux/);
    expect(run.out.join("")).not.toContain("GitHub environment secret");
  });

  it("prints no reminder when there is no token to clear", async () => {
    answer = () => json({ error: "invalid_grant" }, 400);
    const run = await startLogin(fake.url);
    await hit(run.port, run.callback({ code: CODE, state: run.state }));
    expect(await run.done).toBe(1);
    expect(run.all()).not.toContain("scrollback");
  });
});

describe("a callback that is not from this run", () => {
  it.each([
    ["a wrong state", (run: Started) => run.callback({ code: CODE, state: `${run.state}x` })],
    ["a state of another length", (run: Started) => run.callback({ code: CODE, state: "a" })],
    ["a missing state", (run: Started) => run.callback({ code: CODE })],
    ["an empty state", (run: Started) => run.callback({ code: CODE, state: "" })],
    ["a wrong state on an error", (run: Started) => run.callback({ error: "access_denied", state: "wrong" })],
    ["a doubled state", (run: Started) => `/callback?code=${CODE}&state=${run.state}&state=${run.state}`],
    ["a doubled code", (run: Started) => `/callback?code=${CODE}&code=${CODE}&state=${run.state}`],
    ["a doubled error", (run: Started) => `/callback?error=access_denied&error=access_denied&state=${run.state}`],
  ])("answers 400 on %s, keeps listening, and the right state still finishes the run", async (_name, query) => {
    const run = await startLogin(fake.url);
    for (let round = 0; round < 3; round += 1) {
      const reply = await hit(run.port, query(run));
      expect(reply.status).toBe(400);
      expect(reply.body).toBe(loginMessages.ignoredReply);
      expect(reply.body).not.toContain(CODE);
    }
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await isClosed(run.port)).toBe(false);

    expect((await hit(run.port, run.callback({ code: CODE, state: run.state }))).status).toBe(200);
    expect(await run.done).toBe(0);
    expect(fake.tokenRequests).toHaveLength(1);
    expect(tokenLines(run)).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expectClean(run);
    expect(await isClosed(run.port)).toBe(true);
  });

  it("is not ended by stray requests: only the 5 minute timer ends the run, and then it closes", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 700 });
    expect((await hit(run.port, run.callback({ code: CODE, state: "wrong" }))).status).toBe(400);
    expect((await hit(run.port, run.callback({ code: CODE }))).status).toBe(400);
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.timeout}\n`);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(tokenLines(run)).toEqual([]);
    expect(await isClosed(run.port)).toBe(true);
    expectClean(run);
  });
});

describe("the Host header", () => {
  it.each([
    ["localhost with the port", (port: number) => `localhost:${port}`],
    ["the address with no port", () => "127.0.0.1"],
    ["the address with another port", (port: number) => `127.0.0.1:${port + 1}`],
    ["a name that is not this computer", () => "evil.example"],
    ["a name that starts like it", (port: number) => `127.0.0.1:${port}.evil.example`],
  ])("answers 400 for %s, and the run is not used up", async (_name, host) => {
    const run = await startLogin(fake.url);
    // A real browser sends the Host it was given, so a page that rebinds a name to 127.0.0.1 sends that name.
    const reply = await hit(run.port, run.callback({ code: CODE, state: run.state }), "GET", { host: host(run.port) });
    expect(reply.status).toBe(400);
    expect(reply.body).toBe(loginMessages.ignoredReply);
    expect(fake.tokenRequests).toHaveLength(0);
    expect(await isClosed(run.port)).toBe(false);

    expect((await hit(run.port, run.callback({ code: CODE, state: run.state }))).status).toBe(200);
    expect(await run.done).toBe(0);
    expectClean(run);
  });

  it.each([
    ["no Host header at all", [] as string[]],
    ["an empty Host header", ["Host:"]],
  ])("answers 400 for %s", async (_name, lines) => {
    const run = await startLogin(fake.url);
    expect(await hitRaw(run.port, run.callback({ code: CODE, state: run.state }), lines)).toBe(400);
    expect(fake.tokenRequests).toHaveLength(0);
    expect((await hit(run.port, run.callback({ code: CODE, state: run.state }))).status).toBe(200);
    expect(await run.done).toBe(0);
  });

  it("accepts exactly 127.0.0.1 and the port", async () => {
    const run = await startLogin(fake.url);
    const reply = await hit(run.port, run.callback({ code: CODE, state: run.state }), "GET", { host: `127.0.0.1:${run.port}` });
    expect(reply.status).toBe(200);
    expect(await run.done).toBe(0);
  });

  it("checks the Host before the path, so a rebinding page learns nothing from a 404", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 400 });
    const reply = await hit(run.port, "/favicon.ico", "GET", { host: "evil.example" });
    expect(reply.status).toBe(400);
    await run.done;
  });
});

describe("a callback that is from this run but cannot finish it", () => {
  it.each([
    ["a missing code", (run: Started) => run.callback({ state: run.state })],
    ["an empty code", (run: Started) => run.callback({ code: "", state: run.state })],
  ])("stops on %s: no exchange, exit 1, listener closed", async (_name, query) => {
    const run = await startLogin(fake.url);
    const reply = await hit(run.port, query(run));
    expect(reply.status).toBe(400);
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.noCode}\n`);
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
    await hit(run.port, run.callback({ state: run.state }));
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

  it("checks the state before it reads an error: a wrong state with an error does not end the run", async () => {
    const run = await startLogin(fake.url, { timeoutMs: 500 });
    const reply = await hit(run.port, run.callback({ error: "access_denied", state: "wrong" }));
    expect(reply.status).toBe(400);
    expect(await run.done).toBe(1);
    expect(run.err.join("")).toBe(`${loginMessages.timeout}\n`);
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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LOGIN_SCOPES } from "../src/settings.ts";
import { runSpotifyLogin } from "./support/cli.ts";
import { adminClient, localStack } from "./support/env.ts";
import { deadAddress, json, startFakeSpotify, type FakeSpotify } from "./support/fake-spotify.ts";
import {
  ACCESS_TOKEN,
  CLIENT_ID,
  CLIENT_SECRET,
  CODE,
  REFRESH_TOKEN,
  expectNoSecrets,
  freePort,
  hit,
  isClosed,
  startInPty,
} from "./support/login-harness.ts";

// The real command in a child process. Synthetic data only.
// `runSpotifyLogin` puts both streams on pipes: not a terminal. `startInPty` gives the command a real pseudo terminal.

let fake: FakeSpotify;

beforeEach(async () => {
  fake = await startFakeSpotify({
    token: () =>
      json({ access_token: ACCESS_TOKEN, token_type: "Bearer", scope: LOGIN_SCOPES.join(" "), expires_in: 3600, refresh_token: REFRESH_TOKEN }),
    recent: () => json({}, 500),
  });
});

afterEach(async () => {
  await fake.close();
});

const base = (extra: Record<string, string | undefined> = {}) => ({
  SPOTIFY_CLIENT_ID: CLIENT_ID,
  SPOTIFY_CLIENT_SECRET: CLIENT_SECRET,
  SPOTIFY_ACCOUNTS_BASE: fake.url,
  ...extra,
});

const today = () => new Date().toISOString().slice(0, 10);

describe("spotify-login: settings", () => {
  it.each(["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"])("exits 2 and names %s when it is missing", (name) => {
    const result = runSpotifyLogin([], base({ [name]: undefined }));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`${name} is not set.\n`);
  });

  it("treats an empty variable as missing", () => {
    const result = runSpotifyLogin([], base({ SPOTIFY_CLIENT_SECRET: "" }));
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SPOTIFY_CLIENT_SECRET is not set.\n");
  });

  it.each([["--client-secret=SYNTH_ARG_SECRET"], ["SYNTH_ARG_SECRET"], ["--client-id", "SYNTH_ARG_ID"]])(
    "takes no arguments, and never prints one back: %j",
    (...args) => {
      const result = runSpotifyLogin(args, base());
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.output).toContain("spotify-login");
      expect(result.output).not.toContain("SYNTH_ARG");
    },
  );

  it("exits 2 for an accounts address that is not Spotify's, before it sends anything", () => {
    const result = runSpotifyLogin([], base({ SPOTIFY_ACCOUNTS_BASE: "https://accounts.spotify.com.evil.example" }));
    expect(result.status).toBe(2);
    expect(result.stderr).toBe("SPOTIFY_ACCOUNTS_BASE must be https://accounts.spotify.com, or localhost or 127.0.0.1 for tests.\n");
    expect(result.output).not.toContain("evil.example");
    expect(fake.tokenRequests).toHaveLength(0);
  });

  it("exits 2 for plain http to a host that is not this computer", () => {
    const result = runSpotifyLogin([], base({ SPOTIFY_ACCOUNTS_BASE: "http://accounts.spotify.com" }));
    expect(result.status).toBe(2);
  });

  it.each(["80", "abc", "70000"])("exits 2 for SPOTIFY_LOGIN_PORT=%s", (port) => {
    const result = runSpotifyLogin([], base({ SPOTIFY_LOGIN_PORT: port }));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("SPOTIFY_LOGIN_PORT");
  });
});

describe("spotify-login: output that is not a terminal", () => {
  it("refuses with exit 2, prints no token and no URL, and never listens", async () => {
    const port = await freePort();
    const result = runSpotifyLogin([], base({ SPOTIFY_LOGIN_PORT: String(port) }));
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("terminal");
    expect(result.output).not.toContain("SPOTIFY_REFRESH_TOKEN=");
    expect(await isClosed(port)).toBe(true);
    expect(expectNoSecrets(result.output)).toEqual([]);
  });
});

describe("spotify-login: in a pseudo terminal", () => {
  it("runs the whole login, prints the token line once, and records the date", async () => {
    const db = adminClient();
    await db.from("poller_state").delete().neq("key", "");
    const port = await freePort();
    const run = startInPty(base({ SPOTIFY_LOGIN_PORT: String(port) }));

    const urlLine = await run.line(/\/authorize\?/);
    const url = new URL(urlLine.trim());
    expect(url.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/callback`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    const state = url.searchParams.get("state") ?? "";
    expect(state).not.toBe("");

    const reply = await hit(port, `/callback?code=${CODE}&state=${encodeURIComponent(state)}`);
    expect(reply.status).toBe(200);
    expect(await run.done).toBe(0);

    const lines = run.output().split(/\r?\n/);
    expect(lines.filter((line) => line.startsWith("SPOTIFY_REFRESH_TOKEN="))).toEqual([`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`]);
    expect(run.output()).toContain(`Granted scopes: ${LOGIN_SCOPES.join(" ")}`);
    expect(run.output()).toContain("Recorded spotify_authorized_at.");
    expect(expectNoSecrets(run.output())).toEqual([]);
    expect(run.output()).not.toContain(localStack().key);
    expect(await isClosed(port)).toBe(true);

    const { data } = await db.from("poller_state").select("key,value");
    expect(data).toEqual([{ key: "spotify_authorized_at", value: today() }]);
  });

  it("notes plainly, and still exits 0, when the database cannot be reached", async () => {
    const port = await freePort();
    const run = startInPty(base({ SPOTIFY_LOGIN_PORT: String(port), SUPABASE_URL: await deadAddress() }));
    const state = new URL((await run.line(/\/authorize\?/)).trim()).searchParams.get("state") ?? "";
    await hit(port, `/callback?code=${CODE}&state=${encodeURIComponent(state)}`);
    expect(await run.done).toBe(0);
    expect(run.output()).toContain(`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`);
    expect(run.output()).toContain(`npm run set-state -- spotify_authorized_at ${today()}`);
    expect(expectNoSecrets(run.output())).toEqual([]);
  });

  it("notes the set-state command when the database variables are not set", async () => {
    const port = await freePort();
    const run = startInPty(base({ SPOTIFY_LOGIN_PORT: String(port), SUPABASE_URL: undefined, SUPABASE_SECRET_KEY: undefined }));
    const state = new URL((await run.line(/\/authorize\?/)).trim()).searchParams.get("state") ?? "";
    await hit(port, `/callback?code=${CODE}&state=${encodeURIComponent(state)}`);
    expect(await run.done).toBe(0);
    expect(run.output()).toContain(`SPOTIFY_REFRESH_TOKEN=${REFRESH_TOKEN}`);
    expect(run.output()).toContain(`npm run set-state -- spotify_authorized_at ${today()}`);
  });

  it("exits 1 on access_denied and prints no token", async () => {
    const port = await freePort();
    const run = startInPty(base({ SPOTIFY_LOGIN_PORT: String(port) }));
    const state = new URL((await run.line(/\/authorize\?/)).trim()).searchParams.get("state") ?? "";
    await hit(port, `/callback?error=access_denied&state=${encodeURIComponent(state)}`);
    expect(await run.done).toBe(1);
    expect(run.output()).not.toContain("SPOTIFY_REFRESH_TOKEN=");
    expect(fake.tokenRequests).toHaveLength(0);
  });
});

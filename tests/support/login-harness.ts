import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { prepare } from "./cli.ts";
import { runLogin, type LoginOptions } from "../../src/spotify-login.ts";
import { LOGIN_SCOPES, SPOTIFY_REDIRECT_URI } from "../../src/settings.ts";

// Synthetic values only. None is a real credential.
export const CLIENT_ID = "SYNTH_CLIENT_ID_0123";
export const CLIENT_SECRET = "SYNTH_CLIENT_SECRET_4567";
export const CODE = "SYNTH_AUTH_CODE_89ab";
export const REFRESH_TOKEN = "SYNTH_REFRESH_TOKEN_cdef";
export const ACCESS_TOKEN = "SYNTH_ACCESS_TOKEN_0246";
/** Put in every fake answer body. It must never reach any output. */
export const BODY_MARKER = "SYNTH_BODY_MARKER_1357";

/** A port nothing listens on right now. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Holds a port busy, as another program would. */
export async function occupy(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
}

export type Reply = { status: number; body: string; headers: Record<string, string | string[] | undefined> };

/**
 * A real HTTP request to the helper's listener. A new connection every time, so a closed listener shows as a
 * refused connection. It rejects with the network error code (ECONNREFUSED) when nothing answers.
 */
export function hit(port: number, path: string, method = "GET", headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method, agent: false, headers: { connection: "close", ...headers } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8"), headers: response.headers }),
        );
      },
    );
    req.on("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code ?? "network")));
    req.end();
  });
}

/**
 * A request written by hand on a raw socket, so it can leave out the Host header (HTTP/1.0 allows that) or send
 * it empty. `headerLines` are written as given. Resolves with the status code of the answer.
 */
export function hitRaw(port: number, path: string, headerLines: string[] = []): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`GET ${path} HTTP/1.0\r\n${headerLines.map((line) => `${line}\r\n`).join("")}\r\n`));
    socket.on("data", (chunk: string) => (text += chunk));
    socket.on("end", () => resolve(Number(/^HTTP\/1\.\d (\d{3})/.exec(text)?.[1] ?? 0)));
    socket.on("error", (error: NodeJS.ErrnoException) => reject(new Error(error.code ?? "network")));
  });
}

/** The S256 code challenge for a verifier, worked out here on its own: base64url of the SHA-256 hash, no padding. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** True when nothing accepts a connection on the port. */
export async function isClosed(port: number): Promise<boolean> {
  try {
    await hit(port, "/callback");
    return false;
  } catch (error) {
    return (error as Error).message === "ECONNREFUSED";
  }
}

export type Started = {
  port: number;
  redirectUri: string;
  /** The authorization URL the command printed. */
  authorizeUrl: URL;
  state: string;
  out: string[];
  err: string[];
  /** Resolves with the exit code. */
  done: Promise<number>;
  /** Everything the command printed, both streams. */
  all: () => string;
  /** The path and query a browser would be sent to, with the state the command made. */
  callback: (params: Record<string, string | undefined>, path?: string) => string;
};

/** What the command printed must never hold these. */
export function expectNoSecrets(text: string): string[] {
  return [CLIENT_SECRET, CODE, ACCESS_TOKEN, BODY_MARKER].filter((value) => text.includes(value));
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Starts the real login in this process, on a free port, against `accountsBase`, and waits until it has
 * printed the authorization URL. TTY is injected through `isTty` (the pseudo terminal test is in spotify-login-cli).
 */
export async function startLogin(
  accountsBase: string,
  overrides: Partial<LoginOptions> = {},
): Promise<Started> {
  const port = await freePort();
  const redirectUri = new URL(SPOTIFY_REDIRECT_URI);
  redirectUri.port = String(port);
  const out: string[] = [];
  const err: string[] = [];
  const done = runLogin({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    accountsBase,
    redirectUri: redirectUri.href,
    scopes: LOGIN_SCOPES,
    isTty: true,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    timeoutMs: 20_000,
    recordAuthorized: null,
    ...overrides,
  });
  const urlLine = () => out.join("").split("\n").find((line) => line.startsWith(`${accountsBase}/authorize?`));
  await Promise.race([
    waitFor(() => urlLine() !== undefined, "the authorization URL"),
    // A command that stops before it prints the URL is a test result too: do not wait for it.
    done.then(() => undefined),
  ]);
  const line = urlLine();
  const authorizeUrl = new URL(line ?? "http://missing.invalid/");
  const state = authorizeUrl.searchParams.get("state") ?? "";
  return {
    port,
    redirectUri: redirectUri.href,
    authorizeUrl,
    state,
    out,
    err,
    done,
    all: () => `${out.join("")}\n${err.join("")}`,
    callback: (params, path = "/callback") => {
      const query = new URLSearchParams();
      for (const [name, value] of Object.entries(params)) if (value !== undefined) query.set(name, value);
      return `${path}?${query.toString()}`;
    },
  };
}

export type InPty = {
  /** Everything the command printed so far. A terminal merges both streams, and ends lines with CR LF. */
  output: () => string;
  /** Waits until a line of the output matches, and returns it. */
  line: (pattern: RegExp) => Promise<string>;
  done: Promise<number | null>;
};

/**
 * Runs `spotify-login` as a person would, with a pseudo terminal on its stdout, so it sees a real TTY.
 * Python's pty module makes the terminal (tests/support/pty-run.py). Needs python3 on the PATH.
 */
export function startInPty(env: Record<string, string | undefined>): InPty {
  const prepared = prepare("spotify-login", [], env);
  const script = join(process.cwd(), "tests", "support", "pty-run.py");
  const child = spawn("python3", ["-I", script, prepared.command, ...prepared.args], {
    cwd: process.cwd(),
    env: prepared.env,
    // stdin stays open and unused, so the terminal never reports end of input.
    stdio: ["pipe", "pipe", "pipe"],
  });
  let text = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
  const done = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve(status));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  void done.finally(() => clearTimeout(timer));
  const lines = () => text.split(/\r?\n/);
  return {
    output: () => text,
    line: async (pattern) => {
      const until = Date.now() + 30_000;
      for (;;) {
        const found = lines().find((line) => pattern.test(line));
        if (found !== undefined) return found;
        if (Date.now() > until) throw new Error("Timed out waiting for a line of output.");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    done,
  };
}

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { UserError } from "./files.ts";
import {
  LOGIN_PORT_MIN,
  LOGIN_STATE_BYTES,
  LOGIN_VERIFIER_BYTES,
  SPOTIFY_REDIRECT_URI,
} from "./settings.ts";
import { isRecord, send } from "./spotify.ts";

/**
 * The login helper: it gets a Spotify refresh token once, on the app owner's own computer.
 *
 * Followed from Spotify's pages (read 2026-11-23):
 * - Authorization Code Flow: the browser goes to {accounts}/authorize with response_type=code, client_id,
 *   redirect_uri, scope (space separated) and state. Spotify sends the browser back to redirect_uri with `code`
 *   and `state`, or with `error` and `state` when the person refuses. The app compares `state` with the one it
 *   sent and, on a mismatch, rejects the request and stops. The code is then exchanged by POST {accounts}/api/token
 *   with a form body (grant_type=authorization_code, code, redirect_uri) and the header
 *   "Authorization: Basic <base64 client_id:client_secret>". The answer holds access_token, token_type, scope,
 *   expires_in and refresh_token.
 * - Redirect URIs: the address in the request must exactly match one registered in the app. A loopback address
 *   is allowed over plain http, but only as the IP literal (http://127.0.0.1:PORT), never `localhost`.
 * - Authorization Code with PKCE Flow: the app makes a code verifier (43 to 128 characters of letters, digits, `_`,
 *   `.`, `-` and `~`), hashes it with SHA-256 and writes the hash in base64url with no padding: the code challenge.
 *   The authorize request adds code_challenge and code_challenge_method=S256. The token request adds client_id and
 *   code_verifier. That page's token request has no client secret. This tool sends its Basic header as well, so
 *   PKCE is a second check on top of the secret, not a replacement for it.
 * - Scopes: the names this tool requests are in LOGIN_SCOPES, each on the Scopes page.
 * - Refreshing tokens: a refresh token lasts 6 months from authorization, and refreshing does not extend it.
 *
 * Every message here is fixed text. None quotes the client secret, the code, a token, a response body or a
 * value from the callback, because any of those could be a secret, or text meant to confuse a terminal.
 */
export const loginMessages = {
  badPort: `SPOTIFY_LOGIN_PORT must be a whole number from ${LOGIN_PORT_MIN} to 65535.`,
  notTerminal:
    "The refresh token is printed only to an interactive terminal, so it never lands in a log. Run this command in a terminal, not in a pipe, a file or a CI job. Nothing was started.",
  busy: (port: number) =>
    `Port ${port} is busy. Stop the program that uses it, or set SPOTIFY_LOGIN_PORT to a free port. The redirect address registered in the Spotify app must then name the same port.`,
  listen: "Could not listen on 127.0.0.1. Check SPOTIFY_LOGIN_PORT, then run the command again.",
  timeout: "Spotify did not send the browser back within 5 minutes. Run the command again.",
  denied: "Spotify did not get your approval. Run the command again, open the address, and choose to agree.",
  refused: "Spotify reported an authorization error. Run the command again.",
  noCode: "The callback carried no authorization code. Run the command again.",
  grant:
    "Spotify refused the code. It may be used or expired, or the redirect address may differ from the one registered in the Spotify app. Run the command again.",
  client: "Spotify refused the app credentials. Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
  limited: "Spotify is limiting requests (HTTP 429). Wait, then run the command again.",
  status: (status: number) => `Spotify answered the code exchange with an unexpected status (HTTP ${status}).`,
  network: "Could not reach Spotify. Check the network, then run the command again.",
  tooLarge: "Spotify sent a response larger than 1 MB, so the command did not read it.",
  notJson: "Spotify sent a response that is not valid JSON.",
  shape: "Spotify sent a response in a shape this command does not know.",
  noRefreshToken:
    "Spotify's answer had no refresh token. Run the command again. If it repeats, remove this app's access in your Spotify account, then run it again.",
  badToken: "Spotify sent a refresh token in a form this command will not print.",
  notRecorded: (date: string) =>
    `The login date was not recorded. Run: npm run set-state -- spotify_authorized_at ${date}`,
  notConfigured: (date: string) =>
    `The login date was not recorded, because SUPABASE_URL and SUPABASE_SECRET_KEY are not both set. To record it, run: npm run set-state -- spotify_authorized_at ${date}`,
  notGranted: (names: string[]) => `Spotify did not grant these requested scopes: ${names.join(", ")}.`,
  /** The body of a 400 for a request that is not from this run. The listener keeps waiting. */
  ignoredReply: "This request was refused. The login is still waiting for Spotify.\n",
  clearReminder:
    "Copy the token into the GitHub environment secret SPOTIFY_REFRESH_TOKEN now. Then clear this terminal and its scrollback, because terminals, tmux and screen recorders can keep it: clear && printf '\\e[3J'",
} as const;

/** The redirect address, with the port from SPOTIFY_LOGIN_PORT when that is set. Throws a UserError for a bad port. */
export function loginRedirectUri(portSetting: string | undefined): string {
  if (portSetting === undefined || portSetting === "") return SPOTIFY_REDIRECT_URI;
  const port = Number(portSetting);
  if (!/^[1-9]\d{3,4}$/.test(portSetting) || port < LOGIN_PORT_MIN || port > 65535) {
    throw new UserError(loginMessages.badPort);
  }
  const uri = new URL(SPOTIFY_REDIRECT_URI);
  uri.port = String(port);
  return uri.href;
}

export type LoginOptions = {
  clientId: string;
  clientSecret: string;
  /** No trailing slash. */
  accountsBase: string;
  redirectUri: string;
  scopes: readonly string[];
  /** True when stdout is an interactive terminal. The refresh token is printed only then. */
  isTty: boolean;
  out: (text: string) => void;
  err: (text: string) => void;
  /** How long to wait for the browser to come back. */
  timeoutMs: number;
  /** Records the date the login was authorized (YYYY-MM-DD, UTC), or null when no database is set. */
  recordAuthorized: ((date: string) => Promise<void>) | null;
  now?: () => Date;
};

type Outcome =
  | { kind: "code"; code: string }
  | { kind: "denied" | "refused" | "nocode" | "timeout" | "listen" }
  | { kind: "busy"; port: number };

const CODE_MAX_CHARS = 4096;

/** True when the two texts are equal. The comparison takes the same time however many leading characters match. */
function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Decides what a request to the callback path means. `ignore` is a request that cannot be from Spotify's redirect
 * for this run: a wrong, missing or repeated state, or a repeated code or error. It does not end the run.
 * The state is checked first, as Spotify's page says.
 */
function judge(query: string, state: string): Outcome | { kind: "ignore" } {
  const params = new URLSearchParams(query);
  for (const name of ["state", "code", "error"]) {
    if (params.getAll(name).length > 1) return { kind: "ignore" };
  }
  const sent = params.get("state");
  if (sent === null || !sameText(sent, state)) return { kind: "ignore" };
  if (params.has("error")) return { kind: params.get("error") === "access_denied" ? "denied" : "refused" };
  const code = params.get("code");
  if (code === null || code === "" || code.length > CODE_MAX_CHARS) return { kind: "nocode" };
  return { kind: "code", code };
}

const HEADERS = {
  "content-type": "text/plain; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  connection: "close",
} as const;

/**
 * Listens on 127.0.0.1 only. A request counts only when its Host header is exactly `127.0.0.1:<port>`: any other
 * Host gets 400, so a web page that points a name at this computer cannot use the listener. Any other path gets
 * 404, and a callback that is not a GET gets 405. A GET to the callback path with this run's state ends the run
 * and closes the listener at once. A GET with a wrong, missing or repeated state gets 400 and the listener keeps
 * waiting until the timer ends, so a stray request from another page cannot end the run. None of these uses up
 * the run.
 * `onListening` runs once the port is held, so the address is never shown before it can be answered.
 */
function waitForCallback(spec: {
  host: string;
  port: number;
  path: string;
  state: string;
  timeoutMs: number;
  onListening: () => void;
}): Promise<Outcome> {
  return new Promise((resolve) => {
    let consumed = false;
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const server = createServer((request, response) => {
      // Split by hand. `new URL("//x", base)` reads a double slash as a host, and the path must be compared as sent.
      const target = request.url ?? "";
      const cut = target.indexOf("?");
      const path = cut === -1 ? target : target.slice(0, cut);
      const query = cut === -1 ? "" : target.slice(cut + 1);
      const reply = (status: number, text: string, headers: Record<string, string> = {}, done?: () => void) => {
        response.writeHead(status, { ...HEADERS, ...headers });
        response.end(text, done);
      };

      // Host first, even before the path: a page that rebinds a name to 127.0.0.1 learns nothing from a 404.
      if (request.headers.host !== `${spec.host}:${spec.port}`) return reply(400, loginMessages.ignoredReply);
      if (consumed || path !== spec.path) return reply(404, "Not found.\n");
      if (request.method !== "GET") return reply(405, "Use GET.\n", { allow: "GET" });

      const outcome = judge(query, spec.state);
      if (outcome.kind === "ignore") return reply(400, loginMessages.ignoredReply);

      consumed = true;
      clearTimeout(timer);
      // Stop accepting at once, so a second request is refused while the exchange is still running.
      server.close();
      const text =
        outcome.kind === "code"
          ? "Spotify sent you back. Return to the terminal: the login finishes there. You can close this tab.\n"
          : "The login did not finish. Return to the terminal for what to do next.\n";
      reply(outcome.kind === "code" ? 200 : 400, text, {}, () => finish(outcome));
    });

    const finish = (outcome: Outcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (server.listening) server.close();
      server.closeAllConnections();
      resolve(outcome);
    };

    server.on("error", (error: NodeJS.ErrnoException) => {
      finish(error.code === "EADDRINUSE" ? { kind: "busy", port: spec.port } : { kind: "listen" });
    });
    server.listen({ host: spec.host, port: spec.port, exclusive: true }, () => {
      timer = setTimeout(() => finish({ kind: "timeout" }), spec.timeoutMs);
      spec.onListening();
    });
  });
}

const PRINTABLE_TOKEN = /^[\x21-\x7e]{1,4096}$/;
const PRINTABLE_SCOPES = /^[\x21-\x7e]+( [\x21-\x7e]+)*$/;

/** Trades the code for the tokens. Returns the refresh token and the granted scope string. Throws a UserError. */
async function exchangeCode(options: LoginOptions, code: string, verifier: string): Promise<{ refreshToken: string; scope: string }> {
  const login = Buffer.from(`${options.clientId}:${options.clientSecret}`).toString("base64");
  let answer;
  try {
    answer = await send(`${options.accountsBase}/api/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${login}` },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        code_verifier: verifier,
      }),
    });
  } catch (error) {
    // `send` words its failures for the poller. Say them again for this command, by kind.
    if (error instanceof UserError && error.kind === "bad_response") throw new UserError(loginMessages.tooLarge);
    throw new UserError(loginMessages.network);
  }

  if (answer.status === 429) throw new UserError(loginMessages.limited);
  if (answer.status < 200 || answer.status > 299) {
    // Only the error code is read, and only to choose a message. It is never printed.
    let code: unknown;
    try {
      const body: unknown = JSON.parse(answer.text);
      code = isRecord(body) ? body.error : undefined;
    } catch {
      code = undefined;
    }
    if (code === "invalid_grant") throw new UserError(loginMessages.grant);
    if (code === "invalid_client" || answer.status === 401 || answer.status === 403) throw new UserError(loginMessages.client);
    throw new UserError(loginMessages.status(answer.status));
  }

  let body: unknown;
  try {
    body = JSON.parse(answer.text);
  } catch {
    throw new UserError(loginMessages.notJson);
  }
  if (!isRecord(body)) throw new UserError(loginMessages.shape);
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== "string" || refreshToken === "") throw new UserError(loginMessages.noRefreshToken);
  if (!PRINTABLE_TOKEN.test(refreshToken)) throw new UserError(loginMessages.badToken);
  // The access token is in the answer too. It is never read, printed or stored: it lasts an hour.
  return { refreshToken, scope: typeof body.scope === "string" ? body.scope : "" };
}

/** The outcome of a callback that did not carry a code, as the message to show. */
const STOPS: Record<Exclude<Outcome["kind"], "code" | "busy">, string> = {
  denied: loginMessages.denied,
  refused: loginMessages.refused,
  nocode: loginMessages.noCode,
  timeout: loginMessages.timeout,
  listen: loginMessages.listen,
};

/** Runs the whole login. Returns the exit code: 0 done, 1 stopped, 2 a setting or the terminal is wrong. */
export async function runLogin(options: LoginOptions): Promise<number> {
  const { out, err } = options;
  // Checked first, before anything is started, so a login is never spent on a token that cannot be shown.
  if (!options.isTty) {
    err(`${loginMessages.notTerminal}\n`);
    return 2;
  }

  const redirect = new URL(options.redirectUri);
  const state = randomBytes(LOGIN_STATE_BYTES).toString("base64url");
  // The verifier stays in this function: it is sent once, in the token request, and never printed or logged.
  // 96 random bytes in base64url is 128 characters from A-Z, a-z, 0-9, `-` and `_`, all allowed by Spotify's page.
  const verifier = randomBytes(LOGIN_VERIFIER_BYTES).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  const authorize = new URL(`${options.accountsBase}/authorize`);
  // A space is written %20, as Spotify's own example does, not +.
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    scope: options.scopes.join(" "),
    redirect_uri: options.redirectUri,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  })
    .toString()
    .replace(/\+/g, "%20");

  const outcome = await waitForCallback({
    host: redirect.hostname,
    port: Number(redirect.port),
    path: redirect.pathname,
    state,
    timeoutMs: options.timeoutMs,
    onListening: () => {
      out("Open this address in your browser, sign in to Spotify, and approve:\n");
      out(`${authorize.href}\n`);
      out("Waiting for Spotify to send the browser back, for up to 5 minutes.\n");
    },
  });
  if (outcome.kind === "busy") {
    err(`${loginMessages.busy(outcome.port)}\n`);
    return 1;
  }
  if (outcome.kind !== "code") {
    err(`${STOPS[outcome.kind]}\n`);
    return 1;
  }

  let granted: { refreshToken: string; scope: string };
  try {
    granted = await exchangeCode(options, outcome.code, verifier);
  } catch (error) {
    err(`${error instanceof UserError ? error.message : loginMessages.network}\n`);
    return 1;
  }

  const scope = PRINTABLE_SCOPES.test(granted.scope) ? granted.scope : "";
  out(`Granted scopes: ${scope === "" ? "(not shown)" : scope}\n`);
  const missing = options.scopes.filter((name) => !scope.split(" ").includes(name));
  if (missing.length > 0) err(`${loginMessages.notGranted(missing)}\n`);
  // On its own line, once. Store it as the SPOTIFY_REFRESH_TOKEN secret. Never paste it anywhere else.
  out(`SPOTIFY_REFRESH_TOKEN=${granted.refreshToken}\n`);
  // Terminals, tmux and recorders can keep what was printed. Say so while the token is on screen.
  err(`${loginMessages.clearReminder}\n`);

  const date = (options.now?.() ?? new Date()).toISOString().slice(0, 10);
  if (options.recordAuthorized === null) {
    err(`${loginMessages.notConfigured(date)}\n`);
  } else {
    try {
      await options.recordAuthorized(date);
      out("Recorded spotify_authorized_at.\n");
    } catch {
      // The failure text could quote the address or a row. A fixed note tells the person what to do instead.
      err(`${loginMessages.notRecorded(date)}\n`);
    }
  }
  return 0;
}

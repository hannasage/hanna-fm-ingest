import { UserError } from "./files.ts";
import { MAX_RESPONSE_BYTES, POLL_LIMIT, SPOTIFY_TIMEOUT_MS } from "./settings.ts";

/**
 * The two Spotify calls the poller makes, and what each failure says.
 *
 * Every message here is fixed text. None quotes a token, a key, an address or any part of
 * a response body, because any of those could hold a secret or a play.
 *
 * Followed from Spotify's pages:
 * - Refreshing tokens: POST {accounts}/api/token, form body grant_type=refresh_token and
 *   refresh_token, header "Authorization: Basic <base64 client_id:client_secret>" (the
 *   Authorization Code flow). The answer may carry a new refresh_token; when it does not,
 *   the old one stays in use. `invalid_grant` means the refresh token is expired, revoked
 *   or invalid, so the login must be renewed and the request is never retried.
 * - Get Recently Played Tracks: GET {api}/me/player/recently-played, scope
 *   user-read-recently-played. `limit` 1 to 50. `after` is a Unix time in milliseconds and
 *   returns items after, not including, that point. Answers: 200, 401, 403, 429.
 */
export const MESSAGES = {
  renew:
    "The Spotify login must be renewed: the refresh token is expired, revoked or invalid. Create a new one and update SPOTIFY_REFRESH_TOKEN.",
  client: "Spotify refused the app credentials. Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.",
  refused: (status: number) =>
    `Spotify refused the request (HTTP ${status}). The Spotify login must be renewed, and it needs the user-read-recently-played scope.`,
  limited: (retryAfter: string | null) =>
    `Spotify is limiting requests (HTTP 429). Wait, then run the poll again.${retryAfter === null ? "" : ` Retry after ${retryAfter} seconds.`}`,
  notJson: "Spotify sent a response that is not valid JSON.",
  shape: "Spotify sent a response in a shape the poller does not know.",
  network: "Could not reach Spotify. Check the network, then run the poll again.",
  status: (status: number) => `Spotify answered with an unexpected status (HTTP ${status}).`,
  rotated: "::warning::Spotify issued a new refresh token. Re-authorize and store the new token.",
  tooLarge: "Spotify sent a response larger than 1 MB, so the poller did not read it.",
  tooMany: `Spotify sent more than ${POLL_LIMIT} items in one page, which is more than the poller accepts.`,
} as const;

export type SpotifyConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** No trailing slash. */
  accountsBase: string;
  apiBase: string;
};

type Answer = { status: number; headers: Headers; text: string };

/** Reads the body as text, and stops with tooLarge once it passes MAX_RESPONSE_BYTES. */
async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new UserError(MESSAGES.tooLarge);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new UserError(MESSAGES.tooLarge);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/** Sends one request. Any network failure, timeout or redirect becomes the one network message. */
async function send(url: string, init: RequestInit): Promise<Answer> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      // A redirect would carry the login to another host. Spotify's calls do not redirect.
      redirect: "error",
      signal: AbortSignal.timeout(SPOTIFY_TIMEOUT_MS),
    });
  } catch {
    throw new UserError(MESSAGES.network);
  }
  try {
    return { status: response.status, headers: response.headers, text: await readCapped(response) };
  } catch (error) {
    if (error instanceof UserError) throw error;
    throw new UserError(MESSAGES.network);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new UserError(MESSAGES.notJson);
  }
}

/** The retry hint is shown only when it is plain digits, so a header cannot smuggle text in. */
function retryHint(headers: Headers): string | null {
  const value = headers.get("retry-after");
  return value !== null && /^\d{1,7}$/.test(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type Token = {
  accessToken: string;
  /** Set only when Spotify sent a refresh token that differs from the one in use. */
  rotatedRefreshToken: string | null;
};

/** Exchanges the refresh token for an access token. */
export async function refreshAccessToken(config: SpotifyConfig): Promise<Token> {
  const login = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const answer = await send(`${config.accountsBase}/api/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${login}`,
    },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: config.refreshToken }),
  });

  if (answer.status === 429) throw new UserError(MESSAGES.limited(retryHint(answer.headers)));
  if (answer.status < 200 || answer.status > 299) {
    // Only the error code is read, and only to choose a message. It is never printed.
    let code: unknown;
    try {
      const body: unknown = JSON.parse(answer.text);
      code = isRecord(body) ? body.error : undefined;
    } catch {
      code = undefined;
    }
    if (code === "invalid_grant") throw new UserError(MESSAGES.renew);
    if (code === "invalid_client" || answer.status === 401 || answer.status === 403) {
      throw new UserError(MESSAGES.client);
    }
    throw new UserError(MESSAGES.status(answer.status));
  }

  const body = parseJson(answer.text);
  if (!isRecord(body) || typeof body.access_token !== "string" || body.access_token === "") {
    throw new UserError(MESSAGES.shape);
  }
  const next = body.refresh_token;
  const rotated =
    typeof next === "string" && next !== "" && next !== config.refreshToken ? next : null;
  return { accessToken: body.access_token, rotatedRefreshToken: rotated };
}

/**
 * Asks for the most recent plays, newest first, at most POLL_LIMIT.
 * `afterMs` is the cursor: only plays after that Unix time in milliseconds come back.
 * Returns the raw items. They are checked one by one when they are mapped.
 */
export async function fetchRecentlyPlayed(
  config: SpotifyConfig,
  accessToken: string,
  afterMs: number | null,
): Promise<unknown[]> {
  const query = new URLSearchParams({ limit: String(POLL_LIMIT) });
  if (afterMs !== null) query.set("after", String(afterMs));
  const answer = await send(`${config.apiBase}/me/player/recently-played?${query.toString()}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });

  if (answer.status === 401 || answer.status === 403) throw new UserError(MESSAGES.refused(answer.status));
  if (answer.status === 429) throw new UserError(MESSAGES.limited(retryHint(answer.headers)));
  if (answer.status !== 200) throw new UserError(MESSAGES.status(answer.status));

  const body = parseJson(answer.text);
  if (!isRecord(body) || !Array.isArray(body.items)) throw new UserError(MESSAGES.shape);
  if (body.items.length > POLL_LIMIT) throw new UserError(MESSAGES.tooMany);
  return body.items;
}

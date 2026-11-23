/**
 * A key or login is sent over https, or to this computer. Never over plain http to another host.
 * Returns the problem as one plain line, or null when the address is fine.
 * The line names the variable and never quotes the address, which could hold a secret.
 */
export function addressProblem(variable: string, address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return `${variable} is not a valid address.`;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return `${variable} must start with https://, unless the host is localhost or 127.0.0.1.`;
  }
  return null;
}

/**
 * A Spotify address goes only to Spotify's own host over https, or to this computer (for tests).
 * The refresh token, the client secret and the access token travel to it, so any other host is refused.
 * `host` is the one Spotify host this variable may name. A port, a user name or a password is refused.
 * The line names the variable and never quotes the address.
 */
export function spotifyAddressProblem(variable: string, address: string, host: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return `${variable} is not a valid address.`;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const spotify = url.protocol === "https:" && url.hostname === host && url.port === "";
  const plainLocal = (url.protocol === "http:" || url.protocol === "https:") && local;
  const noLogin = url.username === "" && url.password === "";
  if (noLogin && (spotify || plainLocal)) return null;
  return `${variable} must be https://${host}, or localhost or 127.0.0.1 for tests.`;
}

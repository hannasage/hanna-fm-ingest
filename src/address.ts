/**
 * Checks an address taken from an environment variable. Returns a plain sentence when the
 * address is not acceptable, and null when it is. The sentence names the variable and never
 * the value, because the value can hold a credential.
 *
 * An address must use https. Plain http is allowed only to this computer (localhost or 127.0.0.1).
 */
export function addressProblem(name: string, value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${name} is not a valid address.`;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    return `${name} must start with https://, unless the host is localhost or 127.0.0.1.`;
  }
  return null;
}

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

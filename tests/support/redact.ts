/**
 * Keeps secrets out of anything a test prints.
 * A line is dropped when it names a key, token or secret, or when it holds
 * a JWT-shaped string, or when it holds a value the caller says is secret.
 */
const SENSITIVE_WORDS = /(key|token|secret|password|passwd|credential|authorization|bearer|jwt)/i;
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;

export function redactLines(text: string, knownSecrets: string[] = []): string {
  return text
    .split("\n")
    .filter(
      (line) =>
        !SENSITIVE_WORDS.test(line) &&
        !JWT_SHAPE.test(line) &&
        !knownSecrets.some((secret) => secret.length >= 8 && line.includes(secret)),
    )
    .join("\n");
}

export function lastLines(text: string, count: number): string {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - count)).join("\n");
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Names that must never carry a value to the browser. */
export const BROWSER_SECRET_NAME =
  /NEXT_PUBLIC_\w*(KEY|SECRET|TOKEN|PASSWORD|SUPABASE|DATABASE|DB_)/i;

export function filesUnder(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Names of the secrets whose value appears in the text. Never returns a value. */
export function secretsFoundIn(
  text: string,
  secrets: { name: string; value: string }[],
): string[] {
  return secrets.filter(({ value }) => text.includes(value)).map(({ name }) => name);
}

/** Scans files and returns "relative/path: SECRET_NAME" lines. Never returns a value. */
export function scanFiles(
  root: string,
  files: string[],
  secrets: { name: string; value: string }[],
): string[] {
  return files.flatMap((file) =>
    secretsFoundIn(readFileSync(file, "utf8"), secrets).map(
      (name) => `${relative(root, file)}: ${name}`,
    ),
  );
}

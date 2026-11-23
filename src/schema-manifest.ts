import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The manifest sits beside the migrations folder, never inside it. */
export const MANIFEST_FILE = "vendored-migrations.manifest.json";

export type Manifest = { migrations: Record<string, string> };

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Checksums of every .sql file in a migrations folder, in name order. */
export function checksums(folder: string): Record<string, string> {
  const result: Record<string, string> = {};
  const names = readdirSync(folder).filter((name) => name.endsWith(".sql")).sort();
  for (const name of names) result[name] = sha256(join(folder, name));
  return result;
}

export function manifestPath(root: string): string {
  return join(root, "supabase", MANIFEST_FILE);
}

export function vendoredFolder(root: string): string {
  return join(root, "supabase", "migrations");
}

export function buildManifest(root: string): Manifest {
  return { migrations: checksums(vendoredFolder(root)) };
}

export function readManifest(root: string): Manifest | null {
  const path = manifestPath(root);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

/** Problems between two sets of checksums, as plain lines. An empty list means they match. */
export function compare(
  expected: Record<string, string>,
  actual: Record<string, string>,
  words: { differs: string; missing: string; extra: string },
): string[] {
  const problems: string[] = [];
  for (const [name, checksum] of Object.entries(expected)) {
    if (!(name in actual)) problems.push(`${words.missing}: ${name}`);
    else if (actual[name] !== checksum) problems.push(`${words.differs}: ${name}`);
  }
  for (const name of Object.keys(actual)) {
    if (!(name in expected)) problems.push(`${words.extra}: ${name}`);
  }
  return problems;
}

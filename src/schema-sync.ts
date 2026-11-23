import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildManifest, manifestPath } from "./schema-manifest.ts";

/**
 * Copies the site repository's migrations into this repository's vendored copy.
 * The site repository owns the schema. Run this from the root of this repository,
 * with HANNA_FM_PATH set to a sibling clone of the site repository.
 * It then writes a checksum manifest of the vendored migrations, which `schema:check`
 * and the tests compare against.
 */
function main(): void {
  const sitePath = process.env.HANNA_FM_PATH;
  if (!sitePath) {
    process.stderr.write("HANNA_FM_PATH is not set. Set it to the path of a hanna-fm site clone.\n");
    process.exit(2);
  }

  const source = join(sitePath, "supabase", "migrations");
  if (!existsSync(source)) {
    process.stderr.write("HANNA_FM_PATH has no supabase/migrations folder. Is it a hanna-fm clone?\n");
    process.exit(1);
  }

  const files = readdirSync(source).filter((name) => name.endsWith(".sql")).sort();
  if (files.length === 0) {
    process.stderr.write("The site's supabase/migrations folder holds no .sql files.\n");
    process.exit(1);
  }

  const target = join(process.cwd(), "supabase", "migrations");
  mkdirSync(target, { recursive: true });
  for (const name of files) copyFileSync(join(source, name), join(target, name));
  writeFileSync(manifestPath(process.cwd()), `${JSON.stringify(buildManifest(process.cwd()), null, 2)}\n`);
  writeFileSync(manifestPath(process.cwd()), `${JSON.stringify(buildManifest(process.cwd()), null, 2)}\n`);
  process.stdout.write(`Copied ${files.length} migration${files.length === 1 ? "" : "s"}:\n${files.map((f) => `  ${f}`).join("\n")}\n`);
}

main();

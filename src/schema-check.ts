import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  buildManifest,
  checksums,
  compare,
  MANIFEST_FILE,
  readManifest,
} from "./schema-manifest.ts";

/**
 * Checks the vendored migrations. Run it from the root of this repository.
 * It always checks them against the manifest that `schema:sync` wrote.
 * When HANNA_FM_PATH names a sibling site clone, it also compares them with that clone.
 *
 * The site repository is private, so CI cannot read it and CI does not run the site comparison.
 */
function main(): void {
  const root = process.cwd();
  const problems: string[] = [];
  const passed: string[] = [];

  const manifest = readManifest(root);
  if (manifest === null) {
    process.stderr.write(`The manifest supabase/${MANIFEST_FILE} is missing. Run schema:sync.\n`);
    process.exit(1);
  }
  const vendored = buildManifest(root).migrations;
  // The manifest is what the copy should be.
  const manifestProblems = compare(manifest.migrations, vendored, {
    differs: "differs from the manifest",
    missing: "listed in the manifest but missing",
    extra: "not in the manifest",
  });
  if (manifestProblems.length === 0) passed.push("The vendored migrations match the manifest.");
  problems.push(...manifestProblems);

  const sitePath = process.env.HANNA_FM_PATH;
  if (!sitePath) {
    passed.push("HANNA_FM_PATH is not set, so they were not compared with a site clone.");
  } else {
    const source = join(sitePath, "supabase", "migrations");
    if (!existsSync(source)) {
      process.stderr.write("HANNA_FM_PATH has no supabase/migrations folder. Is it a hanna-fm clone?\n");
      process.exit(1);
    }
    const siteProblems = compare(checksums(source), vendored, {
      differs: "differs from the site clone",
      missing: "missing from the vendored copy",
      extra: "not in the site clone",
    });
    if (siteProblems.length === 0) passed.push("The vendored migrations match the site clone.");
    problems.push(...siteProblems);
  }

  if (passed.length > 0) process.stdout.write(`${passed.join("\n")}\n`);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
}

main();

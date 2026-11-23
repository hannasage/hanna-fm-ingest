# hanna-fm-ingest

The data side of hanna.fm: a Node command-line tool in TypeScript that stores plays in Supabase. The spec is GitHub issue 1 and the tickets that follow it. The site is in the hanna-fm repository, which owns the database schema.

## The four gates

Run all four before every commit. Each must report zero errors.

```
npm run typecheck
npm run lint
npm test
npm run build
```

`npm test` needs this repository's own local Supabase stack running (`npm run db:start`). Its ports are 56330 to 56339. Never use another stack's ports or containers.

## Never commit secrets or data

- No credential, token, key, data file or export file, ever. Not in code, tests, fixtures, logs or pull request text.
- The command reads `SUPABASE_URL` and `SUPABASE_SECRET_KEY` from the environment. Tests read the local stack's values from `supabase status` and keep them in memory.
- Fixtures are synthetic, named `*.fixture.json`, in `tests/fixtures`. Nothing here is real listening data.
- The importer never prints a row's content. It prints counts only.

## The schema is vendored

`supabase/migrations` is a copy. The hanna-fm repository owns it. Do not edit a migration here. Run `npm run schema:sync` with `HANNA_FM_PATH` set to a sibling hanna-fm clone.

## Branch and pull request only

Never commit to `main`. Branch, commit in small steps (`type: summary`), open a draft pull request. A person merges it.

## Test seam

Tests run the real command against the local Supabase and check the stored rows. They do not mock the database. Add a failing test first for any change in behavior.

## Who builds

ECC agents build and review code here: `tdd-guide` to build, the reviewers (`code-reviewer`, `security-reviewer`, `silent-failure-hunter`) to review.

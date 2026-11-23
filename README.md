# hanna-fm-ingest

The private data side of hanna.fm. It polls Spotify every 30 minutes, imports Spotify's Extended Streaming History export, resolves items to MusicBrainz IDs, and builds the derived data the site shows.

Status: in development. The export importer is the first piece.

## Rules for every commit

- No credential, token, data file or export file, ever. Export files carry IP addresses and are never committed.
- The importer drops IP address, country, user agent, platform, podcast plays and private-session plays before anything is stored.
- No Spotify response is ever used to train or feed a model.
- Four gates must pass at zero errors before a commit: typecheck, lint, test, build.
- Work on a branch and open a pull request. Never commit to `main`.

## Import an export

```
export SUPABASE_URL=...
export SUPABASE_SECRET_KEY=...
npm run import-export -- <path>
```

`<path>` is one Extended Streaming History `.json` file, or a directory of them. Zip files are not read: unzip first.

The command prints counts only: read, imported, duplicate, and dropped by reason (`podcast`, `private_session`, `malformed`). It never prints a row. A play already stored is skipped, so running the same import twice stores nothing new.

The key names the importer reads are in one table, `src/mapping.ts`. Ticket 7 checks them against a real export.

## Local development

```
npm install
npm run db:start     # this repository's own stack, ports 56330 to 56339
npm run typecheck && npm run lint && npm test && npm run build
npm run db:stop
```

Tests read the stack's address and key from `supabase status` at run time and keep them in memory.

## The database schema is vendored

The migrations in `supabase/migrations` are a vendored copy. The hanna-fm site repository owns them, and a change starts there. To refresh the copy:

```
HANNA_FM_PATH=../hanna-fm npm run schema:sync
```

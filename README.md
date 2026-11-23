# hanna-fm-ingest

The private data side of hanna.fm. It polls Spotify every 30 minutes, imports Spotify's Extended Streaming History export, resolves items to MusicBrainz IDs, and builds the derived data the site shows.

Status: in development. The export importer and the poller are built.

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

The command prints counts only to stdout: `read`, `imported`, `duplicate`, `dropped` by reason, and `not_attempted`. It never prints a row. `read` always equals `imported` + `duplicate` + `dropped` + `not_attempted`. A play already stored is skipped, so running the same import twice stores nothing new.

Dropped reasons, checked in this order:

- `private_session`: the private flag is anything but an explicit `false`. A missing or odd value counts as private.
- `podcast`: episode fields are present.
- `no_track`: no usable track URI. It must be a string starting with `spotify:track:`.
- `malformed`: a field is missing or has the wrong type.
- `too_short`: played under `MIN_PLAY_MS` (30 seconds), set in `src/settings.ts`.

Other behavior:

- Every file is checked first, so a bad file fails the run before anything is written. Then files are read one at a time and stored in batches of 500. A path that is not a regular file, or a file over 500 MB, is refused before it is read.
- If a database request fails midway, the command exits 1 and prints a message plus the partial counts, ending with `partial: true`, to stderr. Run it again: stored plays are skipped.
- If a file holds no row with a mapped key, a one-line warning on stderr names the key. It never shows row content.
- If rows were read but nothing was stored and no play was a repeat, the command exits 1 and says the mapping keys are probably wrong.
- `SUPABASE_URL` must be https, unless the host is `localhost` or `127.0.0.1`. Otherwise the command exits 2 before it sends the key.

The key names the importer reads are in one table, `src/mapping.ts`. Ticket 7 checks them against a real export.

## Poll Spotify

```
export SUPABASE_URL=... SUPABASE_SECRET_KEY=...
export SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=... SPOTIFY_REFRESH_TOKEN=...
npm run poll
```

One run trades the refresh token for an access token, asks Spotify's recently-played call for up to 50 plays after the latest stored end time, and stores each new one with source `poll` and no play length (`ms_played` is null). It prints counts only: `fetched`, `stored`, `duplicate`, `skipped` by reason (`no_track`, `malformed`), and `possible_gap`.

- A play is a repeat when the same track has a stored end time within `DEDUPE_WINDOW_SECONDS` (10, in `src/settings.ts`) of it, on either side. The table's exact key still applies.
- `possible_gap: true` means exactly 50 plays came back, so older plays may be missing. The run still exits 0.
- A new refresh token in Spotify's answer prints a warning without the token. Update the `SPOTIFY_REFRESH_TOKEN` secret.
- Exit 1 for: a rejected or expired login, 401, 403, 429 (with the retry hint when Spotify sends one), malformed JSON, and any network failure. No message holds a token, a key or a response body.
- `SPOTIFY_ACCOUNTS_BASE` and `SPOTIFY_API_BASE` are optional and for tests. They follow the same https-unless-localhost rule as `SUPABASE_URL`.
- Spotify refresh tokens last 6 months from authorization, and refreshing does not extend that. Renew the login before then.
- `.github/workflows/poll.yml` runs this every 30 minutes on the main branch of this repository. It needs five Actions secrets, named as above.
- `played_at` may be the start of a play, not the end. It is stored as `ended_at` until ticket 7 measures it.

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

`schema:sync` also writes `supabase/vendored-migrations.manifest.json`, a checksum for each vendored file. A test fails if a vendored file changes without a sync.

To compare the copy with the site, run:

```
HANNA_FM_PATH=../hanna-fm npm run schema:check
```

It checks the manifest, and the site clone when `HANNA_FM_PATH` is set. CI cannot do the site comparison: the site repository is private, and CI cannot read it. CI runs the manifest check through the tests only. A CI diff against the site becomes possible once the site repository is public.

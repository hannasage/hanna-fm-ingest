# hanna-fm-ingest

The private data side of hanna.fm. It polls Spotify every 30 minutes, imports Spotify's Extended Streaming History export, resolves items to MusicBrainz IDs, and builds the derived data the site shows.

Status: in development. The export importer and item identity are built.

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

## Resolve items

```
export SUPABASE_URL=...
export SUPABASE_SECRET_KEY=...
export MB_USER_AGENT='AppName/1.0 ( contact )'
npm run resolve-items
```

Gives every artist, album and track in the stored plays one canonical MusicBrainz ID, and stores it in `items`. A Spotify track URI sits beside it as an alias. The command finds each distinct item in `plays` that has no `items` row, and resolves it. Pending rows from an earlier run are tried again. Run one copy at a time: the one-request-a-second limit is kept inside one run, not across two.

`MB_USER_AGENT` is required and has no default. MusicBrainz asks every client to send a User-Agent that says who calls and how to reach them, such as `AppName/1.0 ( contact-url-or-email )`. Put your own contact detail in the environment only, never in this repository. A missing, blank or non-ASCII value exits 2 before any request. `MB_API_BASE` is for tests: it must be https unless the host is `localhost` or `127.0.0.1`.

How it matches:

- Tracks search MusicBrainz recordings by title, artist and album. Albums search release groups by title and artist. Artists search by name.
- The top result counts only when MusicBrainz's own score is at least `MATCH_MIN_SCORE` (90, in `src/settings.ts`). A lower score leaves the item `unresolved` with reason `below_threshold`. No result is `no_match`. The score and the matched name are stored either way, so a wrong match can be audited.
- A matched track names its artists. When one is the artist the plays name, that artist row settles from the credit with no search.
- Every request goes through one queue that waits at least one second after the last request ended. A repeat lookup is served from `mb_cache` and sends nothing.
- A 429, 503, other server error, or no answer is retried up to `MB_MAX_ATTEMPTS` times (3), waiting 1 s, then 2 s, longer if `Retry-After` says so. After that the item stays `pending`, never `unresolved`, and the next run tries it again.
- Two Spotify tracks can be one recording. The first keeps the MBID. The other keeps its own row with `merged_into` set to the first, so no alias is lost.
- Any other refusal, or an answer in an unknown shape, stops the run with exit 1. Nothing is cached for it.

Stdout is counts only: `new`, `resolved`, `unresolved`, `pending`, `requests`, `cache_hits`. It never prints a name, a response or a key.

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

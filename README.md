# hanna-fm-ingest

The data side of hanna.fm. It polls Spotify every 30 minutes, imports Spotify's Extended Streaming History export, resolves items to MusicBrainz IDs, and builds the derived data the site shows.

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
npm run resolve-items [-- --limit N] [-- --retry-failed]
```

Gives every artist, album and track in the stored plays one canonical MusicBrainz ID, and stores it in `items`. A Spotify track URI sits beside it as an alias. The command finds each distinct item in `plays` that has no `items` row, and resolves it. Pending rows from an earlier run are tried again.

`MB_USER_AGENT` is required and has no default. MusicBrainz asks every client to send a User-Agent that says who calls and how to reach them, such as `AppName/1.0 ( contact-url-or-email )`. Put your own contact detail in the environment only, never in this repository. A missing, blank or non-ASCII value exits 2 before any request. `MB_API_BASE` is for tests: it must be https unless the host is `localhost` or `127.0.0.1`.

How it matches:

- Tracks search MusicBrainz recordings by title, artist and album. Albums search release groups by title and artist. Artists search by name. Each search asks for 5 hits (`MB_MATCH_FETCH_LIMIT`).
- A track or album is searched only when the plays name its artist. With no artist it is `unresolved` with reason `no_artist`, because a title alone matches too many songs. A blank name is `empty_name`. A name over 200 characters is `name_too_long`, and no request is made.
- A hit counts only if it names what was played. Names are compared the way source keys are: NFKC, lower case, accents removed, curly quotes made straight, `&` read as `and`, spaces collapsed.
- An artist hit counts only if its name, or one of the aliases it came with, equals the artist played. Any other hit is `no_match`, with its score and name kept for audit.
- A track or album hit counts only if its title equals the title played, and, when the plays name an artist, its first (primary) artist credit, under any name it carries, equals that artist or is the artist already matched. A match only on a featured credit does not count. So a remix or a "feat." recording never resolves on score alone.
- An artist MBID learned this way, from a matched artist hit or from a matched track's primary credit, is the only one later hits may rely on.
- Among the hits that count, those whose raw score is at least `MATCH_MIN_SCORE` (90, in `src/settings.ts`, compared with no rounding) win. If two different MusicBrainz IDs both do, the item is `ambiguous` and nothing is settled. A lower best score is `below_threshold`. No usable hit is `no_match`. The score and the matched name are stored either way, so a wrong match can be audited.
- When no recording matches the exact album phrase, the track is searched once more without the album.
- A matched track names its artists. When its primary artist is the artist the plays name, that artist row settles from the credit with no search, a null score and reason `credit`.
- Every request goes through one queue that waits at least one second after the last request ended. A repeat lookup is served from `mb_cache` (keyed by the SHA-256 of the request URL, holding only the parsed hits, expiring after 90 days) and sends nothing. At most 1 MB is read from an answer, redirects are never followed, and NUL characters are stripped from every name stored.
- Two Spotify tracks can be one recording. The first keeps the MBID. The other keeps its own row with `merged_into` set to the first, so no alias is lost. `merged_into` must point to a row of the same kind.

When MusicBrainz fails:

- A 429, any 5xx, or no answer is retried up to `MB_MAX_ATTEMPTS` times (3), waiting 1 s, then 2 s, longer if `Retry-After` says so. A `Retry-After` is cut to `MB_RETRY_AFTER_MAX_MS` (120 s). It also holds the queue after the last try, so the next item is not sent into a server that said wait. After the last try the item stays `pending`, never `unresolved`, and the next run tries it again.
- A failed lookup is charged to its item as one attempt only once MusicBrainz has then answered a different lookup, which shows the failure was the item's own. An outage, or a run that stops on a breaker, charges nothing: not the item that tripped it, and not the ones before it. A failure at the very end of a run, with no answer after it, is not charged either, so such an item stays `pending` and the run exits 1 each time.
- The reason is kept as a fixed word (`http_503`, `dns`, `timeout`, `tls`, `connection_refused`, `connection_reset`, `redirect`, `network`) and printed once per kind to stderr. Any item left pending by an outage makes the run exit 1.
- After 5 unavailable lookups in a row (`RESOLVE_MAX_CONSECUTIVE_UNAVAILABLE`) the run stops with exit 1.
- An item that has been charged 5 attempts (`RESOLVE_MAX_ATTEMPTS`) is `exhausted`: it is not tried again unless `--retry-failed` is passed. Exhausted items are counted apart from skipped ones, and the command exits 1 while any exist, with a hint naming `--retry-failed`. A stuck item is never quiet.
- A 4xx other than 401, 403 and 429 leaves that item `pending` and charges it one attempt, as above. It settles as `unresolved` with reason `bad_query` only when its attempts reach 5. The run goes on. After 5 refusals in a row (`RESOLVE_MAX_CONSECUTIVE_REFUSED`) it stops, so a wrong address or a 408 burns nothing for good.
- A 401 or 403, an answer in an unknown shape, not JSON, or over 1 MB stops the run with exit 1. Nothing is cached for it.

One run at a time: a run takes the `resolve-items` row of `job_locks` with one update, holds it for a 30-minute lease, refreshes it before each item and before every request to MusicBrainz (retries included), and frees it at the end or on SIGINT and SIGTERM. A second run exits 3 and changes nothing. A run that is killed with no chance to clean up frees the lock when its lease runs out.

Flags: `--limit N` processes at most N items and prints how many remain. `--retry-failed` tries items that have failed 5 times or more.

Exit codes: 0 done, 1 stopped, or some items left pending, or some items exhausted, 2 bad setting or argument, 3 another run holds the lock.

Stdout is counts only: `new`, `total`, `resolved`, `unresolved`, `pending`, `skipped`, `exhausted`, `remaining`, `requests`, `cache_hits`. Every item that was pending at the start is in exactly one of `resolved`, `unresolved`, `pending`, `skipped`, `exhausted` and `remaining`, and `total` is their sum. Progress lines (`progress: 25 of 140 items`) go to stderr every 25 items. Nothing printed holds a name, a response or a key.

Known design debt, decided when the Map is planned:

- An aliases table for several Spotify identifiers per item.
- Track rows that point at their artist and album item ids.
- Two different artists with the same name share one row, because an artist's identity is its normalized name.
- Lease times come from this computer's clock, not the database's.
- Reading only the plays newer than the last scan.

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

It checks the manifest, and the site clone when `HANNA_FM_PATH` is set.

CI runs the site comparison too. The site repository is public, so the `gates` workflow (on every pull request and every push to `main`) shallow-clones `hanna-fm` main into a temp folder, with no token, and runs `schema:check` with `HANNA_FM_PATH` pointing at it. Any difference fails the job with: "the vendored migrations differ from hanna-fm main; run schema:sync". The fix is to run `schema:sync` against a current site clone and commit the result.

**The site pull request merges first.** A pull request here that adds or changes a migration cannot pass the comparison until the same file is on the site's main. Open the site pull request, merge it, then re-run CI here. The comparison also fails when the site's main has a migration this copy lacks, so a drift shows up on the next pull request.

What the tests prove and what only CI proves: the tests parse `ci.yml`, run the step's script with a stand-in for `git clone`, and check that a matching copy passes and that a changed, extra or missing file fails with the message. Only a real CI run proves that the anonymous clone of `hanna-fm` works from GitHub's runners.

## Make your own

This tool fills the database that the hanna.fm website reads. To run your own copy, for noncommercial purposes, you will need:

- A Supabase project, with the migrations from the website repository applied.
- A Spotify developer app in Development Mode. Spotify requires the app owner to have Premium.
- Your own Extended Streaming History export, requested from Spotify's account privacy page.
- A descriptive MusicBrainz User-Agent with your own contact detail, set in `MB_USER_AGENT`.

A setup guide is not written yet. Spotify, MusicBrainz and Last.fm each have their own terms for what you may do with their data. Read them before you publish a fork. Never commit an export file: it carries IP addresses.

## License

PolyForm Noncommercial 1.0.0. You may use, change and share this software for noncommercial purposes, including personal, hobby, research and educational use. You may not use it in a paid product or for commercial gain. This is a source-available license, not an open source license as the OSI defines one. See `LICENSE`.

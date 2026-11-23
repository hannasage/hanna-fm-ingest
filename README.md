# hanna-fm-ingest

The private data side of hanna.fm. It polls Spotify every 30 minutes, imports Spotify's Extended Streaming History export, resolves items to MusicBrainz IDs, and builds the derived data the site shows.

Status: in development. The export importer, the poller and item identity are built.

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

One run trades the refresh token for an access token, asks Spotify's recently-played call for plays after the latest stored end time, and stores each new one with source `poll` and no play length (`ms_played` is null). It prints counts only: `fetched`, `stored`, `duplicate` (split into `duplicate_export` and `duplicate_exact`), and `skipped` by reason (`no_track`, `malformed`). `fetched` always equals `stored` + `duplicate` + `skipped`.

Paging:

- A page holds at most 50 plays. When a full page comes back, the poll pages back with `before` (the oldest play time on the page) until a page holds only plays at or before the stored cursor, or is shorter than 50, or is empty. Spotify refuses `after` and `before` together, so only the first page uses `after`.
- At most `POLL_MAX_PAGES` pages are read (20, in `src/settings.ts`). Hitting that limit stores what was fetched, prints `possible_gap: true`, and exits 1. `possible_gap` is printed only in that case, and when Spotify gives no older page to go back to.

Repeats:

- `duplicate_export`: the same track has a stored play from an export within `DEDUPE_WINDOW_SECONDS` (10, in `src/settings.ts`) of it, on either side. Only export rows are checked this way.
- `duplicate_exact`: the table's exact key (track and end time) already holds the play, or the answer holds it twice. A poll row is told apart by its exact key alone, so a replay of a short track is kept.

Exit 1 (with a `::error::` annotation for the first three):

- Every fetched item was skipped and at least one is malformed, so nothing was stored by mistake (a renamed field looks like this).
- Any item that is not clearly a local file or an episode and cannot be read as a track is malformed. That includes a missing `track` object, a missing `type`, and a missing or bad `uri`.
- Any item is malformed. The valid plays are stored first.
- The page limit was reached, or Spotify gave no older page.
- The newest stored play is more than 60 seconds ahead of the clock. The poll names the problem and stops before it uses the login. Fix or delete that row.
- A rejected or expired login, 401, 403, 429 (with the retry hint when Spotify sends one), malformed JSON, a response over 1 MB, a page of more than 50 items, and any network failure. No message holds a token, a key or a response body.

Exit 0 with a plain note on stderr: every fetched item was a local file (`is_local` is true) or an episode (`type` is `episode`), the only two things the poll skips as `no_track`, so nothing was stored and nothing is malformed. A window like that is normal, and it stays green until a real play appears.

Limits on what Spotify sends: a play stamped more than 60 seconds in the future, or a track, artist or album text over 500 characters, is malformed. A response body over 1 MB is refused. The limits are named in `src/settings.ts`.

Other behavior:

- A new refresh token in Spotify's answer prints `::warning::Spotify issued a new refresh token. Re-authorize and store the new token.` The poll never prints the token. Store the new one as the `SPOTIFY_REFRESH_TOKEN` secret.
- `SPOTIFY_ACCOUNTS_BASE` and `SPOTIFY_API_BASE` are optional and for tests. They may name only `https://accounts.spotify.com` and `https://api.spotify.com`, or `localhost` or `127.0.0.1`. Any other address exits 2 before anything is sent, because the login travels to it.
- Spotify refresh tokens last 6 months from authorization, and refreshing does not extend that. Renew the login before then.
- `played_at` may be the start of a play, not the end. It is stored as `ended_at` until ticket 7 measures it.

## Set up the scheduled poll (Hanna)

`.github/workflows/poll.yml` runs the poll every 30 minutes the moment it reaches `main`. Before it merges:

1. Merge the site repository's pull request with the `poll_plays` migration first, and apply it to the production database. The poll cannot store a play without it.
2. In this repository's settings, create an environment named `production`. Limit its deployment branches to `main`. Then a manual run from any other branch cannot read the secrets.
3. Add the five secrets to that environment, not to the repository: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`. Delete any copy at repository level.
4. Protect `main` (pull request and checks required), so a change to the workflow cannot skip review. `.github/CODEOWNERS` gives `.github/` to `@hannasage`. Turn on "Require review from Code Owners" for it to bind.

Scheduled runs start only from the default branch, and forks do not run them.

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

It checks the manifest, and the site clone when `HANNA_FM_PATH` is set. CI cannot do the site comparison: the site repository is private, and CI cannot read it. CI runs the manifest check through the tests only. A CI diff against the site becomes possible once the site repository is public.

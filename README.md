# hanna-fm-ingest

The data side of hanna.fm. It polls Spotify every 30 minutes, imports Spotify's Extended Streaming History export, resolves items to MusicBrainz IDs, and builds the derived data the site shows.

Status: in development. The export importer, the poller, item identity, the poll run records and the Spotify login helper are built.

## Rules for every commit

- No credential, token, data file or export file, ever. Export files carry IP addresses and are never committed.
- The importer drops IP address, country, user agent, platform, podcast plays and private-session plays before anything is stored.
- No Spotify response is ever used to train or feed a model.
- Four gates must pass at zero errors before a commit: typecheck, lint, test, build.
- Work on a branch and open a pull request. Never commit to `main`.

## Import an export

```
export SUPABASE_URL=...
read -rs SUPABASE_SECRET_KEY; export SUPABASE_SECRET_KEY
npm run import-export -- <path>
```

Secrets never go on a command line as `export NAME=value`: the shell keeps that line in its history file. `read -rs NAME` waits for you to paste the value, shows nothing and stores nothing in history. Press Enter after you paste. The same holds for any secret value you type in a terminal: read it with `read -rs`, never put it in a command. The `...` after `SUPABASE_URL` stands for the address, which is not a secret.

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
export SUPABASE_URL=... SPOTIFY_CLIENT_ID=...
read -rs SUPABASE_SECRET_KEY; export SUPABASE_SECRET_KEY
read -rs SPOTIFY_CLIENT_SECRET; export SPOTIFY_CLIENT_SECRET
read -rs SPOTIFY_REFRESH_TOKEN; export SPOTIFY_REFRESH_TOKEN
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

## Poll run records

Every `poll` run that gets as far as the database leaves one row in `poller_runs`, so the site can report the poller's health. The row holds `started_at`, `finished_at`, `outcome` (`ok` or `failed`), the `fetched` and `stored` counts, and for a failure a short `failure_kind`. The site repository owns the table.

- A run that exits 0 is `ok`. A run that exits 1 is `failed`. A run that exits 2 (a missing or bad setting) writes nothing, because it never reached the database.
- `fetched` and `stored` are the poll's own counts. They are null when the run stopped before it read its pages, because the count is then not known.
- `failure_kind` is one fixed word. It holds no message, token, key or play.

| `failure_kind` | What happened |
|---|---|
| `login_expired` | Spotify answered `invalid_grant`: the refresh token is expired, revoked or invalid |
| `forbidden` | Spotify answered 401 or 403, or refused the app credentials |
| `rate_limited` | Spotify answered 429 |
| `bad_response` | Not JSON, the wrong shape, a body over 1 MB, or more than 50 items in a page |
| `network` | Spotify could not be reached |
| `future_cursor` | The newest stored play is more than 60 seconds ahead of the clock |
| `malformed_items` | The run finished, but an item could not be read |
| `page_cap` | The run reached `POLL_MAX_PAGES` pages |
| `spotify_unavailable` | Spotify answered 5xx, or a status the poller does not expect |
| `database_error` | The database refused a read or a write, or gave an answer the poll cannot read |
| `stalled` | The page walk could not go back to an older page |
| `bug` | An exception the poller did not plan for. Its text is never stored |
| `other` | A last resort: a planned stop that names no kind |

A run with two problems gets one kind: a stop short of older plays (`page_cap` or `stalled`) wins over `malformed_items`.

Recording never changes a run's result. If the insert fails, the run prints `::warning::could not record the poll run` and keeps its exit code. The warning holds no detail. A run that cannot reach the database at all has nothing to write: it exits 1 as before and prints the same warning.

At the end of a run, once its own row is written, the poll deletes `poller_runs` rows whose `finished_at` is more than `POLLER_RUNS_KEEP_DAYS` (90, in `src/settings.ts`) days old. Two rows are never deleted, however old: the newest `ok` row and the newest `failed` row, so a long outage still leaves the site its last success and last failure. The delete is skipped when the runner's clock is more than `CLOCK_SKEW_TOLERANCE_MS` (5 minutes) behind the newest row's `finished_at`, because a wrong clock would put the cutoff in the wrong place. If a database call of the delete fails, the run prints `::warning::could not delete old poll run records` and keeps its exit code. Each database call of the record waits at most `RECORD_TIMEOUT_MS` (10 seconds).

A stale status on the site does not always mean Spotify or the database failed. The workflow itself can fail before it records anything (a bad setting, a failed install, a disabled schedule). When the status is stale, check the Actions tab of this repository as well.

## Login reminder

At the end of every poll run that reached the database, the poll reads `spotify_authorized_at` from `poller_state` and may print one line, a GitHub annotation on the run page:

- `::warning::Spotify login date is not recorded. Run set-state spotify_authorized_at <date>.` when the key is absent or its value is not a date.
- `::warning::Spotify login is N days old. Re-authorize it before day 180.` when the login is `LOGIN_WARN_DAYS` (150, in `src/settings.ts`) days old or more.

The reminder never changes the exit code. If the read fails, it prints nothing. It never prints the stored value or any secret.

## Record when the login was authorized

```
export SUPABASE_URL=...
read -rs SUPABASE_SECRET_KEY; export SUPABASE_SECRET_KEY
npm run set-state -- spotify_authorized_at 2026-11-20
```

`set-state <key> <value>` writes one row of `poller_state`, so the site can warn before the Spotify login runs out (refresh tokens last 6 months from authorization). Only the key `spotify_authorized_at` is allowed for now (`ALLOWED_STATE_KEYS` in `src/settings.ts`). The value is a real date, `YYYY-MM-DD` (read as UTC), or an ISO time such as `2026-11-20T10:00:00Z`. It is stored as given. A value in the future is refused.

Run it again after each new authorization. It is safe to run twice: one key keeps one row, and a second call replaces the value.

`set-state` trusts what it is given. It can write a recent date for a login that is really old, and so hide a true expiry: the reminder and the site then count from the date written. Write the date of the real authorization and no other. Only a person who holds the secret key (`SUPABASE_SECRET_KEY`) can run it, because the table refuses the browser roles.

A bad argument exits 2 with one plain line and stores nothing. A database failure exits 1. The command prints only `Recorded spotify_authorized_at.` on success. It never prints the value or any secret.

## Get a Spotify refresh token (Hanna)

`spotify-login` runs the Spotify login once and prints a refresh token. Run it on your own computer, in a terminal, because it uses the app's client secret.

1. In a terminal, set the two values. They come from the Spotify app's settings page. The client id is not a secret. The client secret is, so it is read silently and never enters shell history:

   ```
   export SPOTIFY_CLIENT_ID=...
   read -rs SPOTIFY_CLIENT_SECRET; export SPOTIFY_CLIENT_SECRET
   ```

   Press Enter after you paste the secret. Never pass either value as an argument, and never paste them into chat. The command reads them from the environment only, and refuses any argument.
2. Optional: to record the login date at the same time, also set `SUPABASE_URL` (`export SUPABASE_URL=...`) and read `SUPABASE_SECRET_KEY` the same silent way: `read -rs SUPABASE_SECRET_KEY; export SUPABASE_SECRET_KEY`.
3. Run `npm run spotify-login`.
4. It prints an address. Open it in your own browser (the command never opens one), sign in to Spotify, and approve.
5. The browser returns to `http://127.0.0.1:8765/callback`. The command then prints the granted scopes and one line, `SPOTIFY_REFRESH_TOKEN=<token>`.
6. Copy the token (the part after `=`) into this repository's `production` environment secret `SPOTIFY_REFRESH_TOKEN`. Never paste it into chat, a file or a pull request. The command also reminds you, on stderr, to do this and then clear the terminal and its scrollback, because terminals, tmux and screen recorders can keep what was printed. In many terminals this works: `clear && printf '\e[3J'`. If you use tmux, also clear its history (`tmux clear-history`). Stop any recorder before you run the login.

The redirect address `http://127.0.0.1:8765/callback` is `SPOTIFY_REDIRECT_URI` in `src/settings.ts`. It must match, character for character, the redirect URI registered in the Spotify app. Spotify refuses `localhost` there, so it is the IP address. To use another port, set `SPOTIFY_LOGIN_PORT` (1024 to 65535) and register the redirect URI with that port in the Spotify app as well.

What it does:

- Listens on `127.0.0.1` only. It answers a request only when the `Host` header is exactly `127.0.0.1:<port>`; any other `Host` gets 400, which stops a web page that points a name at this computer. Any other path gets 404 and a request that is not a GET gets 405. One good GET to `/callback` ends the run and closes the listener. It gives up after 5 minutes (exit 1).
- Makes a random `state` of 256 bits for each run. A callback with a wrong, missing or repeated `state` (or a repeated `code` or `error`) gets 400 and the command keeps listening, so a stray request from another web page cannot end the run. Only a request with the right `state` ends it.
- Uses PKCE as well as the client secret: it makes a random code verifier of 128 characters from a secure random source, sends its S256 hash as `code_challenge` in the address you open, and sends the verifier with the code. The verifier is never printed.
- A refusal in the browser (`access_denied`, or any `error`) exits 1 with a plain message.
- Trades the code for tokens with Spotify's token endpoint, using Basic client authentication and a form body. The access token is never printed or stored.
- Requests only `user-read-recently-played`, the scope the poller needs (`LOGIN_SCOPES` in `src/settings.ts`). It prints the scopes Spotify granted. `user-read-currently-playing` (a later Now playing strip) and `playlist-read-private` (a later playlist picker) are listed in `LATER_LOGIN_SCOPES` in the same file for a later feature, and are not requested.
- Prints the refresh token only when stdout is an interactive terminal. In a pipe, a file or a CI job it exits 2 before it starts, so a token never lands in a log.
- With `SUPABASE_URL` and `SUPABASE_SECRET_KEY` set, it records `spotify_authorized_at` (today, in UTC) the same way `set-state` does. If that fails it prints a note with the `set-state` command to run, and still exits 0.
- Never prints the client secret, the code or any response body. Redirects are refused and each request times out. `SPOTIFY_ACCOUNTS_BASE` (tests only) follows the same address rule as the poll.

Exit codes: 0 done, 1 the login did not finish (refused, timed out, a Spotify error, a busy port), 2 a bad setting, an argument, or output that is not a terminal.

More scopes later: a refresh token carries only the scopes it was authorized with. When a later feature needs more scopes, move its names from `LATER_LOGIN_SCOPES` into `LOGIN_SCOPES` in the same change as the feature, run `spotify-login` again, and store the new token as the `SPOTIFY_REFRESH_TOKEN` secret. Running the login again restarts the six month clock, and the command records the new date.

Renew the login every six months. A refresh token lasts 6 months from authorization, and refreshing does not extend it. Run `spotify-login` again before then, replace the `SPOTIFY_REFRESH_TOKEN` secret, and let the command record the new date. The poll warns from day 150.

## Set up the scheduled poll (Hanna)

`.github/workflows/poll.yml` runs the poll every 30 minutes the moment it reaches `main`. Before it merges:

1. Merge the site repository's pull request with the `poll_plays` migration first, and apply it to the production database. The poll cannot store a play without it.
2. In this repository's settings, create an environment named `production`. Limit its deployment branches to `main`. Then a manual run from any other branch cannot read the secrets.
3. Add the five secrets to that environment, not to the repository: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`. Delete any copy at repository level.
4. Protect `main` (pull request and checks required), so a change to the workflow cannot skip review. `.github/CODEOWNERS` gives `.github/` to `@hannasage`. Turn on "Require review from Code Owners" for it to bind.

Scheduled runs start only from the default branch, and forks do not run them.

## Keep the scheduled poll switched on

This repository is public. GitHub's documentation for the `schedule` event says: "In a public repository, scheduled workflows are automatically disabled when no repository activity has occurred in 60 days." The poll is a scheduled workflow, so it can be switched off this way.

`.github/workflows/keepalive.yml` runs once a month (06:23 UTC on the 1st) and by hand. It calls GitHub's documented "Enable a workflow" endpoint for `poll.yml`, reads the workflow's state back, and fails the run unless the state is `active`. It has the `actions: write` permission and nothing else, uses no secret and no action. It runs only the `gh` program that GitHub-hosted runners carry. A failed run shows red and sends GitHub's usual failure email.

What is verified and what is not:

- Verified from the docs: the 60-day rule; the endpoint (`PUT /repos/{owner}/{repo}/actions/workflows/{workflow_id}/enable`), which "enables a workflow and sets the state of the workflow to active" and needs the Actions write permission. Verified by a real call: the endpoint returns 204 for a workflow that is already active, so the monthly call does not fail on a healthy one.
- Unverified: the docs do not say that re-enabling resets the 60-day clock, and they do not say what counts as repository activity. So the keepalive is a best effort, not a proven guard. It is also a scheduled workflow itself, so the same rule applies to it.
- Fallback 1: the site's poller-health check (a later ticket) warns when no poll has run.
- Fallback 2: a person re-enables the workflow by hand: Actions tab, `poll`, "Enable workflow", or `gh workflow enable poll.yml`.

Merging this branch starts both schedules. Do it only after the setup steps above.

## Resolve items

```
export SUPABASE_URL=...
read -rs SUPABASE_SECRET_KEY; export SUPABASE_SECRET_KEY
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

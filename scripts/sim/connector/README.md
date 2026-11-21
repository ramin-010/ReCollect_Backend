# The connector simulation (MCP_MEMORY_PLAN stage 5)

Measures J1 to J4 with the real claude.ai and ChatGPT against the version built in stages 1 to 4: what the assistant
passes on, what it leaves out, whether it links progress to the right thing, whether it marks an inference, whether it
reads the brief first, and whether it finds a memory worded differently. **The live hour is the owner's** (their yes,
their claude.ai and ChatGPT, new chats only, their own Recollect connector off in those chats).

## Ready (stage 5 preparation, 11-19)
- `chats.json`: the labelled chats, written before any run (an invented person; invented data only).
- `setup-db.ts`: the simulation's own small database `recollect_connector_sim` on the dev Postgres, migrated and seeded
  with the person and what is planted (done once: `planted.local.json` holds the planted ids).
- `grade.ts`: `mark` each chat's start and end while running; `report` grades from the remote door's trace.
- The remote door's trace: the backend writes each tool call to `MCP_TRACE_FILE` when that is set (development only).
- `hour.ps1`: starts and stops everything the hour needs (below). `signin-check.cjs`: the sign-in, checked end to end.

## How the sign-in works here (the gap found 11-19 morning, fixed the same day)
The connector's sign-in goes from the test backend's `/oauth/authorize` to the app's consent page at `FRONTEND_URL`,
and the consent and login pages call the API at the frontend's `NEXT_PUBLIC_BACKEND_URL`. The everyday frontend on
3005 talks to the dev backend (the dev database), where the test person does not exist. So the hour runs **a second
frontend on 3015** (the app's own pages, from the same `recollect/` folder) that talks to the test backend on 8012:
- `recollect/next.config.ts` reads `NEXT_DIST_DIR` (unset: `.next`, as before), because Next locks the folder a dev
  server builds into; the second one builds into `recollect/.next/sim`.
- Next rewrites `tsconfig.json`'s include list and `next-env.d.ts` when a dev server with another folder starts;
  `hour.ps1` keeps both first and puts them back once it is ready, and again at `-Stop`.
- The test backend: `FRONTEND_URL` and `ALLOWED_ORIGINS` = `http://localhost:3015`; `RECOLLECT_SELF_URL` = the
  tunnel's https address (the OAuth discovery names it); `OAUTH_CIMD_HOSTS=claude.ai,chatgpt.com` (**comma-separated**:
  the server splits on commas, so a space-separated list matches neither host).
- **The sign-in must happen in a browser on this laptop:** the consent page is at `localhost:3015`, which only this
  laptop reaches. claude.ai's and ChatGPT's servers reach the backend through the tunnel; only the person's browser
  visits the consent page.
- Checked 11-19 with `signin-check.cjs` (no tunnel): authorize → the consent page on 3015 → Tara's login → Allow → a
  code → a token → `/mcp` lists the web door's 29 tools and `get_brief` answers with the planted thread and question;
  the pages called only 3015 and 8012.

## The owner's hour
1. The tunnel tool: a Cloudflare quick tunnel (`cloudflared`, no account; a new random `https://….trycloudflare.com`
   address each start). Pin a release at least two weeks old; the owner OKs the download first (their hotspot).
2. Start everything (PowerShell, `backend/`):
   `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\sim\connector\hour.ps1 -Start -Cloudflared <cloudflared.exe>`
   It starts, hidden: the tunnel (its address read from its log), the test backend on 8012 (database
   `recollect_connector_sim`; live editing on 1244; the trace on; signup closed; email delivery off; the AI off for
   every account, since the record needs none), then the sign-in frontend on 3015. `-Status` shows them and the address.
   Check: `curl <tunnel>/.well-known/oauth-protected-resource/mcp` names `<tunnel>/mcp`.
3. In claude.ai and ChatGPT (a browser on this laptop): add a custom connector to `<tunnel>/mcp`, sign in as the
   simulation person (`tara.connector-sim@recollect.local` / `connectorsim123`, invented; the consent page), set its
   tools to Always allow. New chats only; the owner's own Recollect connector off in them.
4. For each chat of `chats.json` (both hosts): `grade.ts mark <chatId> start <host>`, send the messages in order (a
   `nextDay` one the next day, in the same chat), then `grade.ts mark <chatId> end <host> <confirmation prompts seen>`
   (for `c1-instructions` add `yes` or `no`: did the model quote our instructions?).
5. `hour.ps1 -Report` (grade.ts report on the trace, against the simulation database): k of n per host, the misses
   quoted. At most two rounds of wording changes (WEB_INSTRUCTIONS, the remember and update_memory descriptions; rebuild
   `mcp/dist-next`, then `-Stop` and `-Start` again: the tunnel's address changes, so the connectors are added again),
   the same chats after each.
6. Afterwards: `hour.ps1 -Stop` (the tunnel, the test backend and the sign-in frontend; the two files put back; the
   build folder removed); every confirmed miss becomes a permanent case (a scripted test where code can hold it, a line
   in the wording notes where a model must).

## Stage 15 (ECOSYSTEM_V2_PLAN, before the trial; prepared 11-20 night)
- The database is migrated to the newest schema (60 migrations, `trial_prep`, `today_words`, `buddy_outcome` included).
- `chats-trial.json`: the labelled chats (two results in one message, a work-log spot check, Docs worth keeping or not,
  their own word, the same note asked in both apps, the same fact told to both apps) and the `after` checks (claude.ai's
  7 memory cases with `chats-rerun.json` + `setup-fresh.ts`; the both-apps fact after a night; Ask AI on the work person).
- `setup-trial.ts`: the people (rounds `chatgpt`, `claude`, `both`), each with their own note "Sliding window" and, for
  the work rounds, yesterday's open line ("The nightly backup job fails…") that t3 closes; ids in `planted-trial.local.json`.
- During the runs: each chat's window in `windows-trial.local.json` (as stage 12), plus by hand what each reply offered
  (`offers`: `named` when it named the note and the section, else `vague`) and a second offer after a "no" (`secondOffer`).
  The runner answers an offer only as the label says (`reply`), and sends `say` whatever the model did.
- `grade-trial.ts`: the work lines per window, the notes written (append_to_doc in the trace) and where each note sits
  in the doc at the end; the set totals against the plan's marks; `trial-report.local.md`.

## Learned in the first hour (11-19; results in MCP_MEMORY_PLAN §11, stage 5)
- **Run the chats in a browser the builder drives** (the Playwright Chrome window, its own profile): the owner logs in
  to claude.ai and ChatGPT there once; the builder adds the connectors, signs in as the test person and sends the
  chats. Windows are captured inside each run (`from`/`to` per chat) and written to `windows.local.json`; one host
  label per round (`claude`, `claude-loaded`, `chatgpt`, `claude-r1`, …), never two rounds at the same time.
- **ChatGPT:** a custom server is Plugins → Add → "Add custom MCP server" (OAuth), then the plugin's Permissions →
  "Allow all tools"; in each chat it is picked from "+" ("Recollect test"). **Turn the owner's ChatGPT memory off for
  the hour first** ("Reference saved memories" and "Reference chat history"): a chat without the plugin saved a test
  sentence into his real ChatGPT memory. A temporary chat is no way round it: "personalized" ones read his memory,
  "unpersonalized" ones drop plugins.
- **claude.ai:** Customize → Connectors → Add → "Add custom connector"; tool permissions "Always allow" per group.
  Its address can't be edited: a new tunnel address means Remove and add again (both hosts). Its "Tool access"
  setting ("Load tools when needed" by default, or "Tools already loaded") changes what the model sees: put it back.
- **A quick tunnel dies with the network** (the hotspot dropped once): the address is gone for good; `-Stop`, `-Start`
  and re-add both connectors. After a wording change, `-RestartBackend` keeps the address.
- **The grader:** rounds are cumulative (no reset: the hosts' sign-ins live in the database), so a link to a planted
  memory counts for any newer version of it; find-again tries every `recall_memory` call of the chat ("on the first
  query" is the server's search alone) and is "n/a" when the target was never saved; it re-runs the queries at report
  time (the trace keeps the calls, not their answers).
- **The fresh-examples test (11-19 afternoon):** `chats-fresh.json` + `setup-fresh.ts` make one invented person per
  round (planted the same), so rounds don't feed each other. **Log out on `localhost:3015` before each sign-in**
  (`POST localhost:8012/api/logout` from a 3015 page): the sign-in page reuses a logged-in person and the connector
  silently signs in as them. Switching ChatGPT's person = Delete app, add it again, then "Allow all tools".
  `trace-since.cjs <from>` prints each call with the record's answer; `simq.cjs <file.sql>` reads the sim database.
  The runners live in `.playwright-mcp/fresh/` (the Playwright tool reads files only under the repo): ChatGPT's
  composer is `div[contenteditable][aria-label="Ask ChatGPT"]`, a reply is done when no "Stop" button shows, the plugin
  is picked from "Add files and more" (keep the chip: type with `insertText`, not `fill`); claude.ai unloads old
  messages, so wait on `[data-is-streaming]`, not on a message count.
- **What the buddy does later (MCP_MEMORY_PLAN §12.5):** `scripts/sim/connector-after.ts` replays a round's recorded
  calls (the trace keeps each answer) into a fresh person in its own test database, then moves the clock: the
  zero-credit view on D1, the AI back on D1's evening, nights on D2, D4 and D8. Labels T1-T8 per sentence set (its
  `LABELS`); about $0.11 a run; `--dry` (no model), `--regrade` (no database). For a new sentence set: its labels
  first, then `--windows`, `--planted`, `--chats`.
- **Cleanup:** delete the test chats by their creation times during the runs (claude.ai's
  `/api/organizations/{org}/chat_conversations`, ChatGPT's `/backend-api/conversations` with the session's token,
  both inside the page; only in-window times, filtered in the page so no other title is read), keep any chat the owner
  made in between, remove both connectors, put claude.ai's Tool access back, and remind the owner to turn ChatGPT's
  memory back on.

# Mirror - Roadmap

Repo: https://github.com/anoopbhat44/mirror (public, MIT)

A live, nicely-styled HTML mirror of your coding-agent session. You keep chatting in the
terminal; Mirror prints a link, and that link shows the conversation as an evolving, readable
document instead of scrollback. No paid API calls. It renders the transcript your agent
already writes, so it rides on your existing Claude Code subscription. (Codex and other agents
are a later adapter, see v2.)

**Status (2026-06-05):** v1 is shipped. v2 (the local workspace: multi-session, search,
incremental rendering, config) is **merged to `main`** (PR #1). A second batch of v2 polish is
implemented on branch `v2-polish` (**PR #2**): tool-call grouping, image rendering (pasted +
screenshot tool results), copy-code and long-output show-more, mermaid diagram rendering with a
UI toggle, and a `/mirror` slash command. Remaining v2 polish and the SQLite decision are below.

---

## Guiding principles

These constrain every version. When a feature violates one, it does not ship.

1. **No paid API calls.** Mirror never calls an LLM API itself. Rendering is local code over the
   transcript the agent already produces. Any model output (e.g. structured artifacts) comes
   from the user's existing subscription session, never a separate billed key.
2. **Local-first, privacy-first.** Transcripts contain secrets, file contents, and tool output.
   The server binds to `127.0.0.1` only. Nothing leaves the machine until the user explicitly
   publishes, and publishing is snapshot-based and redactable, never a raw live leak.
3. **Low install friction.** Clone and go. Minimal or zero runtime dependencies. Prefer a single
   self-contained script over a package tree.
4. **Open core.** The local engine is free and open source forever (drives adoption). The paid
   layer is hosted convenience: public sharing, team workspaces, storage, custom domains.
5. **Tool-agnostic core, thin adapters.** The renderer speaks one internal conversation format.
   Each agent (Claude Code, Codex, others) gets a small adapter that maps its transcript into
   that format. The core does not care which tool produced the session.
6. **Dumb server, smart client.** The server watches files and serves structured JSON plus a
   live-update stream. The browser client renders. This separation is what makes artifacts,
   sharing, and multi-tool support cheap to add later.
7. **Transcripts are the source of truth.** Any database, cache, or index Mirror builds is
   derived and rebuildable from the JSONL the agent writes. Delete it, re-ingest, lose nothing.
   Never make Mirror's own store authoritative. (See the SQLite decision below.)
8. **Incremental over rebuild.** As sessions get long, do not re-parse the whole transcript or
   rebuild the whole DOM on every turn. Append new content; preserve what the user expanded and
   where they scrolled.

---

## Architecture (the spine across all versions)

```
agent session (Claude Code / Codex)
        |
        v  writes transcript JSONL (free, no tokens)
   [ adapter ]  parses transcript -> internal conversation model
        |
        v
   [ local server ]  127.0.0.1:<port>
     - serves conversation JSON
     - serves static client assets
     - SSE/websocket: pushes "updated" when the transcript changes
        |
        v
   [ browser client ]  renders markdown, code, tool calls, artifacts
     - listens for updates, re-renders, preserves scroll
```

- **Trigger:** a `Stop` hook (fires after each turn) hands the server the `transcript_path`. The
  server watches that file's mtime and pushes an update on change. A `SessionStart` hook starts
  the server if not already running and surfaces the link.
- **The link:** server binds a stable port (per project or per session), prints
  `Live view: http://localhost:<port>` to the terminal.
- **Why this is free:** the hook scripts and renderer are plain code. The only thing that costs
  subscription tokens is the normal conversation you were already having.

---

## v1 - Local live view (SHIPPED, free, open source)

**Goal:** terminal stays exactly as it is, plus a localhost link that shows the conversation as a
clean, live-updating document. Done.

**What shipped**
- Claude Code plugin (`.claude-plugin/plugin.json`) with inline `SessionStart` + `Stop` hooks.
  SessionStart boots a server (reusing a running one) and prints the link via `systemMessage`.
- Python standard-library server bound to `127.0.0.1`: `/api/conversation` (JSON), `/events`
  (SSE live-reload), `/healthz`. No pip, no npm.
- Transcript parser tuned to the real on-disk format: groups streamed assistant blocks by
  `message.id`, folds `tool_result` onto the originating `tool_use`, skips sidechain/meta noise,
  drops empty (redacted) thinking. Caps oversized blocks. Built test-first.
- Client: marked + highlight.js (vendored, offline), collapsible thinking and tool calls,
  dark-first theme with a persisted light toggle (no flash), 1080px column with prose capped at a
  readable measure while code, tables, and ASCII diagrams break out full width, zebra +
  horizontal-scroll tables, one-line tool hints, jump-to-latest, SSE live reload with scroll-stick.
- 21 tests (parser TDD + server smoke). README, MIT license, landing page (`docs/`), this roadmap.
- Verified: the real plugin smoke test passed (renders and updates turn by turn in a live
  session); dark and light both confirmed in-browser.

**Known limitations carried into v2** (these become v2 work items)
- Full re-render on every update. It collapses tool calls you had expanded and will not scale to
  very long sessions. Needs incremental rendering (principle 8).
- Single session only. No way to view or switch between other sessions.
- No search. No config or slash commands. Images and non-text tool results are not rendered yet.

**Open verification debt:** confirm the inline-`plugin.json` hook form is honored across Claude
Code versions; keep a `hooks/hooks.json` fallback ready if not.

---

## v2 - The local workspace (MERGED + polish in PR #2, free, open source)

**Status (2026-06-05): v2 merged to `main` (PR #1)**, browser-verified against 79 real sessions.
Landed in PR #1: SQLite derived index (FTS5 + LIKE fallback, incremental ingest), endpoints
`/api/sessions`, `/api/conversation?session=`, `/api/search`, `/api/config`; two-pane client with
a session sidebar (grouped by project, live markers), cross-session search with highlighted
snippets and jump-to-match, incremental append-only rendering (preserves expanded tools + scroll),
`~/.mirror/config.json` (theme/port/auto_open), responsive mobile sidebar, beginner landing page.

**Polish landed in PR #2 (branch `v2-polish`, 42 tests passing, browser-verified):** tool-call
grouping for tool-heavy turns; image rendering (pasted user images + screenshot/tool-result
images); copy-code buttons + long-output show-more; mermaid diagram rendering (vendored, offline,
lazy-loaded) with a top-bar Diagrams toggle plus a per-block Source/Diagram switch; a `/mirror`
slash command that prints and opens the live-view link; a filter menu to hide thinking and/or
tool-call blocks (persisted); a Resume button that copies `claude --resume <id>` for the viewed
session. A "Try these" recipes section on the landing page shows how to trigger each feature.
**Remaining v2 polish (future PRs):** optional PDF/Markdown export; accessibility pass;
per-session (hover) resume in the sidebar; anchored headings.

**Goal:** make the free local tool one you live in. Refine the reading experience, view every
session instead of only the active one, search across them, and give the plugin real options.
Still localhost-only, still no API cost. This is the phase that makes Mirror indispensable before
anything is ever charged for (v3).

### a. Continuous UI refinement (ships in small increments, ongoing)
- **Incremental rendering (priority).** Append new turns instead of rebuilding the whole DOM each
  update. Preserve which tool calls and thinking blocks the user expanded and their scroll
  position. This is a correctness fix (today an update collapses what you opened) and a scale fix
  (long sessions). Pairs with incremental server ingest below.
- **Tool-heavy density.** (done, PR #2) Runs of 2+ consecutive tool calls group under a
  "N tool calls" header with an expand/collapse-all control. Single calls render as before.
- **Render images.** (done, PR #2) User-pasted images and screenshot/tool-result images render
  inline; oversized images degrade to a placeholder rather than bloating the payload.
- **Long output.** (done, PR #2) Tall code/result blocks clamp behind a "Show more" toggle; every
  code block has a hover Copy button. Mermaid diagrams render (toggleable). Anchored headings TODO.
- **Find and filter.** (filters done, PR #2) A top-bar filter menu hides thinking and/or
  tool-call blocks (persisted). Still TODO: in-page find across collapsed messages, a density switch.
- **Polish.** Accessibility (focus, ARIA, reduced motion), keyboard nav, a long-session
  jump-to-turn / minimap. Optional local export of a session to PDF or Markdown.

### b. Multiple Claude Code sessions
- The one shared server tracks **every** session, not a single active pointer. Each session's
  hooks register its transcript; the server also discovers past sessions by scanning
  `~/.claude/projects`.
- Endpoints: list sessions (project, recency, title, message count, live flag), fetch one by id,
  per-session update notifications.
- UI: a session switcher / sidebar grouped by project, sorted by recency, a live dot on the
  active one. Click to read any session; the active session highlights.
- This generalizes later: the same registry can index Codex / Cursor / Aider transcripts through
  thin adapters, so Mirror becomes the one place to read any agent session (principle 5).

### c. Search
- **In-session find first** (client-side, instant).
- **Cross-session search next** (the "did we solve this before" feature). This is what motivates
  the SQLite / FTS5 decision in the next section.

### d. Resume and view state
- Remember the last session you were viewing, your scroll, and which disclosures were open
  (browser `localStorage`, no server state).
- (done, PR #2) A Resume button in the top bar copies `claude --resume <id>` for the viewed
  session; Mirror shows it, Claude Code runs it. Future: a per-session (hover) resume in the sidebar.

### e. Skill options (plugin config + commands)
- A config file (`~/.mirror/config.*`): port, bind address, default theme, auto-open browser,
  include or exclude thinking and tool output, redaction on/off, per-project enable/disable.
- Slash commands shipped by the plugin: `/mirror` (done, PR #2) prints and opens the live-view
  link. Future: list and switch sessions, show status, stop the server, toggle what is mirrored.

**Done when:** you can open Mirror, see all your sessions, switch between them, search across them,
resume where you were reading, and configure behavior, all locally and free, and a long
tool-heavy session stays fast and keeps your expanded sections open across updates.

---

## Data and persistence: do we need SQLite?

A standalone decision because it was asked directly. Short answer: **yes, but only in v2, only for
cross-session search and incremental ingest, behind a graceful fallback, and only ever as a
derived index** (principle 7).

**What does not need a database:**
- *Session list* (which sessions exist, recency, project, title): a scan of `~/.claude/projects`
  plus a small JSON registry of hook registrations.
- *View resume* (current session, scroll, open disclosures): browser `localStorage`.
- *Resuming the actual agent*: that is Claude Code's own `claude --resume <id>`. Mirror surfaces
  the command and stores nothing.

**Where SQLite earns its place** (and note `sqlite3` is in the Python standard library, so this
does not break the zero-dependency principle):
- *Cross-session full-text search at scale.* FTS5 gives fast search over thousands of messages.
  This is the real trigger.
- *Incremental ingest.* Track a byte offset per session and append only new lines into the index,
  so big transcripts are not re-parsed on every update. This also retires the v1 full-reparse cost.

**Rules if/when adopted:**
- The DB is a **derived, rebuildable cache/index** over the JSONL, never authoritative. Delete it
  and re-ingest at any time.
- FTS5 is absent in some minimal SQLite builds. Detect at startup; fall back to an in-memory scan
  so search degrades, not breaks.
- Keep the schema tiny and regenerable: `sessions(id, path, project, mtime, byte_offset, title)`,
  `messages(session_id, idx, role, text, ts)`, and an FTS5 virtual table over message text.

**Decision:** introduce SQLite in v2 to power cross-session search and incremental ingest only.
Do not use it for primary storage or anything the transcript already records.

---

## v3 - Artifacts and public sharing (commercial)

**Goal:** richer output than raw chat, and the ability to share a conversation or artifact at a
public link. This is the first version worth paying for, and it builds on a workspace people
already use daily (v2). Open-core line: the local engine and the artifact renderer stay open
source; hosted sharing is the paid service.

### Structured artifacts
- A documented block protocol the model emits inside its normal (subscription) output, for
  example a fenced `artifact` block with a type and JSON payload, or an MCP tool the model calls.
- A plugin skill / instructions teach the model the format. Still zero API spend; it uses the
  session you already pay for.
- Practical artifact types people actually want: tables, charts (bar / line / pie), mermaid
  diagrams, code diffs, callout cards, checklists, image galleries, math. (Basic mermaid rendering
  already shipped in v2 for fenced ```mermaid blocks; v3 extends it to model-emitted artifact
  blocks with a documented protocol.)
- **Sandboxing:** once the page can render model-generated HTML/JS, isolate it. Start with an
  `iframe sandbox` (no same-origin, no top navigation). Only reach for a heavier sandbox
  (container / microVM such as smolvm) if you ever execute artifact code server-side. For
  client-rendered artifacts, the iframe is enough.

### Public sharing
- "Publish" takes a **snapshot** (or a single artifact), not the raw live session by default.
- **Redaction first:** secret scanning before publish, an allowlist of what gets shared, options
  to strip tool outputs and thinking. This must be solid before charging, since a leaked key in a
  public share is a reputational failure.
- Two paths:
  - DIY: self-host plus a tunnel (`cloudflared` / `ngrok`) for users who want zero dependence.
  - Hosted (the paid part): a relay that stores the snapshot and returns `share.mirror.app/<id>`,
    with link expiry, password protection, and optional live-share (stream updates to viewers).

**Monetization (open core)**
- Free: the entire local workspace (v1 + v2) plus a small number of public snapshots per month.
- Pro (monthly): unlimited shares, custom domain, password and expiry, premium themes and
  artifact types, live-share.

**Done when:** a user can turn a session into a clean shareable page in one action, with secrets
scrubbed, and pay for hosted sharing without ever touching an API key.

---

## v4 - Team and interactive (vision, further out)

Still grounded in real demand, but bigger bets. Each needs validation, not faith.

- **Team workspaces:** org accounts, shared library, roles and permissions, SSO, retention
  policies, audit log. The enterprise tier.
- **Usage analytics:** cost and token trends, which tools and agents, where sessions fail. Teams
  managing agent spend will want this dashboard.
- **Templates and playbooks:** turn a strong conversation into a reusable, parameterized prompt
  others can run.
- **Interactive control (the big one):** the web view becomes an input surface. Approve tool
  calls, answer the agent's questions, send follow-ups from the browser or phone. "Drive your
  agent from the shared link." Real demand exists for remote approvals and mobile control, and it
  is the strongest moat here. Also the hardest to do safely; it crosses from viewer to controller,
  so security and auth must be mature first.
- **Knowledge base over your sessions:** ask questions across your whole agent history. Ties into
  v2's cross-session search. Only worth it once there is a real corpus to query.
- **Collaboration:** annotations and comments on a shared conversation, and live co-watch (a
  teammate watches an agent work in real time, for pairing, demos, teaching). The bridge from a
  personal tool to a team product. Co-watch is expensive; gate it on real pull.
- **Integrations:** post a session summary or shareable writeup to a GitHub PR, a Slack channel,
  or CI.

---

## Cross-cutting concerns (every version)

- **Security and privacy:** localhost-only until explicit publish; redaction before any share;
  bind and auth correctly the moment anything leaves the machine.
- **Performance:** large transcripts must not freeze the page. Incremental rendering and ingest
  (principle 8), bounded/virtualized history, parse-once caching.
- **Cross-platform:** macOS and Linux from v1.
- **Adapter resilience:** transcript formats and hook APIs will change. Keep the adapter layer
  thin and versioned so a format change does not break the core.
- **Derived state only:** any index or cache (see the SQLite decision) is rebuildable from the
  transcripts and safe to delete.

---

## Honest risks

- **Anthropic ships a native web view.** They already have a web app. Differentiation must be the
  multi-session workspace, cross-session search, tool-agnostic support, sharing, and team
  features, not "pretty viewer" alone.
- **Hook / transcript instability.** Mitigate with a thin, versioned adapter layer.
- **Secret leakage in public shares.** The single most damaging failure mode. Redaction must be
  proven before v3 charges anyone.
- **Premature persistence / over-engineering.** The pull to add a database, accounts, or sync
  before they are needed. Stay file-first; add SQLite only at the trigger defined above; keep it
  derived. v2 should feel lighter than its feature list, not heavier.
- **Scope creep in v3 and v4.** The free local workspace is the wedge. Do not let sharing,
  artifacts, or team features starve the thing that earns daily use.

---

## Sequence summary

| Version | Theme | Status | Cost to user | Open / paid |
|---|---|---|---|---|
| v1 | Local live view | Shipped | Free | Open source |
| v2 | Local workspace: multi-session, search, incremental render, config | Merged (PR #1); polish in PR #2 | Free | Open source |
| v3 | Artifacts + public sharing | Planned | Free local, paid hosting | Open core |
| v4 | Team, analytics, collaboration, interactive control | Vision | Paid (enterprise) | Open core + hosted |

SQLite enters in v2 as a derived search/index cache only (see the persistence decision). It is
not a new dependency (`sqlite3` is stdlib) and never holds anything the transcripts do not.

# TODO

Plan from the 2026-09-23 ergonomics review: sessions that continue, output that is quiet by default, and bo's own
config/state directories. The previous plan (hermeticity, usage, errors, unified knobs, messages) is implemented.
Pre-GA: no compatibility shims, no aliases, no deprecation paths; update `README.md`, tests, and goldens with every
shape change.

Principles: one mechanism per concept, the same in every mode (CLI, TypeScript client, HTTP, A2A). Explicit beats
magic. stdout is the answer and nothing else. Engine differences never reach the caller.

---

## Evidence (verified 2026-09-23, Claude Code 2.1.280, codex-cli 0.155.1)

| Question | Claude Code | Codex | Consequence for bo |
|---|---|---|---|
| Continue | `-c`: "most recent conversation in the current directory"; `-r <id>` | `resume --last`, filtered by cwd (`--all` lifts it); `fork --last` | continue is **explicit** and **per directory**; fork is a variant of continue |
| Non-interactive stdout | `claude -p`: the answer only; stderr silent | `codex exec`: the answer only; stderr: header, transcript, token count | stdout = answer is universal; quiet stderr by default matches `claude -p` |
| Streaming in non-interactive mode | no (printed at the end) | no (printed at the end) | bo streaming the answer into a terminal is an improvement, not a convention to match |
| Is an agent message the final answer? | known only after the fact (a text block no tool call follows) | `agentMessage.phase` = `commentary` / `final_answer`, present at `item/started` (checked live) | the CLI cannot decide "answer vs commentary" while streaming; it streams all top-level agent text on a terminal and prints `Run.result` when piped |
| Where bo's sessions live | the operator's `~/.claude/projects/<dir>/` (426 bo test dirs there today), mixed with the operator's own sessions | bo's `CODEX_HOME` only | native listing would mix in the operator's Claude sessions for one engine and not the other → bo keeps its own index |
| Auto-memory | **on in bo runs**: `~/.claude/projects/<dir>/memory/` is created and read (`autoMemoryEnabled` defaults on) | `features.memories` defaults off | hermeticity leak and an engine difference → turn it off (1.1) |
| Config / state layout | `~/.claude` (config and state mixed) | `~/.codex` (config.toml and state mixed) | follow XDG like `gh`: config in `$XDG_CONFIG_HOME/bo`, state in `$XDG_STATE_HOME/bo` (already used for the Codex home) |

---

## Wave 1 — Hermeticity

### 1.1 Claude auto-memory off
`claude/index.ts` options: `settings: { disableBundledSkills: true, autoMemoryEnabled: false }`. Test asserts it.
README "Engine mapping": memory row (Claude off by setting, Codex off by default).

---

## Wave 2 — Sessions are a durable resource

Ontology: a **run** is one execution (in memory, kept 10 minutes after it ends). A **session** is a conversation:
one engine, one workspace, many runs, durable across server restarts. The engines keep the conversation itself;
bo keeps an index.

### 2.1 Session index (server)
- `src/core/sessions.ts`: `SessionIndex` over `$XDG_STATE_HOME/bo/sessions.json` (mode 0600; atomic write by
  rename; loaded at start). Record:
  `{ id, engine, workspace, title, context?, created_at, updated_at, runs }`, where `title` is the first line of the
  first run's first text part (≤ 80 chars) and `context` is the A2A context id when the session began there.
- Written by `RunManager` when a run reports its session (`io.session`) and when it finishes (`updated_at`, `runs`).
  At most 50 sessions per workspace (oldest dropped from the index; the engine's own history is untouched).
- The index is optional input: an explicit `session.id` never needs it (ids stay self-describing).

### 2.2 `session.latest` in `RunSpec`
`session?: { id: string; fork?: boolean } | { latest: true; fork?: boolean }`: `latest` resolves to the newest
indexed session for this workspace root (exact resolved path), restricted to `engine` when given. No session →
`422 invalid_spec` at `/session/latest` "no earlier session in <root>". The resolved `Run.session_id` shows which.
Busy → the existing `session_busy`.

### 2.3 `GET /v1/sessions?workspace=<abs path>`
Newest first, the index records for that workspace (all workspaces when omitted). Client: `bo.sessions.list(workspace?)`.

### 2.4 A2A uses the index
A context is one more key: `start()` continues `latest` for `context` (not the in-memory `ContextState`). Delete
`ContextState.latestSession`; keep only `runContext` for run→context projection.

### 2.5 CLI
- `bo run -c` / `--continue` → `session: { latest: true }`; `-c --fork` → `{ latest: true, fork: true }`.
  `--session <id>` stays for older sessions. `-c` and `--session` together is a usage error.
- `bo sessions`: this directory's sessions (title, engine, model, runs, last used, id); `--all` for every workspace.
- Default stays "new session": continuing is always explicit (scripts stay deterministic, context and cost never grow
  by surprise).

Tests: index round-trip, cap, atomic write; `latest` with/without engine, none, busy, fork; restart keeps
continuation (new `RunManager` over the same file); A2A continuation after restart; CLI `-c` and `bo sessions`.

---

## Wave 3 — Quiet by default

| Mode | stdout | stderr |
|---|---|---|
| default, terminal | the agent's top-level words, streamed | a transient status line (`⠋ $ npm test · 42s`), erased at the end; approval prompts; on failure one `✗` line + hint; if anything was denied, one line `2 actions were denied (-v shows them)` |
| default, piped | `Run.result` once at the end | only failures and the denied-actions line |
| `-v` | same | today's step lines, summary line (model, time, tokens, cost), `continue: bo run -c` |
| `-vv` | same | plus reasoning, tool output excerpts, subagent messages, run and session ids |
| `--json` | NDJSON events | nothing |

- `RunView` takes a `verbosity: 0 | 1 | 2`; the status line is a small `StatusLine` (TTY only): erased before any
  write to either stream, redrawn only when both streams are at a line start, truncated to the terminal width.
- `bo serve -v` logs each run's steps too (same meaning of `-v`: more of what happened).

Tests: golden text per verbosity (plain style); status line never appears off a terminal; denied summary.

---

## Wave 4 — bo's config file

`$XDG_CONFIG_HOME/bo/config.toml` (default `~/.config/bo/config.toml`), only settings people set once:
```toml
[run]      # defaults for `bo run`
engine = "codex"
effort = "high"
access = "write"
verbose = 1

[serve]    # defaults for `bo serve`
port = 3000
max_runs = 8
allow_subscription_auth = true
```
- Precedence: flag > environment > config file > built-in default. Secrets (`BO_TOKEN`) are not read from the file.
- `bo config` prints every effective setting with its source (`flag`, `env BO_…`, `config.toml`, `default`).
- Unknown keys are an error naming the file and key.

---

## Done criteria
- `npm test` green; `tsc --noEmit` clean.
- Live: `-c` continues on both engines, including after a server restart.
- Reset this file to "No open implementation items." once merged.

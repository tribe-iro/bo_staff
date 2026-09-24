# TODO

Implementation plan (2026-09-23). Each wave leaves `npm test` and `tsc --noEmit` green and updates `README.md` and
tests in the same change. Pre-GA: no compatibility shims, aliases, or deprecation paths.

Conventions: `runs.ts` = `src/core/runs.ts`, `sessions.ts` = `src/core/sessions.ts`, `claude/` =
`src/harness/claude-code/`, `codex/` = `src/harness/codex/`, `port.ts` = `src/harness/port.ts`.

Facts this plan relies on (verified live 2026-09-23, Claude Code 2.1.280 / SDK 0.3.280, codex-cli 0.155.1):
- F1. Claude `result.modelUsage` / `total_cost_usd` are cumulative for the session; a resumed or forked session starts
  from its saved totals (SDK docs). Codex `thread/tokenUsage/updated` carries `total` (thread) and `last` (this call).
- F2. Claude streams `stream_event` for the main agent only: a run that delegated an edit emitted 2 main
  `message_start` and 0 subagent ones. A foreground subagent's `tool_use_result` (`AgentOutput`) has
  `totalTokens` and `usage`; a background one ends with `system/task_notification.usage.total_tokens`.
- F3. Claude `Edit`/`Write` results (`tool_use_result`) carry `structuredPatch: {oldStart, oldLines, newStart, newLines,
  lines[]}[]` and `type: "create" | "update"` (Write), `originalFile`. A subagent's tool results are not forwarded.
- F4. Codex `fileChange.changes[].diff`: `update` → unified hunks without file headers (`@@ -1,3 +1,3 @@\n one\n-two…`);
  `add` → the new file's raw content (`"hi\n"`), not a diff.
- F5. Claude cannot stream a command's output (only `tool_progress` heartbeats); Codex can
  (`item/commandExecution/outputDelta`). Live shell output is therefore not part of the contract (engine parity).

---

## Wave 1 — Usage is per run; sessions carry totals

Users read a run's usage as "what this run cost". Today it is the session total. Make it this run, exact on both engines,
and give sessions their own totals.

### 1.1 Shapes
- `model.ts`: `Usage` doc: "tokens of the model calls this run made, subagents included; `cost_usd` when the engine
  reports cost". `Session` gains `usage: Usage` (sum of its runs' usage, as seen by bo).
- `port.ts`: `Outcome` gains `totals?: Usage` — the engine's own cumulative session totals after the run (Claude only;
  used as the next run's baseline). `ResolvedSpec.session` gains `totals?: Usage` (the baseline for this run).
- `sessions.ts` entry: internal `engineTotals?: Usage` (never public); public `usage: Usage` (start at zero).
  `SessionNote` gains `usage?: Usage` (added when `ended`) and `totals?: Usage` (replaces `engineTotals`).
  `SessionLookup` gains `totals(id: string): Usage | undefined`.

### 1.2 Claude (`claude/translate.ts`, `claude/index.ts`)
- `usageOf(last)` stays the cumulative reading (`cumulative`). `outcome()` returns
  `usage = minus(cumulative, spec.session?.totals)` and `totals = cumulative`, where `minus` subtracts field by field and
  falls back to `cumulative` when any field of the baseline exceeds it (engine totals were reset). `cost_usd` likewise.
- Limits see subagent tokens (F2): on a `user` message whose `tool_result` answers an `Agent`/`Task` tool use and whose
  `tool_use_result.totalTokens` is a number → op `call {tokens: totalTokens, main: false}`; on `task_notification` with
  `usage.total_tokens` → the same. (Main calls keep coming from the stream.)
- `createTranslator(spec)` takes `Pick<ResolvedSpec, "schema" | "session">`.

### 1.3 Codex (`codex/translate.ts`)
- Per-run usage is the sum of `last` over every thread of the run (main and subagents): accumulate
  `{input: inputTokens, cached: cachedInputTokens, output: outputTokens}` from each `thread/tokenUsage/updated.last`.
  `total` is no longer read; `outcome().usage` is the sum; no `totals`.
- `protocol.ts`: `TokenUsageUpdated.tokenUsage = { last: TokenUsageBreakdown }` (the field bo reads).

### 1.4 Core
- `runs.ts` `finish`: `noteSession(record, true, final)` passes `usage: run.usage` and `totals: final.totals`.
- `spec.ts` `resolveSpec`: after resolving `session` (id, latest), set `session.totals = sessions?.totals(<bo id>)`. For
  a fork, the parent's totals (Claude forks continue the parent's saved totals, F1).
- `sessions.ts`: `note` adds `usage` into `entry.usage` and replaces `engineTotals` when given.

### 1.5 Presentation and tests
- `render.ts` `sessionsTable`: a `tokens` column (`count(in) in · count(out) out`) and cost when present.
- README: `Run.usage` and `Session.usage` definitions; remove the "totals for the session so far" wording.
- Tests: Claude outcome with and without baseline, reset fallback, subagent `totalTokens` → call op; Codex sum of `last`
  across two threads; index accumulates usage and stores totals; `resolveSpec` passes totals for id/latest/fork;
  sessions table. Regenerate transcript goldens (Codex transcripts recorded before `last` was projected replay to zero
  usage; the next `npm run conformance` re-records them) and review that only `usage` changed.

---

## Wave 2 — Edits carry diffs

### 2.1 Shape
`Action` `edit`: `changes: { path: string; change: "add" | "modify" | "delete"; diff?: string }[]`. `diff` is unified
hunks without file headers; every hunk starts with `@@ -a,b +c,d @@`, or `@@ @@` when line numbers are not known
before the edit (an approval). At most 64 KiB per change: longer diffs are cut after the last whole hunk that fits and
end with the line `\ diff truncated`.

### 2.2 `src/format.ts` (shared, pure)
- `addHunk(content: string): string` (`@@ -0,0 +1,N @@` and `+` lines), `deleteHunk(content)` (`@@ -1,N +0,0 @@`, `-`),
  `replaceHunk(old: string, new: string)` (`@@ @@`, `-`/`+` lines), `patchHunks(structuredPatch)`,
  `capDiff(diff)` (64 KiB rule), `diffStat(diff): {added, removed}`.

### 2.3 Claude
- `toAction`: `Edit` → change `modify` with `diff: replaceHunk(old_string, new_string)`; `MultiEdit` → one change, the
  hunks of every edit concatenated; `Write` → `add` with `diff: addHunk(content)` (the approval shows what will be
  written). Diffs through `capDiff`.
- On the `tool_result` (F3): `Edit`/`MultiEdit`/`Write(update)` → `diff = patchHunks(structuredPatch)`, change `modify`;
  `Write(create)` → `add`, `addHunk(content)`. The completed action item carries the exact diff.
- Subagent edits are not itemized (F3); unchanged.

### 2.4 Codex
- `actionFor(fileChange)`: `update` → `diff` as is; `add` → `addHunk(diff)` (F4); `delete` → `deleteHunk(diff)` (verify
  in the live test that `delete` carries the removed content; if it is a hunk, keep it as is). `capDiff` on all.
  `move_path` is ignored (the change stays `modify` of `path`).
- `item/started` and the approval request use the same mapping, so the approval shows the diff.

### 2.5 Presentation
- `format.summary(edit)`: `edit src/a.ts (+3 −1)` from `diffStat` (all changes summed; `create`/`delete` wording kept).
- `RunView` `-vv`: under the step line, each change's diff (at most 40 lines per change, then `… N more lines`),
  `+` green, `-` red, hunk headers dim. Approval prompt: the diff of the awaiting edit at every verbosity (40-line cap).
- Tests: format helpers (golden strings, truncation, diffStat); Claude `toAction` and tool_result mapping (Edit,
  MultiEdit, Write create/update); Codex add/update/delete; RunView `-v` stat and `-vv` diff; approval prompt diff.
  Live (`http.it.ts`, both engines): "edit a.txt: change two to TWO" → the completed edit item's diff contains `-two`
  and `+TWO`.

---

## Wave 3 — Session history

A session is readable after its runs leave memory (10 minutes): what was asked, what the agent did, what it answered.

### 3.1 Storage (`sessions.ts`)
- One file per session: `$XDG_STATE_HOME/bo/history/<sha256(session id) hex, first 32>.jsonl`, mode 0600.
- One line per finished run: `{ "run": Run, "items": Item[] }` — the terminal `Run` and the final state of each item in
  first-seen order (deltas are not stored).
- `SessionIndex.append(id, record)` writes it (serialized with the index writes); at most 8 MiB per file: when an append
  exceeds it, the file is rewritten without its oldest runs (the newest run is always kept).
- An evicted session (index caps) and `DELETE` remove the file. The in-memory index keeps history in a `Map`.
- `runs.ts` `finish`: when the run has a session, `sessions.append(run.session_id, { run, items: [...record.items.values()] })`
  (items in insertion order).

### 3.2 API
- `GET /v1/sessions/{id}` → `Session`; `GET /v1/sessions/{id}/runs` → `{ run: Run; items: Item[] }[]`, oldest first;
  `404 session_not_found` (new problem) for an unknown id.
- `DELETE /v1/sessions/{id}` → 204; index entry and history removed; engine history untouched.
- Client: `bo.sessions.get(id)`, `bo.sessions.runs(id)`, `bo.sessions.delete(id)`.

### 3.3 CLI
- `bo show [SESSION_ID] [-v|-vv]`: the given session, else this directory's latest. For each run: `› <first line of
  the prompt>` (dim), then the run rendered by `RunView` from its stored items (answer, and at `-v`/`-vv` steps, diffs,
  summary). `bo sessions --delete <id>`.
- Tests: append/cap/rewrite/delete/evict; API shapes and 404; `bo show` output (plain style) for a two-run session;
  history survives a new `SessionIndex` over the same directory.

---

## Wave 4 — The contract is one schema

Today every public shape is written three times: TypeScript types (`model.ts`), a hand-written validator (`spec.ts`
`Checker`), and prose in the README. Make one source.

### 4.1 Schemas
- Dependency `typebox@^1`.
- `src/contract/schema.ts`: TypeBox schemas for every public shape — `Part`, `McpServer`, `Subagent`, `RunSpec`,
  `MessageBody`, `ResponseBody`, `Run`, `Action`, `Item` (all item bodies), `Question`, `Usage`, `Session`,
  `ModelInfo`, `EngineInfo`, `StreamEvent`, `Problem` — with the limits currently in `spec.ts` (lengths, ranges,
  patterns, counts) and `additionalProperties: false` on requests.
- `model.ts` keeps only `Static<typeof …>` type exports and constants (`ENGINE_IDS`, `ACCESS_LEVELS`, `TERMINAL`, …).

### 4.2 Validation
- `src/contract/validate.ts`: compiles request schemas once with the process Ajv (strict, allErrors) and maps Ajv errors
  to `FieldError`s in bo's wording: `additionalProperties` → `<ptr>/<prop> unknown field`; `required` →
  `<ptr>/<prop> is required`; `type` → `must be a string|an integer|a boolean|an object|an array`;
  `minimum`+`maximum` (from the parent schema) → `must be an integer a–b`; `enum` → `must be one of …`; `pattern` →
  `must match <source>`; `minItems`/`maxItems` → `must have a–b entries`; `minLength` → `must be a non-empty string`.
- `resolveSpec` becomes two steps: (1) schema validation (shape, all errors at once); (2) resolution — filesystem
  (directories, files, SKILL.md, project docs), engines, models/efforts, sessions. `Checker` keeps only step-2 helpers.
  `parseMessage` / `parseResponse` become schema validation plus step 2 for parts.
- Error messages stay byte-identical where tests pin them; update the tests that pin Ajv-only differences.

### 4.3 Published artifacts and conformance
- `scripts/contract.ts` (`npm run contract`): writes `contract/bo.v1.schema.json` (every schema under `$defs`) and
  `contract/openapi.json` (OpenAPI 3.1: every `/v1` path, request bodies, responses, problem responses, the SSE event
  stream as `text/event-stream` of `StreamEvent`).
- `test/contract.test.ts`: the committed artifacts equal a fresh generation; every `Run`, `Item` and `StreamEvent`
  produced by the HTTP test scenarios validates against its schema (the server honours its own contract).
- README: the RunSpec/Run/Item reference is replaced by the schema file and one example per request; the prose keeps
  semantics (defaults, precedence, limits) only. A "Contract" section: `/v1` changes only additively (new optional
  fields, new item types and actions); clients must ignore unknown fields and item types; anything else is `/v2`.

---

## Wave 5 — Latency, measured

### 5.1 `scripts/bench.ts` (`npm run bench [claude-code|codex] [N]`)
- Starts a server in-process with the real harnesses (`sessionsFile: null`); per engine, N (default 5) sequential runs
  of "Reply with exactly: OK" at the lowest effort. Per run: created → session reported, created → first delta,
  created → terminal. Also the startup probe time per engine. Prints p50 and max per metric.
- `core` mode: one scripted run emitting 10 000 items to 32 SSE subscribers; prints events/s and p99 delivery latency.
- README "Performance": the command and the numbers from this machine.

### 5.2 Decision gate
If created → session reported p50 exceeds 1.5 s and is dominated by process start, the next plan evaluates Claude
`startup()` pre-warming and a persistent Codex app-server (per-run process-group isolation must be kept). No
pre-warming in this plan.

---

## Wave 6 — ACP binding (`bo acp`)

ACP v1 (stable; what Zed, CodeCompanion and JetBrains speak) over stdio, via `@agentclientprotocol/sdk@^1.5`
(`AgentSideConnection`; tests use `ClientSideConnection`). `src/acp/agent.ts` implements `Agent` over the TypeScript
client (`Bo`); `bo acp [--url URL] [--token TOKEN]` wires it to stdin/stdout; stdout carries only JSON-RPC.

### 6.1 Prerequisites (public contract)
- `RunSpec.session` gains `{ key: string; fork?: boolean }`: continue the session with this caller-chosen key, or start
  one under it. Keys match `^[A-Za-z0-9._:-]{1,128}$`, unique per workspace. The index stores `key`; `LatestQuery`
  becomes `{ workspace, engine? } | { key }`; `Session.key?: string`. A2A uses `key = "a2a:" + contextId`; the internal
  `context` field and `runs.create(…, { context })` are deleted. `bo run --session` accepts an id (`ses_…`) or a key;
  `GET /v1/sessions/{id}` accepts a key too.
- `Run.error.path` is `/limits/max_turns` or `/limits/max_tokens` for `limit_exceeded`.

### 6.2 `initialize`
`protocolVersion: 1`, `agentInfo {name: "bo", version}`, `authMethods: []`, `agentCapabilities: {loadSession: true,
promptCapabilities: {image: true, embeddedContext: true}, mcpCapabilities: {http: true}, sessionCapabilities: {list,
resume, close, delete, additionalDirectories}, _meta: {steering: {supported: true}, promptQueueing: true}}`.

### 6.3 Sessions
| ACP | bo |
|---|---|
| `session/new {cwd, mcpServers, additionalDirectories}` | key `acp:<uuid>` = `sessionId`; kept in process: cwd, MCP servers, extra roots, config (6.5) |
| `session/load` | `GET /v1/sessions/{key}/runs`, replayed (6.7), then the response |
| `session/resume` | as load without replay; `sessionId` may be a key or a `ses_…` id |
| `session/list {cwd?, cursor?}` | `GET /v1/sessions?workspace=cwd` → `{sessionId: key ?? id, cwd, title, updatedAt}`, 50 per page, cursor = base64 offset |
| `session/close` | cancel the active run; forget in process |
| `session/delete` | `DELETE /v1/sessions/{id}` |
MCP servers: stdio `{name, command, args, env[]}` and http `{name, url, headers[]}` → `RunSpec.mcp`; names normalised to
`[A-Za-z0-9_-]`, arrays to maps.

### 6.4 Prompt turn = one run
- `session/prompt` → one run: `session {key}`, `interactive: true`, workspace `{root: cwd, extra_roots}`, MCP servers,
  config (6.5), `_meta.bo` (6.8); follows its events; resolves only after the terminal run event; no update for a prompt
  after it resolved.
- Content: `text` → text part; `image` → file in the process's private temp dir → image part; `resource` (text) →
  `<context uri="…">…</context>` text part; `resource_link` → `[@name](uri)` text part.
- `stopReason`: completed → `end_turn`; cancelled → `cancelled`; `limit_exceeded` with path `/limits/max_turns` →
  `max_turn_requests`, `/limits/max_tokens` → `max_tokens`. Other failures → JSON-RPC error `-32603` with bo's message
  and hint. Response `usage` (unstable field): `{inputTokens, outputTokens, cachedReadTokens, totalTokens}` from
  `Run.usage` (per run, Wave 1).
- Queueing: a prompt while one runs waits (FIFO). `_session/steering {sessionId, prompt}` → `POST …/messages` and
  `{outcome: "injected"}`, or a new turn and `{outcome: "startedNewTurn"}` when none runs.
- `session/cancel` → cancel the run; queued prompts resolve `cancelled`; the active prompt returns `cancelled` once the
  run is terminal.

### 6.5 Configuration
Options from `GET /v1/engines` and config.toml `[run]` defaults; `set_config_option` returns the full list:
- `model` (category `model`): groups per available engine, value `<engine>/<model id>`; changing engine after the
  session's first run → invalid params ("a session keeps its engine; start a new one").
- `effort` (category `thought_level`): the model's efforts plus `default`; rebuilt when the model changes.
- `mode` (category `mode`): `read` (Read only), `write` (Edit the workspace), `write-internet` (Edit + internet), `full`
  (Full access; omitted when bo runs as root); applied on every run; mirrored as `modes`, `session/set_mode`,
  `current_mode_update`.

### 6.6 Updates
| bo | ACP |
|---|---|
| delta of an agent message | `agent_message_chunk {messageId: item id}`; a completed message without deltas: one chunk |
| `reasoning` | `agent_thought_chunk` |
| `plan` | `plan {entries: {content, status, priority: "medium"}}` |
| `action` first seen | `tool_call {toolCallId: item id, title: summary(action), kind, status, locations, rawInput: action}` |
| `action` later | `tool_call_update {status, content, rawOutput: outcome}` |
| edit diff | `content: {type: "diff", path, oldText, newText}` per change — old = context + removed lines, new = context + added lines of its hunks |
| shell outcome | `content: {type: "content", content: text excerpt}` when the command ends |
| kind | shell `execute`; read `read`; edit `edit` (`delete` when every change deletes); search `search`; web `fetch`; delegate `think`; mcp/skill/other `other` |
| status | awaiting_approval `pending`; running `in_progress`; completed `completed`; failed/denied `failed` |
| subagent items (`parent_id`) | content of the delegate's tool call, never top-level chunks |
| `notice` | `notice` update when the client advertises `session.notices`, else dropped |
| delivered steering message | `user_message_chunk` |

### 6.7 Replay (`session/load`)
For each stored run, oldest first: the prompt as `user_message_chunk`s, then its items through 6.6 in final state
(`tool_call` with the final status; messages as one chunk each).

### 6.8 Approvals, questions, bo-only knobs
- Awaiting action → `session/request_permission` with `allow` (allow_once, "Allow"), `allow-run` (allow_always, "Allow
  for this prompt"), `deny` (reject_once, "Deny"); `cancelled` → deny.
- Question → `elicitation/create` (`form`: a property per question, `enum` of options, array when `multiple`) when the
  client advertises `elicitation.form`; otherwise empty answers.
- `_meta.bo` on `session/new`/`resume`: `instructions`, `project_instructions`, `skills`, `subagents`, `limits`,
  `env`, `timeout_s`, validated by the server (errors name `/_meta/bo/…`).

### 6.9 Tests
- `test/acp.test.ts` (`ClientSideConnection` over in-memory streams, scripted harnesses): initialize; new → prompt →
  chunks/tool calls/plan/diff content → `end_turn`; permissions (each option, cancelled); elicitation (form, none);
  cancel (nothing after); queueing; steering; list/load (replay)/resume (key and `ses_`)/close/delete; config options
  (groups, effort rebuild, engine pinned, modes); `_meta.bo` errors; limits → stop reasons; failures → errors.
- `test/integration/acp.it.ts` (both engines, one-line prompts): real `bo acp` subprocess: prompt → chunks + `end_turn`;
  an approval; load after restarting `bo acp`.

---

## Done criteria
- `npm test` green; `tsc --noEmit` clean; `npm run contract` leaves no diff.
- `BO_ALLOW_SUBSCRIPTION_AUTH=1 npm run test:integration` green on both engines; `npm run bench` numbers in README.
- Reset this file to "No open implementation items." once merged.

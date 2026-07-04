# TODO

All previously tracked waves from this file were implemented on 2026-04-06.

Completed:
- Wave 1: current P0 correctness fixes and shared validation/runtime helpers
- Wave 2: runtime event and execution-domain ownership extracted out of `bomcp/`
- Wave 3: adapter/engine responsibility split corrected; parser contract narrowed; provider artifact upserts made authoritative
- Wave 4: gateway-owned preparation path, CLI-agent descriptor table, explicit capability contract, and early compatibility validation
- Wave 5: cleanup/refactors for runtime error envelopes, BO-MCP param validation ownership, CLI structure, execution-manager collaborator injection, docs, and dead-code removal
- Wave 6: full verification

Verification:
- `npm run verify`

---

## Implemented — audit pass 2026-06-08 @ `d579fdb` (Waves 7–10)

Source: full audit pass (`.analysis/LEDGER.md`, 34 findings) reduced by 5-expert review.
Principle: unified surface over two backends; capabilities are contracts, not assertions;
fail loud, never silently drop. Breaking changes permitted and flagged.

**Status (implemented 2026-06-08, `npm run verify` GREEN — tsc clean + 113/113 contract tests):**
- ✅ **Wave 7** done: IPC teardown (severity corrected — see below), reasoning-tier total mapping,
  Codex `--output-schema`, process-group cancellation.
- ✅ **Wave 8** done: scope in Layer 0/1, inline-content caps, sync `handoffs`, sync-cancel doc, `gpt-5.5`.
- ✅ **Wave 9** done: taxonomy (`internal_error` wired; `invalid_limit`/`invalid_cursor` deleted;
  `not_found` kept as an HTTP-layer code — NOT folded into the execution taxonomy), dead variants /
  ghost dir / dead test helper removed. L-0704 left OPEN (intent-backed, confirm at clean commit).
- ✅ **Wave 10** done: runtime pinned (`.nvmrc`+`engines`), Biome + CI matrix, regression tests
  (tier×backends, codex `--output-schema`, IPC connect-refused, **adapter-throws-releases-admission**,
  **UTF-8 boundary truncation**). **Only deferred:** the next audit pass (`perf` + C7 schema-validation)
  — a review activity, not an implementation. Biome is config-only (unvalidated locally; runs in CI).
- ⚠️ **L-0201 severity correction:** a production repro proved the gateway does **not** crash on oversized
  IPC frames (both prod sockets handle `'error'`); the uncaught error was a test-harness gap. Downgraded
  HIGH→LOW. Fix kept as hardening + test-server `'error'` handler.

Breaking changes shipped: non-enum `reasoning` rejected; unsupported-capability requests rejected
(already gated); Layer-0/1 `scope` now honored; `SyncRunResult.handoffs` added; error-code surface
trimmed (`invalid_limit`/`invalid_cursor` gone).

Original spec retained below for the record.

### Wave 7 — P0 correctness (close the red test + crashes)

- [x] **IPC teardown crash** (L-0201). `socket.destroy(error)` at `ipc-channel.ts:146,173` (client) +
  `:55,65` (server) double-emits → unhandled `ECONNRESET` → `uncaughtException` kills the gateway.
  How: reject the pending RPC with a domain error, then `socket.destroy()` **no-arg**; add one
  idempotent terminal `'error'` handler guarded by a `settled`/`fatalSocketError` flag at all 4 sites.
  Keep the 256 KB cap (it carries control messages, not payloads); rename to documented
  `IPC_MAX_FRAME_BYTES`; **no env knob**. Closes `bomcp-ipc.test.ts:238`. *Not breaking.*
- [x] **Reasoning tier mapping** (L-0301/0302; test masking L-0308). `reasoning` flows untranslated to
  Claude `--effort` (rejects `standard/light/deep`) and Codex `model_reasoning_effort` (hard-crash).
  How: canonical `ReasoningTier = none|light|standard|deep` validated at `normalize`/`validate`;
  each adapter owns a **total** map (mapping lives in the adapter — only it knows its CLI vocab):
  `none→(omit)/none · light→low/low · standard→medium/medium · deep→high/high` (Claude/Codex).
  Replace `execution.test.ts:258` (`--effort high` masks the bug) with a `tiers×backends` table test.
  *Breaking: non-enum `reasoning` now rejected.*
- [x] **Codex output schema + capability honesty** (L-0303). `-c output_schema=` is not a Codex key →
  silently ignored; `descriptors.ts` advertises `custom_output_schema:true` (a lie).
  How: write schema to `run_dir/output-schema.json`, pass `--output-schema <path>`. Make capability
  flags **load-bearing**: `validate` gates each capability-dependent field against the resolved
  backend descriptor and rejects (structured error) if unsupported. Audit all `SHARED_CAPABILITIES`.
  *Breaking: previously silent mis-serves now fail loud.*
- [x] **Process-group cancellation** (L-0305). `process.ts` signals only the direct PID; `claude`/`codex`
  fork children that orphan on timeout/abort/SIGKILL (violates "cancellation is real" + "stateless").
  How: `spawn(..., { detached: true })`; escalate SIGTERM→grace→SIGKILL against the group
  (`process.kill(-pid, sig)`), guard pid ≤ 1 / already-exited. Document **Unix-only** (consistent with
  the existing UDS requirement). Test: fork-a-sleeper, cancel, assert the PID is gone. *Not breaking.*

### Wave 8 — contract honesty & input bounds

- [x] **Scope honored in Layer 0/1** (L-0602). `/run` silently drops `workspace.scope` → caller gets
  full-root. How: plumb `scope` through `api/normalize.ts`; containment-check via existing
  `resolveContainedRealPath`; **document scope as cwd-narrowing, not a sandbox** (CLI runs permissive).
  *Breaking: a previously-ignored field now takes effect.*
- [x] **Inline-content byte caps** (L-0401). Inline attachment `content` is unbounded in validation;
  only the 1 MiB HTTP body cap mitigates, and in-process `gateway.execute` has none.
  How: `MAX_ATTACHMENT_CONTENT_BYTES` + `MAX_TOTAL_INLINE_BYTES`, env-overridable, enforced in
  `validate` (covers both entry paths). *Not breaking.*
- [x] **Sync handoffs surfaced** (L-0603). `buildSyncResult` has no `control.handoff` case → the whole
  handoff taxonomy is invisible to sync callers. How: add `handoffs: HandoffSignal[]` to
  `SyncRunResult`, populated from envelopes. *Breaking: response shape grows.*
- [x] **Sync cancel documented, not built** (L-0604). No sync-cancel side channel (over-engineering).
  Document: sync runs cancel by disconnect (`response.on('close')`); use the stream API for explicit
  cancel. *Not breaking.*
- [x] **Default model currency** (L-0304). `descriptors.ts:46` codex `gpt-5` → `gpt-5.5`; reconcile with
  `cli-args.ts` help examples. *Not breaking.*

### Wave 9 — coherence cleanup (breaking error surface)

- [x] **Error taxonomy unification** (L-0702). `internal_error` declared-but-unused while code throws
  bare `"internal"` and HTTP emits `"not_found"` (not in the taxonomy at all). How: wire
  `internal_error`, **add** `not_found`, **delete** `invalid_limit`/`invalid_cursor` (no pagination —
  YAGNI). *Breaking: error-code wire surface changes.*
- [x] **Dead variants** (L-0703/0701/0504). Delete `artifact.superseded` + `progress.usage`
  `BomcpMessageKind` members (no producer/consumer/intent); `rmdir src/providers`; remove dead test
  helper `initGitRepo` (`runtime-semantics.test.ts:77`). *Not breaking.*
- [ ] **Artifact-upsert half-wire** (L-0704) — still verify-at-commit (intent-backed, no code change). `provider.artifact.upsert` has a consumer + test producer
  but no live adapter producer; intent-backed (Wave 3 "made authoritative"). Confirm the producer
  lands at clean commit — **not a defect**, do not force-wire. *Not breaking.*

### Wave 10 — verification discipline

- [x] **Pin the runtime.** Add `.nvmrc` + `engines.node` at the documented LTS floor; re-run the suite
  on the pin to clear `runtime-suspect`. *Not breaking.*
- [x] **Minimal CI + linter.** Workflow: `typecheck + test + audit-wiring grep guard` (catches the
  orphan class). Add Biome (one dep, formatter+linter, zero-config). No heavyweight toolchain. 
- [x] **Targeted tests** (L-0103/0303/0503): tier `tiers×backends` table · capability-gate rejection ·
  adapter-throws-still-releases-admission · IPC connect-refused · one UTF-8 boundary property test.
- [ ] **Next audit pass** (deferred — review activity, not implementation) covers the unprobed cells — `perf` (zero cells this pass) and C7
  schema-validation — at a clean commit.

### Refuted — do NOT action (calibration)

Verified correct; generate no work: admission-release leak (L-0103), cancel/complete double-terminal
(L-0102, invariant holds via the synchronous abort-branch), non-atomic-status corruption (L-0105),
teardown data-loss (L-0005), "no real ExecutionManager/CLI tests" (L-0501, suite ~97% substantive).
Security spine — path containment (L-0006) and lease choke point (L-0202) — is adversarially-verified
sound. **Do not "fix" what was proven correct.**

### Verification (this pass)
- `npm run verify` (typecheck + contract suite) on the **pinned** runtime once Wave 10 lands.
- Re-baseline the audit verdict at a clean commit (`/audit-slice` → the verdict can go non-provisional).

---

## Implemented — Wave 11 — CLI parity & hermetic execution (2026-06-08)

Source: review of the **current** `claude` and `codex` CLI references (June 2026) — both evolved
substantially since bo_staff was written — reduced by 5-expert review. Scope = **intersection only**:
every item is a capability *both* CLIs now expose (or a bo_staff-layer fix), so each strengthens rather
than dilutes the one-surface abstraction. Asymmetric features are explicitly refused (bottom). Breaking
changes permitted and flagged. Principle: explicit-over-ambient; unified guarantees over per-vendor flags.

**Status (implemented 2026-06-08, `npm run verify` GREEN — tsc clean + 120/120 contract tests):**
- ✅ **1** Claude `stream-json` parser — rewritten to project live events (turns/thinking/tool); shared
  `NdjsonLineBuffer`/`parseJsonObject` framer (DRY) used by both parsers, two vocabulary mappers; defensive
  (unknown→generic progress, never throws); 6 fixture tests incl. chunk-split + structured-output.
- ✅ **2** Hermetic by default — **refined during implementation**: `--strict-mcp-config` (Claude) +
  `--ignore-user-config` (Codex), with `inherit_host_config` opt-out. **Deliberately NOT `--bare`/`--ephemeral`/
  `--no-session-persistence`** — `--bare` trims Claude's toolset (capability regression) and ephemeral/no-persist
  break the continuation/resume contract. Hermetic = config isolation, not capability/persistence stripping.
- ✅ **3** `--append-system-prompt` default + `system_prompt_mode` toggle (Claude no longer clobbers its prompt).
- ✅ **4** Caller-supplied `execution_id` (idempotency key) + synchronous at-most-once dedup (`reservedExecutionIds`);
  fed to Claude `--session-id` when a UUID; fixes L-0604. Concurrent-dedup test added.
- ✅ **5** `max_turns` — **was already enforced** in `provider-collector` (turn-boundary abort, both backends);
  added the Claude `--max-turns` early-stop. (The "dead field" claim was wrong — corrected.)
- ✅ **6** Cache tokens (`cache_read_tokens`/`cache_creation_tokens`) in `UsageSummary`, mapped from both backends.
- ⊘ **7 — REFUSED as over-engineering.** A `reasoning_summary` request field maps to a Codex-only knob
  (`model_reasoning_summary`); asymmetric, violates the intersection rule. The actual value — thinking surfaced
  as `progress(phase:"thinking")` — is delivered by item 1; Codex already emits reasoning by default. No new field.

**Live-validated 2026-06-09** against real `claude` 2.1.169 + `codex` 0.137.0: full stack (gateway → engine →
adapter → parser → finalize) reaches `execution.completed` on both backends; stream-json live events flow,
cache tokens populate `UsageSummary`, hermetic flags + append-system-prompt don't break execution. The earlier
"fixture-not-live" caveat is closed. (Claude's new `rate_limit_event` type is handled by the defensive default.)

Breaking changes shipped: `reasoning`-tier already enforced (Wave 7); now also — host CLI config no longer read
by default (`inherit_host_config`), Claude system prompt appended not replaced (`system_prompt_mode`), Claude
output is `stream-json` (event shape on the wire), `UsageSummary` gained cache fields.

Original spec retained below for the record.

### Wave 11 items

- [x] **1 — Symmetric structured events (Claude `stream-json`).** Today Claude runs `--output-format json`
  (single-shot) so `ClaudeEventParser.onStdoutChunk` returns `[]` — Claude emits no live events while Codex
  (`--json`) does. How: Claude adapter → `--output-format stream-json --verbose`; rewrite `ClaudeEventParser`
  to map the event stream into `AdapterEvent`; **extract a shared NDJSON line-framer** (DRY) but keep **two**
  vocabulary mappers (Claude `content_block`/`tool_use` ≠ Codex `thread`/`turn`/`item` — do not unify into a
  god-parser); unknown event types → generic `provider.progress`, **never throw**; test against a **recorded
  stream-json fixture**, not a hand-mock; `--include-partial-messages` (token deltas) **opt-in only** (control
  stream, not a token relay). *Why: makes the unified event stream actually unified — the product's core claim.*
  Not breaking (richer events). **Highest value; gates item 7. Do first; re-run verify.**
- [x] **2 — Hermetic execution by default.** bo_staff currently inherits the host operator's ambient config
  (`CLAUDE.md`, `~/.claude.json` MCP, codex `config.toml`, skills/hooks) → same request behaves differently
  per host, and "stateless" is a lie (session files left on disk). How: default Claude
  `--bare --strict-mcp-config --no-session-persistence`; Codex `--ephemeral --ignore-user-config`; expose one
  **backend-agnostic** opt-out `inherit_host_config` (default `false`), each adapter maps it to its own flags.
  *Why: explicit-over-ambient → reproducibility + a real trust boundary + a truthful "stateless"; also faster.*
  **Breaking** (host config no longer read unless opted in). Needs its own behavioral tests; re-run verify.
- [x] **3 — Append, don't replace, the system prompt.** `renderClaudePrompt` passes `--system-prompt`, which
  **replaces** Claude Code's entire system prompt — dropping its tool/safety guidance, doubly bad under
  `bypassPermissions`. How: default Claude `--append-system-prompt`; expose `system_prompt_mode: "append" |
  "replace"` (default `append`); Codex unchanged (it already injects system text as additive context).
  *Why: bo_staff's system sections are additive context, not a new identity.* Mild breaking (Claude keeps its
  default prompt unless `replace`).
- [x] **4 — Caller-supplied `execution_id` (idempotency key) — fixes L-0604.** First-principles correction:
  the sync-cancel gap is **bo_staff's buffering**, not the provider session — `--session-id` does not fix it.
  How: accept an optional caller-supplied `execution_id` at the bo_staff layer → caller can
  `POST /executions/:id/cancel` immediately (provider-agnostic, both backends) + at-most-once dedup; separately
  feed the UUID to Claude `--session-id` for deterministic continuation (Codex can't accept a provided id —
  stays asymmetric, don't pretend otherwise). Add an in-flight-dedup test. *Why: fix the gap where it lives.*
  Additive. **Supersedes the naive "use `--session-id`" reading.**
- [x] **5 — Enforce `max_turns` (the field is currently dead).** `runtime.max_turns` is normalized but never
  passed anywhere. How: **enforce in the provider collector** by watching `provider.turn_boundary` events and
  aborting on exceed (works on *both* backends via the existing abort path); also pass Claude `--max-turns` as
  a token-saving early-stop. *Why: a unified guarantee beats a per-vendor flag; we already emit the turn signal
  (Codex has no exec `--max-turns`).* Additive (dead field becomes real).
- [x] **6 — Cache-token usage.** Extend `UsageSummary` with `cache_read_tokens` / `cache_creation_tokens`,
  mapped from both backends (Claude `cache_read`/`cache_creation`; Codex `cached_input_tokens`). *Why: real
  cost signal both now expose.* Additive.
- [ ] **7 — Reasoning-summary events** (REFUSED as over-engineering — see Wave 11 status; value delivered by item 1). `reasoning_summary` toggle → Codex `model_reasoning_summary`
  (`auto|concise|detailed|none`) + `model_verbosity`; Claude thinking via stream-json → typed
  `provider.progress` (phase `"thinking"`). No separate channel. *Why: surface reasoning uniformly.* Additive
  (rides item 1).

### Refused / deferred (anti-over-engineering pass)

- **Refused (asymmetric — would fracture the one-surface promise):** `--max-budget-usd`, `--fallback-model`,
  agent-view/background sessions, plugins, channels, Chrome (Claude-only); `codex cloud`, `--oss`/Ollama
  (Codex-only).
- **Deferred:** Claude `--tools` (restrict available toolset) — cleaner than overloading `--allowedTools`;
  fold into the tool-policy mapping later, not now.
- **Parked (future, NOT Wave 11):** migrate the transport from stdout-scraping to `codex app-server` /
  Claude Agent SDK (structured JSON-RPC / in-process). More robust but a re-architecture; `stream-json`
  (item 1) captures ~80% of the benefit at ~5% of the cost and is the incremental step toward it. Revisit
  only if stdout parsing proves fragile in practice.

### Sequencing
1 → 2 → 4 → (3, 5, 6, 7). Re-run `npm run verify` after **1** and **2** specifically.

### Verification (Wave 11)
- `npm run verify` green on the pinned runtime.
- New recorded-fixture test for Claude `stream-json`; behavioral tests for hermetic flags; idempotency dedup test.

---

## P1 — completed 2026-04-07

- ~~Implement structured health predicate in `GET /health`.~~ Done: `HealthResponse` now returns `{ status: "accepting" | "saturated" | "degraded", executions: { active, max, draining } }`. `currentLoad()` exposed on `ExecutionAdmissionController`, `healthCheck()` on `ExecutionManager`, gateway delegates synchronously.

## P2 — completed 2026-04-07

- ~~Emit one structured audit record to stderr on every execution terminal state transition.~~ Done: `ExecutionAuditRecord` emitted in `ExecutionManager.execute()` finally block via `emitAuditRecord()`. Discriminated by `_type: "execution.audit"`.
- ~~Enrich `GET /executions/{id}` with `elapsed_ms` and `progress`.~~ Done: `elapsed_ms` computed on request from `state.started_at`, `progress` threaded through `EphemeralExecutionState` and populated by `BomcpToolHandler.handleProgressUpdate()`.

## Non-goals (observability)

- No cumulative token counters — stateless design, resets on restart, caller's responsibility to aggregate from per-execution responses.
- No `/metrics` endpoint — trivially additive later from health data if the need becomes real.
- No dashboard or UI — external consumer's job, not the gateway's.
- No server-wide event bus — per-execution NDJSON stream is sufficient.
- No progress staleness heuristics in health — lease expiry is the hard boundary.
- No per-execution detail in health response — health is a predicate, not an inventory.
- No `Retry-After` on 429 — cannot predict slot availability meaningfully.

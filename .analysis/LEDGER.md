# bo_staff — Audit LEDGER

> One entry per finding: `### L-XXXX · <KIND> · <one-line> · <status>`
> KIND ∈ ORPHAN | WIRING | FAKE-TEST | DESIGN | RISK | NOTE
> status ∈ open | verify-at-commit | needs-verify | resolved | wontfix | confirmed-intentional
> Confidence tier ∈ static | executed | adversarially-verified  (+ N/100, + what-not-verified)
>
> Pass header for all current entries: ref `d579fdb`, DIRTY tree (mid-refactor), Node v25 unpinned, build GREEN, tests 108/109.

<!-- findings appended below -->

### L-0001 · WIRING · C1 http-ingress: all 5 routes registered & reachable, handlers REAL · verify-at-commit
What: Every documented route is matched in `routeHttp` and dispatched to a real handler that calls a real gateway method.
Evidence: GET /health → router.ts:30 → handleHealth (health.ts:5 → gateway.health). POST /run → router.ts:36 → handleRun (run.ts:16 → gateway.prepareExecution + executeNormalized). POST /executions/stream → router.ts:43 → handleExecuteStream (executions.ts:10 → gateway.execute). GET /executions/:id → router.ts:62 → handleGetExecution (executions.ts:28 → gateway.getActiveExecution). POST /executions/:id/cancel → router.ts:70 → handleCancelExecution (executions.ts:55 → gateway.cancelExecution). No handler exported-but-unrouted; no route without handler. Test "removed operator endpoints are not routed" passes. All REAL (each touches gateway state).
Confidence: adversarially-verified, 95/100. Not-verified: gateway method internals (other cells).

### L-0002 · NOTE · C1 streaming lifecycle correct: preflight=system.error-only, one terminal, disconnect aborts, drain-before-end, post-header throw→NDJSON · verify-at-commit
What: NDJSON correctness questions (a)-(f) all hold.
Evidence: (a) preflight rejection — admission fail emits only system.error and returns (execution-manager.ts:88-94); body-parse fail on /executions/stream → writeRejectedStream emits single error envelope + end (router.ts:47-54, executions.ts:108-116); test "pre-dispatch stream rejection emits system.error" green. Exactly-one-terminal: finalize emits one of completed/failed (execution-finalization.ts:23/45/62), cancel path returns early after execution.cancelled (execution-manager.ts:261-272) — mutually exclusive via early returns. (b) disconnect: streamExecutionNdjson registers response "close"→abortController.abort (execution-stream.ts:18-22); engine also wires caller signal→inner abort (execution-manager.ts:172-173). (c) drain: writeNdjson awaits waitForDrain on backpressure (ndjson.ts:15-19,33-59); endNdjson awaits response.end callback (ndjson.ts:22-31) and runs only after onExecute (incl. teardown) resolves (execution-stream.ts:31,49). (d) post-header throw: caught in execution-stream.ts:35-46, converted to runtime_error NDJSON event guarded by writableEnded check; test "stream handler converts post-header execution throws into NDJSON failure events" green. (e) body-size: 413 body_too_large at executions.ts:85-86; malformed JSON→400 invalid_json executions.ts:96-97; non-JSON→415 executions.ts:76-77; empty→400 executions.ts:91-92. (f) heartbeat: setInterval emits progress.heartbeat (execution-manager.ts:189-193) — see L-0004.
Confidence: executed, 90/100 (11/11 http.test.ts green on Node v25; project unpinned so green is best-effort, not pin-matched). Not-verified: real provider-driven multi-event stream end-to-end (mocked in tests).

### L-0003 · NOTE · C1 error containment: handler/stream errors become structured responses, no raw stack, no crash · verify-at-commit
What: Router try/catch maps HttpRequestError→its status/code else 500 runtime_error JSON (router.ts:77-85); unmatched→404 JSON (server.ts:30-35). Stream errors after headers are caught and either NDJSON'd or swallowed via reportInternalError (execution-stream.ts:35-53). buildRuntimeErrorEnvelope/buildSyncResult wrap engine throws so handleSyncRun never leaks a stack (run.ts:57-71). Test "GET /health failures are contained as structured server errors" green.
Confidence: executed, 88/100. Not-verified: that reportInternalError can't itself throw synchronously (other cell).

### L-0004 · RISK · Heartbeat write is fire-and-forget — backpressure/interleave with ordered stream writes (CONFIRMS prior flag) · verify-at-commit
What: setInterval callback calls stream.emitRuntime("progress.heartbeat",{}).catch(...) WITHOUT awaiting (execution-manager.ts:189-193). A tick can fire while a prior writeNdjson is parked in waitForDrain (ndjson.ts:33), and while finalize's terminal write is in flight. Concurrent emits each register their own drain/close/error listeners on the same ServerResponse (ndjson.ts:55-57); under sustained backpressure this churns listeners and an in-flight heartbeat write can reject after the socket closes. No byte-interleaving (response.write appends synchronously) and rejections are .catch'd so no unhandled-rejection crash — but backpressure is not respected on the heartbeat path and a heartbeat can be emitted/attempted between the terminal event and teardown. Lives in C5 engine, but is the streaming-spine concern the prior review raised.
Why: degrades the "writes respect backpressure" invariant; not a corruption or crash, a soundness gap on a slow client.
Evidence: execution-manager.ts:189-193 (no await); ndjson.ts:15-20,33-59 (drain accounting per-call); contrast finalize awaits (execution-finalization.ts:23,62).
Action: serialize stream writes (single async queue) or skip heartbeat tick while a write is pending / when response.writableNeedDrain.
Confidence: adversarially-verified, 85/100 (tried to refute: searched for a write-queue/mutex around emit — none; ControllerStream.emit has no serialization, controller-stream.ts:20-37). Not-verified: real-world frequency vs default heartbeat interval.

### L-0005 · NOTE · REFUTED: "stream teardown not awaited before ipcServer.stop (data-loss window)" · verify-at-commit
What: Prior review flagged a data-loss window between stream teardown and ipcServer.stop. Refuted as ordered for the terminal-event path.
Evidence: streamExecutionNdjson awaits onExecute fully (execution-stream.ts:31), which awaits ExecutionManager.execute whose finally runs teardown→ipcServer.stop (execution-manager.ts:98-102,341) BEFORE returning; endNdjson runs only after that (execution-stream.ts:49). Terminal events are emitted with await in executeInner/finalize (execution-finalization.ts:23/45/62, execution-manager.ts:261) — all before the finally. So all ordered controller writes complete before ipcServer.stop and before response.end; no data-loss window for terminal/normal events. RESIDUAL: the only writes that can still be in flight at teardown are fire-and-forget heartbeats (see L-0004) — that is the real, narrower truth behind the flag.
Confidence: adversarially-verified, 90/100. Not-verified: whether ipcServer.stop drops in-flight tool-call replies (other cell, not the HTTP stream).

### L-0006 · NOTE · C6 workspace-scope: path containment is SOUND — realpath-before-contain defeats symlink/`..`/prefix escapes · verify-at-commit
What: `isPathInside` + `resolveContainedRealPath` (scope.ts) are the only host-FS guard (provider CLIs run fully-permissive). Both string-level and symlink-level escape attempts are correctly denied; the symlink-free realpath is what gets read/used, closing the symlink-swap TOCTOU on the guarded paths.
Why it matters: this is the security spine — a bypass = arbitrary host file read/write under a permissive CLI.
Evidence: `isPathInside` (scope.ts:27-33) uses `path.relative` then rejects `""`?no→accept, and rejects any result starting `..` or absolute. Adversarial probe (executed, /tmp): `/work` vs `/work-evil` → false (prefix trick blocked), `/work/../etc` → false, `/etc/passwd` → false, `""` → false (via `!candidate` guard). `resolveContainedRealPath` (scope.ts:40-55) realpaths BOTH root and candidate via `Promise.all` BEFORE the contain check — probe with a real symlink inside root pointing to an outside dir/file → `outside`; root-itself-a-symlink → still contained correctly. CALL SITES, every FS entry routed through it: (1) attachments — validate.ts:333-352 resolves+realpaths, stores realpathed path in `resolvedAttachmentPaths`, applied via `applyResolvedAttachmentPaths` (shared.ts:62-85, overwrites `attachment.path`), and prompt-attachments.ts:23 reads that resolved (symlink-free) path → swap-TOCTOU closed. (2) scope subpath — validate.ts:186-218 (`isWorkspaceScopeContainedWithinSourceRoot` + `resolveContainedRealPath`). (3) artifact register AND require — both go through `resolveArtifactPath` (tool-handler.ts:129,168→211-233) which re-realpaths at USE time against `artifactRoot`; probe confirms a post-validation link swap flips to `outside`. `artifactRoot` is wired to `workspace.runtime_working_directory` (execution-manager.ts:153-158), always a truthy path in prod → the `!artifactRoot` no-containment branch (tool-handler.ts:215-219) is unreachable except in tests (only other constructor: bomcp-protocol.test.ts:124). Deny path PROVEN by real tests: validation.test.ts:151 creates a real symlink to a real outside file and asserts rejection `/symlink resolution/`; :93 asserts `/effective workspace scope/`; bomcp `path_outside_artifact_root` covered. Ran `node --test validation.test.ts bomcp-protocol.test.ts` → 45/45 green.
Refutation attempt (mandatory for "sound"): tried prefix-sibling (`/work-evil`), `..` traversal, abs path, empty, dot, symlink-to-outside (dir+file), symlink-as-root, and post-validation symlink swap — all denied or re-checked at use. Could not construct an escape through any wired entry point. → tier up.
Confidence: adversarially-verified, 92/100. Not-verified: a true kernel-race TOCTOU on the scope-root cwd itself (see L-0007 — out of scope for containment of guarded reads); behavior if `realpath` is intercepted by an FS that doesn't resolve symlinks (exotic mounts).

### L-0007 · DESIGN · C6: validated realpath of scope root is DISCARDED; workspace-manager re-derives non-realpathed cwd (low-severity) · verify-at-commit
What: validate.ts:193 computes `containedScopedRoot.path` (the realpathed, contained scope root) but uses only `.status` and discards `.path`. workspace-manager.ts:55 then independently re-runs `resolveWorkspaceScopeRoot` (NON-realpathed) and uses that as `runtime_working_directory` → CLI cwd (adapters/shared.ts:27, codex/adapter.ts:37-42) AND as `artifactRoot`.
Why it matters: NOT a containment bypass — validation already proved the realpath of this same deterministic input is contained, and the artifact guard re-realpaths at use-time anyway (L-0006). Residual is a classic scope-root TOCTOU: if the caller swaps the `source_root` (or an intermediate dir) symlink between validate and prepare, the CLI cwd could differ from the validated realpath. But `source_root` is caller-provided and the CLI is fully-permissive within whatever cwd regardless, so this grants the caller nothing they don't already control. Cosmetic/robustness, not a security hole.
Evidence: validate.ts:192-194 (`.path` discarded); workspace-manager.ts:55,59 (recompute, non-realpathed); execution-manager.ts:157 (→artifactRoot); adapters/shared.ts:27 (→cwd).
Action (optional): thread the validated realpath through to `runtime_working_directory` instead of recomputing, to eliminate the recompute window and centralize the source of truth.
Confidence: adversarially-verified, 80/100 (tried to weaponize the discard into an escape of the artifact/attachment guards — failed, those re-check/store-realpath independently). Not-verified: whether any other consumer trusts `runtime_working_directory` as a containment boundary without re-checking (scanned C6+immediate callers only).

## C3 engine-execution · correctness+wiring · seam S6 terminal-event (pass d579fdb, DIRTY)

### L-0101 · NOTE · Execution lifecycle fully wired end-to-end, all stages REAL · verify-at-commit
What: traced admission→lease→state→workspace.prepare→prompt→ipc.start→adapter.run→provider-collector→finalize→teardown. Every stage executes real logic; nothing declared-but-dead.
Evidence: admission execution-manager.ts:88 → buildLease :78 → createEphemeralState :83 (execution-state.ts:4) → workspaceManager.prepare :127 (workspace-manager.ts:31) → buildExecutionPrompt :131 (prompt.ts:4) → ipcServer.start :160 (ipc-channel.ts:31) → activeExecutions.set :169 → collectProviderResult :228 (provider-collector.ts:14, real `for await` over adapter.execute) → finalizeExecution :276 (execution-finalization.ts:10) → teardown :100/:336. All REAL.
Action: none.
Confidence: executed, 90/100. Ran 22/22 contract tests green on Node v25.1.0 (runtime-suspect: pin is unset/floor 24, but green so not a defect). Not-verified: real claude/codex spawn (tests use fake adapters).

### L-0102 · DESIGN · Exactly-one-terminal invariant HOLDS — gated by abort-signal branch, no dedup flag needed · verify-at-commit
What: S6 invariant enforced by the synchronous `if (abortController.signal.aborted)` branch choosing cancel-path XOR finalize. No emit-dedup guard exists, but the three terminal emitters are mutually exclusive by control flow. REFUTES prior-claim (ii) "both cancel+complete could reach the stream".
Evidence: only terminal emitters in cell: (a) early-resolution-error execution-manager.ts:138 returns :146 BEFORE active-registration/provider/finalize; (b) cancel-path :261 returns :272; (c) finalize completed execution-finalization.ts:62 / failed :23/:45. (b) vs (c) selected at execution-manager.ts:258 with NO await between check and return/finalize → decision atomic. cancelExecution :286-295 and lease-timer :198-212 only call abort()+set status; emit NO terminal — late cancel after finalize started emits nothing. Collector may set both terminal+failure but finalize checks failure first (execution-finalization.ts:20) → one event.
Action: optional defense-in-depth `terminalEmitted` flag.
Confidence: adversarially-verified, 88/100. Tried pre-aborted signal, late cancel, dual provider.completed+failed — all collapse to one terminal. Not-verified: re-entrant streamWriter.

### L-0103 · RISK · Admission release ordering in finally is fragile but balanced on all realistic paths · verify-at-commit
What: REFUTES prior-claim (i) "release leaks on some throw". execute wraps executeInner in try/finally with `emitAuditRecord(); teardown(); release();` (execution-manager.ts:96-102). release() is last; if a prior finally stmt threw, release would skip.
Evidence: emitAuditRecord :349-365 wraps stderr.write in try/catch → cannot throw. teardown :336-347 wraps ipcServer.stop in try/catch; stream.close()/map-ops cannot throw. The reportInternalError at :343 does an UNGUARDED stderr.write (internal-reporting.ts:6) reachable only if ipcServer.stop rejects; combined with a closed stderr it could throw and skip release — extremely narrow. tryAcquire (execution-admission.ts:12) never throws; false→return needs no release. Net: balanced on every realistic path.
Action: move release() to top of finally (low severity).
Confidence: adversarially-verified, 82/100. Not-verified: EPIPE-on-stderr concurrent with ipc-stop reject.

### L-0104 · NOTE · Cleanup never deletes caller workspace; runs on every exit path · verify-at-commit
What: invariant (d) holds. cleanup removes only run_dir (always under dataDir/runs/...), never runtime_working_directory (=caller source_root/authorityRoot for non-ephemeral).
Evidence: WorkspaceManager.cleanup → removeDir(runtime.run_dir) workspace-manager.ts:65-68; run_dir built :35-40 under dataDir; non-ephemeral runtime_working_directory=authorityRoot :59 untouched. removeDir=rm(recursive,force) utils.ts:63. Invoked on early-error execution-manager.ts:144, cancel :271, all 3 finalize terminals execution-finalization.ts:35/:57/:75. Best-effort wrapped.
Action: none.
Confidence: static, 86/100. Not-verified: symlink case where source_root==run_dir (needs malformed upstream normalization in C2).

### L-0105 · NOTE · state.status mutations are not a correctness hazard for the terminal invariant · verify-at-commit
What: REFUTES prior-claim (iii) "non-atomic state.status mutations". JS single-threaded → each assignment atomic; terminal decision keys off abortController.signal.aborted (execution-manager.ts:258), NOT state.status. Status writes (:176/:210/:260/:292, execution-finalization.ts:22/44/61) feed only the audit record (:357) and tool-handler active-gate (tool-handler.ts:245/255).
Why: a racing late cancel can overwrite "completed"→"cancelled" → audit record may mislabel, but no double terminal, no control-flow corruption.
Action: optional — snapshot status before finalize emit for audit accuracy (cosmetic).
Confidence: adversarially-verified, 80/100. Not-verified: exact audit value under racing cancel (needs timing harness).

### L-0106 · RISK · Pre-aborted caller signal at entry is not honored (client-disconnect edge) · verify-at-commit
What: invariant (e) works for mid-flight disconnect via addEventListener("abort", onControllerAbort, {once}) (execution-manager.ts:172-173) wired to provider abortController. But if input.signal is ALREADY aborted before execute runs, the listener never fires retroactively → provider runs to completion ignoring the pre-disconnected caller.
Evidence: listener :173; provider uses separate abortController.signal :236; no `if (input.signal.aborted) abortController.abort()` pre-check.
Action: add `if (input.signal.aborted) onControllerAbort();` after registration.
Confidence: static, 75/100. Not-verified: whether C1/http ever passes a pre-aborted signal (HTTP handler aborts on socket close, likely mid-stream not pre-entry).

## C5 bomcp · security+correctness · seam S3 (pass d579fdb, DIRTY)

### L-0201 · RISK · Oversized IPC frame calls socket.destroy(err) → double error-emit → uncaughtException crashes the gateway process · open
What: The known failing test (`bomcp-ipc.test.ts:238`) is a REAL defect, not a Node-25 artifact. The client buffer-limit path calls `socket.destroy(error)` passing the "buffer exceeded" error (ipc-channel.ts:144-146). The pending promise rejects correctly, but `destroy(err)` emits that err as the socket's `'error'` event; the still-queued OS-level `read ECONNRESET` is then re-emitted on the destroyed socket with no listener left → `uncaughtException`. Mirror server-side path (ipc-channel.ts:50-56 `conn.destroy(new Error(...))`) has the same shape.
Why it matters: A malicious/buggy bomcp peer (or anything writing >256 KB without a newline to the engine's client socket) crashes the **whole gateway process**, not just one tool call → DoS. This is spine (the IPC the agent talks to).
Evidence: ipc-channel.ts:138-147 (client), :50-56 (server). Reproduced standalone: promise rejects with "buffer exceeded", then process dies with `read ECONNRESET` (errno -104). Isolation probe: `destroy(customError)` emits 1 handled error then a 2nd unhandled ECONNRESET.
Action: drop the error arg — `socket.destroy()` with no arg (reject the pending promise separately), or set `fatalSocketError` + add a terminal `'error'` handler that swallows post-destroy errors.
Confidence: adversarially-verified, 90/100 (reproduced; refuted the Node-artifact hypothesis — root cause is API misuse). Not-verified: server-side :55 path E2E (static-equivalent); behavior on pinned Node 24.x (root cause is version-independent).

### L-0202 · NOTE · BO-MCP lease enforcement is a real, unbypassable choke point · verify-at-commit
What: `BomcpToolHandler.handle()` runs `leaseValidator.validateToolCall` (tool-handler.ts:65) BEFORE `dispatch()` (:92); deny → `lease_tool_denied` + `system.error`. `handle` is the only caller of `dispatch` and `ipcServer.start` only invokes `handle` (execution-manager.ts:160). No bypass found.
Evidence: tool-handler.ts:59-104; expiry lease.ts:21-24; deny tests bomcp-protocol.test.ts:205,59-66,219,232.
Confidence: static, 88/100 (adversarial grep for alternate dispatch entry → none). Not-verified: live expired-lease path through the IPC server.

### L-0203 · DESIGN · Idempotency cache stores successes only — a retried request_id that errored re-executes · verify-at-commit
What: `processed_request_ids.set(id, result)` only on success (tool-handler.ts:94); lease-denied/invalid/error responses never cached → invariant is "idempotent *successful* request IDs".
Evidence: tool-handler.ts:60-63 (cache hit), :94 (success-only). Action: cache terminal errors too, or document success-only semantics. Confidence: static, 80/100.

### L-0204 · NOTE · Server-side exactly-one-response + malformed-JSON + 256KB frame-cap DoS handling is correct · verify-at-commit
What: `handleLine` writes exactly one response (success :114 / error :121); malformed/invalid shape → destroy with no echo (:108); buffer >256KB → destroy (:55). Late-response/timeout race guarded by `settlePending` (:250). Intentional DoS defenses (the one backfire is L-0201's destroy-with-error).
Evidence: ipc-channel.ts:90-123,286-295,10. Confidence: executed, 85/100 (8/9 IPC tests green incl. timeout/late/unknown-id/cleanup).

### L-0205 · NOTE · IPC Unix socket created with default umask perms (no 0o600 / 0o700 dir) · verify-at-commit
What: `server.listen(socketPath)` (ipc-channel.ts:73) + `mkdirSync(...,{recursive:true})` (:33) set no mode. On a multi-user host any local user traversing `dataDir/ipc/` could connect (bounded by lease, but reaches `handle`). Low severity single-tenant.
Evidence: ipc-channel.ts:24-74; no chmod/mode/umask in src/bomcp or src/engine. Action: `chmodSync(socketPath,0o600)` or create ipc dir 0o700. Confidence: static, 75/100.

## C4 adapters-cli · correctness · seam S8 cli-flag-mapping (pass d579fdb, DIRTY; real CLIs probed: claude 2.1.168, codex 0.137.0)

### L-0301 · RISK · Claude `--effort` receives untranslated reasoning tier → CLI rejects 3 of 4 advertised values · open
What: `--reasoning` advertises `none/light/standard/deep` (cli-args.ts:103) but the value flows verbatim (no translation, no enum-validation) to `args.push("--effort", reasoning_effort)`. Real `claude --effort` accepts only `low|medium|high|xhigh|max` → `standard/light/deep` rejected, execution fails.
Evidence: claude/adapter.ts:40-42; cli-args.ts:103; api/normalize.ts:111,128; validation/normalize.ts:61-63 (no enum); validation/validate.ts (zero `reasoning`/`effort` matches). Real CLI help: `--effort (low, medium, high, xhigh, max)`.
Action: add a tier→effort map (or change advertised tiers) + validate at normalize. Confidence: adversarially-verified, 96/100.

### L-0302 · RISK · Codex `model_reasoning_effort` receives untranslated tier → HARD CRASH on standard/light/deep · open
What: same verbatim tier → `-c model_reasoning_effort=<json>` (codex/adapter.ts:54-55). Live probe `codex exec -c 'model_reasoning_effort="standard"'` (no `--strict-config`, exactly as bo_staff runs) → `Error loading config.toml: unknown variant 'standard', expected one of none, minimal, low, medium, high, xhigh`. Hard fail before execution. Vocab diverges from Claude: `none` valid on codex/invalid on claude; `light/standard/deep` invalid on both.
Evidence: codex/adapter.ts:54-55; runtime probe. Action: per-backend tier translation. Confidence: adversarially-verified (executed vs real codex), 97/100.

### L-0303 · RISK · Codex custom output schema uses wrong mechanism → silently ignored, structured output broken · open
What: codex/adapter.ts:79 emits `-c output_schema=<json>`. Real codex flag is `--output-schema <FILE>`; `output_schema` is not a config field. Live probe: under `--strict-config` → "unknown configuration field output_schema"; WITHOUT it (bo_staff's actual invocation) → silently ignored, codex runs unconstrained, no error surfaced. So `output.format==="custom"` on Codex yields unenforced output. Claude side is correct (`--json-schema <inline>`, claude/adapter.ts:81). Capability `custom_output_schema:true` for codex (descriptors.ts) overstates reality.
Evidence: codex/adapter.ts:78-79; runtime probes. Action: write schema to a temp file in run_dir, pass `--output-schema <path>`. Confidence: adversarially-verified, 96/100.

### L-0304 · NOTE · Stale default models · verify-at-commit
What: descriptors.ts:36 claude `claude-sonnet-4-6` (valid/current); :46 codex `gpt-5` — codex CLI 0.137.0 reports its own default as `gpt-5.5`; `gpt-5` is stale. cli-args.ts:114 help example already references `gpt-5.4`/`claude-opus-4-6` (inconsistent with descriptor).
Evidence: descriptors.ts:36,46; codex banner. Action: bump codex default + reconcile cli-args examples. Confidence: executed, 90/100.

### L-0305 · RISK · No process-group handling → orphaned CLI children on timeout/abort/SIGKILL · open
What: process.ts spawns without `detached:true`/setsid; kill is `child.kill(SIGTERM)`→3s→`child.kill(SIGKILL)` (process.ts:41-45,72-80) — signals only the direct child PID. claude/codex fork children (MCP subprocesses, model-driven `bash`, sandbox helpers) → grandchildren orphan/leak on kill. No killpg/detached/negative-PID anywhere (grep: 0).
Evidence: process.ts:41-45,72-80,138-164. Action: `spawn({detached:true})` + `process.kill(-child.pid, sig)`. Confidence: static+adversarial, 88/100. Not-verified: didn't capture a live orphan PID.

### L-0306 · NOTE · AbortSignal wiring + UTF-8-safe output-cap truncation are correct · verify-at-commit
What: pre-abort check + once-listener + removeEventListener in finally (process.ts:85-94,184-186); abort reason surfaced (shared.ts:48-49,138-141). Output cap UTF-8-safe via `findUtf8SafePrefixLength` (process.ts:283-318) + streaming TextDecoder + final flush. No boundary bug. Confidence: static, 85/100.

### L-0307 · NOTE · claude/codex output parsers map real CLI fields correctly (REAL, defensively coded) · verify-at-commit
What: claude parser reads `result`/`structured_output`/`session_id`/`usage.*`/`duration_ms` from the single `--output-format json` object (single-shot, not NDJSON — onStdoutChunk returns []); codex parser reads `thread.started.thread_id`/`turn.completed.usage`/`item.completed.item.text` from `--json` NDJSON + `--output-last-message` file. Matches codex 0.137.0 event vocab. THIN-but-harmless: `turn.completed.usage.duration_ms` may never populate.
Evidence: claude/parser.ts:30-50; codex/parser.ts:31-67,161-202. Confidence: static + CLI event-model cross-check, 80/100. Not-verified: byte-match of every usage sub-key vs a live transcript.

### L-0308 · FAKE-TEST · execution.test asserts `--effort high` (a valid value), masking the broken tier surface; codex `--output-schema` untested · verify-at-commit
What: execution.test.ts:258-259 asserts args include `--effort high` — `high` is valid, so the test is green while the advertised `standard/light/deep` tiers (the real contract surface, L-0301/0302) are never exercised. Codex output-schema path (L-0303) also untested (:261-262 only checks Claude `--json-schema`).
Evidence: test/contract/execution.test.ts:258-262. Action: add tests covering each advertised tier + codex schema. Confidence: static, 92/100.

## C2 gateway-normalize · security+correctness · seams S1/S7 (pass d579fdb, DIRTY)

### L-0401 · DESIGN · Inline attachment `content` size is UNBOUNDED in validation; only the global 1 MiB HTTP body cap mitigates (in-process gateway.execute uncapped) · verify-at-commit
What: No per-attachment/per-field byte cap anywhere in src/validation or api/normalize (normalize.ts:186-190 stores `content` verbatim). The prior OOM flag is mitigated-not-fixed: only bound is `BO_STAFF_MAX_BODY_BYTES` (default 1 MiB, server.ts:13, enforced executions.ts:85-87 → 413). The in-process `gateway.execute(rawRequest)` (gateway.ts:17) has NO cap (trusted programmatic caller).
Evidence: validate.ts (no size check), normalize.ts:186-190, server.ts:13, executions.ts:85-87. Action: add explicit inline-content byte bound in validate.ts so it survives body-cap changes + covers gateway.execute. Confidence: static (20/20 validation tests green), 88/100.
Context: items (a) removed-field rejection, (c) continuation backend-match (S7), (d) lease.allowed_tools validation, (e) body cap, (f) backend membership — all verified REAL (validate.ts:69,461-463,302-314,54; api/normalize.ts:82). Layer 0/1→2 normalize preserves security fields.

### L-0402 · RISK · buildLease defaults allowed_tools to ALL bomcp tools when none supplied (default-allow) · verify-at-commit
What: lease defaults to every bomcp tool when `lease.allowed_tools` omitted (bomcp/lease.ts:39). Default-allow posture; scope limited to bo_staff's own control tools (handoff/artifact/progress) and lives in the engine, outside the C2 validation seam.
Evidence: bomcp/lease.ts:39. Action: confirm intended in the engine cell (deny-by-default if not). Confidence: static, 78/100.

## C10 testing-harness · test-integrity (pass d579fdb, DIRTY)

### L-0501 · NOTE · Contract+integration tests are overwhelmingly real (~97% substantive, 106:3); REFUTES "real-CLI paths uncovered / no ExecutionManager tests" · verify-at-commit
What: 109 contract tests drive REAL units (ExecutionManager, BoStaff, ExecutionAdmissionController, executeCliAdapter, parsers, validation, ToolHandler, LeaseValidator, IpcChannel) with real fs/sockets/child-procs. FakeAdapter (test/contract/fixtures.ts:25) supplies *provider events* only — assertions land on the runtime projection, not the fake. Zero tautologies (grep `assert.ok(true)` etc → 0). Real-adapter arg-building IS asserted (execution.test.ts:82,160-169,251-281); real exec pipeline runs `sh -c` through executeCliAdapter (prompt-process.test.ts:112-196). Only the literal claude/codex binary is substituted; live integration runner hard-fails without real binaries (runner.ts:11-13) so it's not CI-run.
Substantive:hollow ≈ 106:3 (97%): derivation = 109 tests, non-substantive = heartbeat no-crash test + 2 timing-dependent cases. Evidence: per-file citations in agent report. Confidence: TIER1, 92/100 (read every file, ran suite, cross-checked vs source).

### L-0502 · NOTE · Heartbeat test verifies only "no crash", not heartbeat emission (name overclaims) · verify-at-commit
What: gateway-lifecycle.test.ts:749 self-admits (line 780) "Heartbeat may or may not appear... just verify no crash". Action: inject the interval to make it deterministic, or rename. Confidence: static, 90/100.

### L-0503 · NOTE · Real coverage gaps that matter · verify-at-commit
What: untested — (1) IPC client connect-refusal (ECONNREFUSED to nonexistent server; only mid-flight close tested, bomcp-ipc.ts:159); (2) admission release-on-adapter-throw (guard exists execution-manager.ts:98-101 but no throwing-adapter test, only graceful drain/busy); (3) stream backpressure with a slow/erroring writer; (4) the literal claude/codex binary contract (live-runner only, not CI). Confidence: static, 90/100.

### L-0504 · ORPHAN · Dead test helper `initGitRepo` defined but never called · verify-at-commit
What: runtime-semantics.test.ts:77 defines `initGitRepo`, no caller. Action: remove or use. Confidence: static (grep), 95/100.

## SCENARIO lens · CLI/HTTP & sync/stream asymmetries (pass d579fdb, DIRTY; static only)

### L-0601 · DESIGN · `bo` CLI is a thin Layer-0 slice — 7 of ~12 RunOptions fields have no CLI flag · verify-at-commit
What: RunOptions exposes continuation/objective/constraints/context/attachments/output/metadata (client.ts:43-58) but cli forwards only backend/model/workspace/timeout/reasoning/verbose (cli.ts:34-41,61-67); parseArgs defines no flags for the rest (cli-args.ts:40-59). Advanced use-cases reachable only by hand-authoring HTTP JSON.
Action: add passthrough flags (--continuation/--scope/--output-schema/--mcp-config/--objective) or document the JSON escape hatch. Confidence: static, 90/100.

### L-0602 · DESIGN · Layer 0/1 `/run` normalize silently DROPS `workspace.scope` (only true GAP) · verify-at-commit
What: Layer 0/1 builder sets only `workspace:{source_root}` (normalize.ts:138-140); never reads `workspace.scope`/subpath. Scope honored only on a Layer-2 ExecutionRequest (workspace-manager.ts:54-60 → scope.ts:13-20). A caller POSTing `{prompt,workspace,scope}` to `/run` gets full-root access — subpath ignored, NOT rejected. Capability shipped in core, no front door below Layer 2.
Evidence: normalize.ts:124-145; types/api.ts:109-115; workspace-manager.ts:54-60. Action: plumb scope through Layer 0/1, or emit Layer-2 when --scope set. Confidence: static, 88/100.

### L-0603 · DESIGN · `control.handoff` is swallowed in sync mode (no SyncRunResult field) · verify-at-commit
What: handoff emits a `control.handoff` envelope to the stream (tool-handler.ts:121-124), rendered for stream/CLI (cli-render.ts:45-49), but buildSyncResult's switch has no handoff case (sync-response.ts:33-100) and SyncRunResult has no handoff field (:5-14). The whole handoff taxonomy (blocked/needs_input/needs_approval/continue_with_*) is invisible to a sync caller (recoverable only via verbose `_envelopes`).
Action: add a `handoffs` field to SyncRunResult. Confidence: static, 90/100 (adversarial: confirmed no hidden case).

### L-0604 · RISK · Sync `/run` cannot be cancelled mid-flight; no early execution_id · verify-at-commit
What: sync buffers ALL envelopes then responds once (run.ts:42-71); `execution.started` carrying the id (execution-manager.ts:177-180) is buffered not flushed, so the caller can't learn the id to POST /cancel until after completion. Only abort hook is `response.on("close")` (run.ts:48). Stream mode flushes execution.started immediately (execution-stream.ts:24-28) so cancel IS authorable there. Asymmetry.
Action: document sync-cancel = disconnect; or surface execution_id via a response header pre-completion. Confidence: static, 85/100.

### L-0605 · NOTE · Continuation round-trip IS fully wired (token obtainable + resumable) · verify-at-commit
What: claude `session_id`/codex `thread_id` (parsers :42/:58) → `{backend,token}` (shared.ts:77-79) → emitted on execution.completed (finalization.ts:67) → `result.continuation` (sync-response.ts:42-47). Resume: normalize.ts:137 → claude `--resume` / codex `exec resume`. Confirms AWKWARD-not-GAP. Confidence: static, 90/100.

## audit-wiring · exhaustiveness (pass d579fdb, DIRTY; build GREEN, 108/109)

### L-0701 · NOTE · `src/providers/` is an empty ghost dir (deleted module) · open
What: `D src/providers/shared.ts` left `src/providers/` with zero .ts. Nothing imports `providers/shared` or `bomcp/params` (grep → 0). Action: `rmdir src/providers` (cosmetic). Confidence: deterministic, N=1.

### L-0702 · ORPHAN · 3 of 19 error codes declared in taxonomy, never constructed · open
What: `internal_error`, `invalid_limit`, `invalid_cursor` have full ERROR_CODE_DEFINITIONS entries but zero construction sites (errors/taxonomy.ts:18,5,4). Internal errors actually use short `"internal"` (bomcp/tool-handler.ts); HTTP uses `"not_found"` (http/errors.ts:41, not even in taxonomy). No pagination code exists → invalid_limit/cursor unreachable. No SPEC/TODO intent signal.
Action: wire `"internal"`→`internal_error` + add list/cursor validation, or drop from taxonomy. Confidence: tier-high, N=3. Not-verified: whether pagination is a planned wave.

### L-0703 · ORPHAN · 2 BomcpMessageKind union members never emitted or handled · open
What: `artifact.superseded` & `progress.usage` (events/types.ts:14,18) appear only in the typedef — no producer, no consumer, no SPEC/TODO mention. Action: emit/handle or remove. Confidence: tier-high, N=2.

### L-0704 · WIRING · `provider.artifact.upsert` has a consumer + test producer but NO live adapter producer · verify-at-commit
What: ProviderEvent variant (adapters/types.ts:68) consumed at provider-collector.ts:68, produced only by test fixtures.ts:79 — neither claude nor codex parser yields it. Intent signal FOUND: TODO.md:8 "Wave 3: provider artifact upserts made authoritative" → expected to land later, not a defect now.
Action: none now; expect a parser producer in Wave 3. Confidence: tier-high (intent-backed), N=1.

## Resolution log — implemented 2026-06-08 (Waves 7–10; verify GREEN: tsc clean + 113/113)

- **L-0201 — SEVERITY CORRECTED, then RESOLVED.** A focused production-shaped repro (createIpcServer + createIpcClient) proved the gateway does **not** crash: `callTool` rejects with the precise reason and the server conn's `read ECONNRESET` is caught by the existing `conn.on("error")` (ipc-channel.ts:45). The uncaught exception was a **test-harness gap** — the test's bare `net.createServer` lacked an `'error'` handler. Downgraded HIGH→LOW. Fixes: all `destroy(error)` → `destroy()` (drops a redundant error emission; pending callers already rejected); test server now handles `'error'`; oversized-frame test green.
- **L-0301/0302 — RESOLVED.** Canonical `ReasoningTier` enum (types/api.ts) + edge validation (validate.ts, fail-loud) + **total** per-adapter map (claude omits `--effort` for `none`; codex `none→none`). Regression: `tiers×backends` table tests.
- **L-0303 — RESOLVED.** Codex now writes the schema to `run_dir/output-schema.json` + `--output-schema <path>`. Capability gate was already load-bearing (validateCliAgentCompatibility) — descriptor flag is now honest. Regression test added.
- **L-0305 — RESOLVED.** `spawn(detached:true)` + `process.kill(-pid, …)` group escalation (Unix-only, documented).
- **L-0602 — RESOLVED.** `scope` plumbed through Layer 0/1 normalize, containment-checked, documented as cwd-narrowing ≠ sandbox.
- **L-0401 — RESOLVED.** `MAX_ATTACHMENT_CONTENT_BYTES` (1 MiB) + `MAX_TOTAL_INLINE_BYTES` (4 MiB), env-overridable, enforced in validate (covers in-process path).
- **L-0603 — RESOLVED.** `SyncRunResult.handoffs` + `buildSyncResult` case + CLI render.
- **L-0604 — RESOLVED (doc).** Sync-cancel = disconnect, documented; no side channel built.
- **L-0304 — RESOLVED.** Codex default `gpt-5` → `gpt-5.5`; cli-args example aligned.
- **L-0702 — RESOLVED (refined).** `internal_error` wired at its real site (execution-manager.ts:135); `invalid_limit`/`invalid_cursor` deleted. `not_found` deliberately **kept as an HTTP-layer code**, NOT folded into the execution `ErrorCode` taxonomy — different layer; folding would mix concerns (first-principles correction to the original decision).
- **L-0703 / L-0701 / L-0504 — RESOLVED.** Dead `artifact.superseded`/`progress.usage` kinds removed; `src/providers/` removed; dead `initGitRepo` removed.
- **L-0704 — OPEN (verify-at-commit).** Intent-backed Wave-3 producer; confirm at clean commit. No code change.
- **Wave 10.** Runtime pinned (`.nvmrc` 24 + `engines: >=24`); Biome config + `lint`/`format` scripts + CI matrix (node 24/25). Tests added: tier×backends (×2), codex `--output-schema`, IPC connect-refused. **STILL OPEN:** adapter-throws-still-releases-admission (the L-0103 guard) and a UTF-8 boundary property test; and the next audit pass (`perf` + C7 schema-validation). Biome config is unvalidated locally (not installed); first CI run may surface lint/format nits to clean up.

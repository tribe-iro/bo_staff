# bo_staff — Audit MAP

> Cache, not truth. Code wins. Every line cites `file:line`. Regenerate on conflict.

## Pass header (current)
- **ref**: `d579fdb` — "Refactor bo_staff runtime and expand integration coverage" ⚠️ *Refactor commit*
- **tree**: **DIRTY / mid-refactor** — 53 modified, 2 deleted, 12 untracked → all findings this pass are `verify-at-commit`; **no green verdict permitted**
- **runtime-vs-pin**: Node **v25.1.0**, **unpinned** (no `.nvmrc`, no `engines`); README floor "24+". Running *ahead* of documented floor → test failures are `runtime-suspect` until re-run on a pinned 24.x
- **build**: **GREEN** (`tsc --noEmit` clean)
- **tests**: **108 / 109** (`node --test test/contract/*.test.ts`); 1 fail → `bomcp-ipc.test.ts:238 IPC client rejects oversized response frames` → `read ECONNRESET`
- **scale**: ~10K LOC src → **fits in context** (MAP is lightweight; cells loaded whole by analyzers)
- **Last full pass**: COLD START 2026-06-08 @ d579fdb (dirty)

## Cells (concern × files)
| Cell | Concern | Key files | LOC | Verdict |
|------|---------|-----------|-----|---------|
| C1 http-ingress | HTTP routing, NDJSON streaming, request errors | `src/http/router.ts`, `src/http/handlers/{run,executions,health}.ts`, `src/http/streaming/{ndjson,execution-stream}.ts`, `src/http/errors.ts` | 470 | ? |
| C2 gateway-normalize | Layered request normalization + validation → `NormalizedExecutionRequest` | `src/gateway.ts`, `src/create-gateway.ts`, `src/api/{normalize,sync-response,backend-detect,tool-names,index}.ts`, `src/validation/{validate,normalize,shared,summary,bomcp-params}.ts`, `src/validation.ts` | 1300 | ? |
| C3 engine-execution | Execution orchestration, admission, finalization, state, provider collection/policy, prompt build | `src/engine/{execution-manager,execution-admission,execution-finalization,execution-state,provider-collector,provider-policy,workspace-manager,prompt,prompt-envelope,prompt-attachments,event-projection,types}.ts` | 1246 | ? |
| C4 adapters-cli | claude/codex CLI arg-building, spawn, output parsing | `src/adapters/{process,shared,descriptors,supported,types}.ts`, `src/adapters/claude/*`, `src/adapters/codex/*` | 626 | ? |
| C5 bomcp | BO-MCP server, Unix-socket IPC, JSON-RPC, lease enforcement, tool handling, controller stream | `src/bomcp/{index,server,ipc-channel,jsonrpc,tool-handler,lease,controller-stream,envelope-builder,output,types}.ts` | 1370 | ? |
| C6 workspace-scope | Path containment, scope resolution, workspace/artifact/lease core | `src/workspace/scope.ts`, `src/core/{workspace,artifact,lease,execution,identifiers,index}.ts` | 137 | ? |
| C7 schema-validation | JSON-schema validation, JSON extraction, public types | `src/schema/validator.ts`, `src/json/extract.ts`, `src/types/{schema,api}.ts`, `src/types.ts` | 626 | ? |
| C8 cli-client | `bo` CLI + arg parse + render, HTTP client, server bootstrap | `src/cli.ts`, `src/cli-args.ts`, `src/cli-render.ts`, `src/client.ts`, `src/server.ts` | ~700 | ? |
| C9 errors-taxonomy | Error codes/categories, envelope construction, internal reporting | `src/errors/taxonomy.ts`, `src/runtime/error-envelope.ts`, `src/internal-reporting.ts`, `src/errors.ts` | ~100 | ? |
| C10 testing-harness | Contract tests + integration scenarios/fakes | `test/contract/*.test.ts`, `src/testing/integration/**` | 2376 | ? |

## Seams (cross-cell edges — producer → consumer)
| Seam | Edge | Spans | Status |
|------|------|-------|--------|
| S1 request-contract | layered req → `NormalizedExecutionRequest` | C1→C2→C3 | ? |
| S2 adapter-event-protocol | `AdapterEvent` stream → projection | C4→C3 (provider-collector, event-projection) | ? |
| S3 bomcp-lease-ipc | lease + ipc-server config → socket → tool dispatch; bomcp injected as CLI MCP server | C3↔C5↔C4 | ? |
| S4 workspace-scope | scope validation → run dir → CLI cwd | C2→C6→C3→C4 | ? |
| S5 error-taxonomy | code/category → HTTP body + stream envelope | C9→C1, C9→C5 | ? |
| S6 terminal-event | finalization → controller stream → NDJSON (exactly-one-terminal invariant) | C3→C5→C1 | ? |
| S7 continuation | `session_id`/`thread_id` parse → sync-response; backend-match validation | C4→C2 | ? |
| S8 cli-flag-mapping | `execution_profile` (model/effort/tool-policy/output-schema) → `buildExecArgs` → real claude/codex CLI | C3→C4→(external CLI) | ? **known-suspect (currency)** |

## Whole-system verdict snapshot
- **Date/ref**: 2026-06-08 @ `d579fdb` (cold-start full pass)
- **Stamp**: tree **DIRTY** (53M/2D/12??, mid-refactor) · build **GREEN** (tsc) · tests **108/109** (1 real defect) · Node **v25 unpinned** (floor 24+) → **no green verdict permitted; provisional, re-baseline at commit**
- **Verdict (provisional)**: The architecture is **real and coherently wired** — the security spine (workspace path containment C6, BO-MCP lease choke point C5) is *adversarially-verified sound*, the exactly-one-terminal-event invariant *holds*, and the test suite is ~97% substantive. Three prior-review fears (admission-leak, cancel/complete double-terminal, teardown data-loss) were **refuted**. The damage is concentrated at **one seam: S8 cli-flag-mapping (C4 adapters)** — reasoning-tier values reach the real CLIs untranslated (Codex hard-crashes, Claude rejects) and Codex structured-output uses a non-existent config key (silently unenforced). Plus one **process-level crash-DoS** in the IPC layer (L-0201). None of these is architectural; all are localized, well-evidenced fixes.
- **Cell verdicts**: C1 http WIRED (1 low risk) · C2 gateway SOUND (1 THIN) · C3 engine WIRED (3 claims refuted) · **C4 adapters RED — S8 broken** · C5 bomcp WIRED (1 crash-DoS) · C6 scope SOUND (adv-verified) · C9 errors 3 dead codes · C10 tests STRONG (~97%)
- **Coverage line (probed / NOT probed)**: PROBED — wiring (C1/C3/W1), correctness (C1/C2/C3/C4), security (C2/C5/C6), test-integrity (C10), scenario (system-wide), full wiring sweep. **NOT probed this pass** — `perf` (zero cells), `expressiveness` (zero cells), C7 schema-validation (no dedicated analyzer), C8 cli-client & C9 errors (only incidental), security lens on C3/C4, live real-CLI integration runner (only flag-currency probed directly). The 108 passing tests are `runtime-suspect` (not re-run on pinned 24.x).

## Seam status (post-pass)
S1 SOUND · S2 wired (1 intent-backed half-wire L-0704) · S3 lease-choke SOUND / IPC crash L-0201 · S4 SOUND (cosmetic L-0007) · S5 3 dead codes L-0702 · S6 invariant HOLDS (adv-verified) · S7 SOUND · **S8 BROKEN 3-of-5 (L-0301/0302/0303)**

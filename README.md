# bo_staff

`bo_staff` is a governed execution substrate for local Codex and Claude runtimes. It provides a single HTTP API that abstracts backend differences, manages sessions, enforces workspace isolation, and reports execution outcomes with explicit capability guarantees and degradation.

## Prerequisites

- Node.js 24+
- `npm` for installing package dependencies
- at least one supported backend CLI installed, on `PATH`, and already authenticated:
  - `codex`
  - `claude`
- `git` if you want `git_isolated` workspaces
- `bash` if you want to run `npm run test:integration`

## Quick start

```bash
npm install
npm start
```

The server listens on `http://127.0.0.1:3000` by default.

`npm install` only installs the Node.js dependencies for `bo_staff` itself. It does not install the `codex` or `claude` CLIs.

Run a one-shot execution:

```bash
curl -s http://127.0.0.1:3000/executions \
  -H 'content-type: application/json' \
  -d '{"backend":"codex","task":{"prompt":"Return a short greeting."}}'
```

Or use the CLI:

```bash
npm run cli -- --backend codex "Return a short greeting."
```

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BO_STAFF_DATA_DIR` | `.bo_staff` in cwd | Persistence, worktrees, and runtime directory |
| `BO_STAFF_PROFILES_FILE` | `config/provider-profiles.yaml` | Execution profile config path |
| `BO_STAFF_MAX_BODY_BYTES` | `1048576` (1 MB) | Maximum request body size |
| `BO_STAFF_MAX_CONCURRENT_EXECUTIONS` | `8` | Concurrent execution limit |
| `HOST` | `127.0.0.1` | Bind host |
| `PORT` | `3000` | Bind port |

## HTTP API

### Executions

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/executions` | Execute and return the full response |
| `POST` | `/executions/stream` | Execute with NDJSON event streaming |
| `GET` | `/executions/:id` | Retrieve a stored execution response |
| `GET` | `/executions/:id/events` | Retrieve execution event history |
| `POST` | `/executions/:id/cancel` | Cancel a running execution |

### Sessions

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/sessions` | List sessions (paginated) |
| `GET` | `/sessions/:handle` | Get session details |
| `DELETE` | `/sessions/:handle` | Delete session and associated resources |

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Server health and runtime availability |

## Request shape

Every execution request is a JSON object sent to `POST /executions` or `POST /executions/stream`. Only `backend` and `task.prompt` are required; everything else has sensible defaults.

```typescript
{
  backend: "codex" | "claude",               // required
  task: {
    prompt: string,                          // required
    objective?: string,
    context?: Record<string, unknown>,
    attachments?: AttachmentInput[],
    constraints?: string[]
  },
  session?: {
    mode?: "new" | "continue" | "fork" | "ephemeral",
    handle?: string | null
  },
  workspace?: {
    source_root: string,                     // absolute path
    scope?: { mode?: "full" | "subpath", subpath?: string },
    writeback?: "apply" | "discard"
  },
  execution_profile?: {
    performance_tier?: "fast" | "balanced" | "high" | "frontier",
    reasoning_tier?: "none" | "light" | "standard" | "deep",
    selection_mode?: "managed" | "pinned" | "override",
    pin?: string,
    override?: string
  },
  runtime?: {
    timeout_ms?: number
  },
  policy?: {
    isolation?: "default" | "require_workspace_isolation",
    approvals?: "default" | "forbid_interactive_approvals",
    filesystem?: "default" | "read_only" | "workspace_write" | "full_access"
  },
  output?: {
    format?: "message" | "custom",
    schema?: JsonSchema
  },
  hints?: Record<string, unknown>,
  metadata?: Record<string, unknown>
}
```

## Examples

### Minimal execution

The simplest possible request. Uses default session mode (`new`), default workspace (ephemeral), default output format (`message`), and framework-managed model selection.

```bash
curl -s http://127.0.0.1:3000/executions \
  -H 'content-type: application/json' \
  -d '{
    "backend": "codex",
    "task": { "prompt": "Return a short greeting in payload.content." }
  }'
```

### Execution against a workspace

Point `source_root` at a project directory. The backend runs with that directory as its working directory.

```bash
curl -s http://127.0.0.1:3000/executions \
  -H 'content-type: application/json' \
  -d '{
    "backend": "claude",
    "task": {
      "prompt": "List the exported functions in src/utils.ts."
    },
    "workspace": {
      "source_root": "/home/user/projects/my-app"
    },
    "policy": {
      "filesystem": "read_only"
    }
  }'
```

### Isolated workspace with git writeback

When `policy.isolation` is `require_workspace_isolation`, bo_staff creates a detached git worktree, runs the backend inside it, and materializes changes back to the source repository when the execution completes.

```bash
curl -s http://127.0.0.1:3000/executions \
  -H 'content-type: application/json' \
  -d '{
    "backend": "codex",
    "task": {
      "prompt": "Add input validation to the createUser function.",
      "objective": "Harden the user creation endpoint against malformed input."
    },
    "workspace": {
      "source_root": "/home/user/projects/my-app",
      "writeback": "apply"
    },
    "policy": {
      "isolation": "require_workspace_isolation",
      "filesystem": "workspace_write"
    }
  }'
```

To preview changes without applying them, set `"writeback": "discard"`.

### Structured output with a custom schema

Use `output.format: "custom"` with a JSON Schema to get structured payloads. The schema is required for custom format.

```bash
curl -s http://127.0.0.1:3000/executions \
  -H 'content-type: application/json' \
  -d '{
    "backend": "codex",
    "task": {
      "prompt": "Analyze the repository structure and return a project summary."
    },
    "workspace": {
      "source_root": "/home/user/projects/my-app"
    },
    "output": {
      "format": "custom",
      "schema": {
        "type": "object",
        "required": ["name", "language", "entry_points"],
        "additionalProperties": false,
        "properties": {
          "name": { "type": "string" },
          "language": { "type": "string" },
          "entry_points": {
            "type": "array",
            "items": { "type": "string" }
          }
        }
      }
    }
  }'
```

For message format (the default), `output.schema` is optional and defaults to `{ type: "object", required: ["content"], properties: { content: { type: "string" } } }`.

### Task with objective, constraints, and attachments

The `task` object supports additional fields that structure the prompt context.

```bash
curl -s http://127.0.0.1:3000/executions \
  -H 'content-type: application/json' \
  -d '{
    "backend": "claude",
    "task": {
      "prompt": "Refactor the database module to use connection pooling.",
      "objective": "Improve connection reuse without changing the public API.",
      "constraints": [
        "Do not add new dependencies.",
        "Preserve all existing tests."
      ],
      "attachments": [
        {
          "name": "current-db-module",
          "path": "src/db.ts"
        },
        {
          "name": "style-guide",
          "content": "Use async/await. No callbacks. 2-space indentation.",
          "mime_type": "text/plain"
        }
      ]
    },
    "workspace": {
      "source_root": "/home/user/projects/my-app"
    },
    "policy": {
      "filesystem": "workspace_write"
    }
  }'
```

Attachments with `path` are resolved relative to the workspace scope root and must stay within it. Attachments with `content` are passed inline.

## Session modes

Sessions control execution continuity. The session mode determines how bo_staff handles state across executions.

### `new` (default)

Creates a new persistent session. The returned `session.handle` can be used for subsequent `continue` or `fork` operations.

```json
{ "session": { "mode": "new" } }
```

### `ephemeral`

No session state is persisted. The execution runs in isolation with no continuation capability. The response has `session.handle: null`.

```json
{ "session": { "mode": "ephemeral" } }
```

### `continue`

Resumes an existing session. If the backend, workspace, and topology match the original session, bo_staff uses **native provider continuation** (the provider's own session/thread resume). Otherwise, it falls back to **managed continuation** using a framework-owned continuation capsule.

```json
{
  "session": {
    "mode": "continue",
    "handle": "sess_a1b2c3d4e5f6..."
  }
}
```

### `fork`

Creates a new session branched from an existing one. The new session inherits the continuation capsule from the parent but has its own handle and independent lifecycle. Always uses managed continuation.

```json
{
  "session": {
    "mode": "fork",
    "handle": "sess_a1b2c3d4e5f6..."
  }
}
```

## Execution profiles

Execution profiles control model selection. bo_staff resolves a concrete backend model from the requested performance and reasoning tiers.

### `managed` (default)

Framework-managed model resolution. The `performance_tier` and `reasoning_tier` are mapped to provider-specific models via `config/provider-profiles.yaml`.

```json
{
  "execution_profile": {
    "selection_mode": "managed",
    "performance_tier": "high",
    "reasoning_tier": "deep"
  }
}
```

| Performance tier | Default timeout | Description |
|-----------------|-----------------|-------------|
| `fast` | 60s | Quick tasks, lower-cost models |
| `balanced` | 120s | General-purpose (default) |
| `high` | 300s | Complex tasks, stronger models |
| `frontier` | 600s | Maximum capability models |

| Reasoning tier | Description |
|---------------|-------------|
| `none` | No reasoning control |
| `light` | Low reasoning effort |
| `standard` | Medium reasoning effort (default) |
| `deep` | High reasoning effort |

### `pinned`

Uses a dated snapshot of the model mapping. Requires `execution_profile.pin` set to a date key defined in the profiles config.

```json
{
  "execution_profile": {
    "selection_mode": "pinned",
    "pin": "2026-03-14"
  }
}
```

### `override`

Bypasses profile resolution and sends a specific model identifier to the backend. Explicitly unstable; the model identifier is passed directly to the CLI.

```json
{
  "execution_profile": {
    "selection_mode": "override",
    "override": "gpt-5-codex"
  }
}
```

## Policy

The `policy` object is the only public normative control plane. Workspace topology and sandbox mode are derived from policy, not set directly.

### `policy.filesystem`

| Value | Sandbox | Description |
|-------|---------|-------------|
| `default` | `read-only` | Default sandbox (read-only) |
| `read_only` | `read-only` | Explicit read-only sandbox |
| `workspace_write` | `workspace-write` | Backend can write within the workspace |
| `full_access` | `danger-full-access` | Unrestricted filesystem access |

### `policy.isolation`

| Value | Topology | Description |
|-------|----------|-------------|
| `default` | `direct` | Backend runs directly in the source root |
| `require_workspace_isolation` | `git_isolated` | Backend runs in a detached git worktree |

### `policy.approvals`

| Value | Description |
|-------|-------------|
| `default` | Backend-specific default approval behavior |
| `forbid_interactive_approvals` | Disables interactive approval prompts |

## Streaming

`POST /executions/stream` returns an NDJSON event stream. HTTP 200 means the stream is established; the **terminal event** (not the HTTP status) is the authoritative execution outcome.

```bash
curl -sN http://127.0.0.1:3000/executions/stream \
  -H 'content-type: application/json' \
  -d '{
    "backend": "codex",
    "task": { "prompt": "Return a short greeting." },
    "session": { "mode": "ephemeral" }
  }'
```

Event types in stream order:

| Event | Description |
|-------|-------------|
| `execution.accepted` | Execution admitted |
| `execution.started` | Backend dispatch started |
| `execution.progress_initialized` | Workspace and runtime ready |
| `execution.progressed` | Incremental progress (output chunks, status) |
| `control_gate.requested` | Backend requested approval |
| `control_gate.resolved` | Approval resolved |
| `artifact.produced` | Artifact cataloged |
| `execution.completed` | Execution succeeded |
| `execution.failed` | Execution failed |
| `execution.rejected` | Execution rejected before dispatch |
| `execution.snapshot` | Terminal response snapshot |

If the client disconnects before the stream completes, bo_staff cancels the running execution.

## Response shape

Every execution response includes:

```typescript
{
  api_version: "v0.1",
  request_id: string,
  execution: {
    execution_id: string | null,
    status: "accepted" | "running" | "completed" | "partial"
          | "awaiting_control_gate" | "failed" | "rejected",
    terminal: boolean,
    degraded: boolean,
    retryable: boolean,
    started_at: string,
    updated_at: string,
    completed_at?: string,
    progress_state?: "running" | "waiting_for_control_gate" | "finished"
  },
  persistence: {
    status: "persisted" | "failed" | "not_attempted",
    reason?: string
  },
  execution_profile: { ... },
  session: {
    handle: string | null,
    continued_from?: string,
    forked_from?: string,
    continuity_kind: "native" | "managed" | "none",
    durability_kind: "persistent" | "ephemeral"
  },
  workspace: {
    topology: "direct" | "git_isolated",
    scope_status: "enforced" | "unbounded",
    writeback_status: "applied" | "discarded" | "degraded"
                    | "not_requested" | "skipped",
    materialization_status: "materialized" | "skipped" | "failed"
                          | "not_requested",
    diagnostics?: { ... }
  },
  capabilities: Record<CapabilityName, { status, reason? }>,
  result: {
    summary: string,
    payload: unknown,
    pending_items: string[]
  },
  artifacts: ArtifactRecord[],
  control_gates: { pending: [...], resolved: [...] },
  usage?: { duration_ms?, input_tokens?, output_tokens? },
  errors: ExecutionError[],
  debug?: { capability_diagnostics?: ... }
}
```

Key fields:

- `execution.status` is the authoritative outcome
- `execution.degraded` is true when any capability was degraded or workspace materialization had issues
- `persistence.status` tells you whether the execution state was durably committed; `"failed"` means the execution result is correct but may not survive a server restart
- `result.payload` conforms to your `output.schema`
- `capabilities` reports per-capability satisfaction/degradation with reason strings

## CLI

```bash
npm run cli -- [options] "prompt"
```

| Flag | Description |
|------|-------------|
| `--backend codex\|claude` | Backend (default: `codex`) |
| `--sandbox read-only\|workspace-write\|danger-full-access` | Filesystem policy |
| `--model <id>` | Override model (sets `selection_mode=override`) |
| `--dir <path>` | Workspace directory (default: cwd) |
| `--timeout-ms <ms>` | Execution timeout |
| `--url <url>` | Server URL (default: `http://127.0.0.1:3000`) |
| `--json` | Print full JSON response |
| `--help` | Show usage |

Examples:

```bash
# Simple greeting
npm run cli -- "Return a short greeting."

# Claude with read-only workspace
npm run cli -- --backend claude --sandbox read-only "Explain the main entry point."

# Specific model override
npm run cli -- --model gpt-5.4 "Summarize this project."

# Full JSON output
npm run cli -- --json --backend claude "List the public exports."
```

## TypeScript client

`bo_staff` ships a typed client at `src/client.ts`:

```typescript
import { BoStaffClient } from "./client.ts";

const client = new BoStaffClient({ baseUrl: "http://127.0.0.1:3000" });

// One-shot execution
const response = await client.execute({
  backend: "codex",
  task: { prompt: "Return a greeting." }
});
console.log(response.result.payload);

// Streaming execution
for await (const event of client.executeStream({
  backend: "codex",
  task: { prompt: "Explain the codebase." },
  session: { mode: "ephemeral" }
})) {
  console.log(event.event, event.data);
}

// Session management
const sessions = await client.listSessions({ limit: 10 });
const session = await client.getSession("sess_abc123");
await client.deleteSession("sess_abc123");

// Execution inspection
const execution = await client.getExecution("exec_abc123");
const events = await client.getExecutionEvents("exec_abc123");
await client.cancelExecution("exec_abc123");
```

## Semantics

- Workspace topology (`direct` vs `git_isolated`) is derived from `policy.isolation`, not set directly.
- Sandbox mode (`read-only`, `workspace-write`, `danger-full-access`) is derived from `policy.filesystem`.
- Capability outcomes are descriptive runtime facts; advanced conformance diagnostics are in `debug.capability_diagnostics`.
- Degradation is explicit. Enforcement-class guarantees report their status honestly rather than silently faking compliance.
- Claude sandbox mapping is approximate: `policy_enforcement` degrades when bo_staff cannot faithfully represent the requested sandbox through the Claude CLI permission surface.
- Claude managed performance tiers are partially aliased: `fast` maps to `balanced`, and `high` maps to `frontier` at the provider layer.
- Managed continuation persists a bounded framework-owned capsule, not raw prior payload replay. Cross-backend continuation always uses managed mode.
- `persistence.status=failed` means the execution completed correctly but state may not survive a server restart. Callers should treat the response as authoritative regardless of persistence status.

## Verification

```bash
npm run typecheck
npm test
```

## Integration tests

Run the live provider-backed suite against installed `codex` and `claude` CLIs:

```bash
npm run test:integration
```

Coverage includes:

- managed, pinned, and override execution-profile resolution
- `none` and `deep` reasoning tiers
- structured outputs and planning-style payloads
- task `objective`, `constraints`, and `attachments`
- instruction discovery from `AGENTS.md` and `CLAUDE.md`
- native continuation, same-backend `fork`, and cross-backend managed continuation
- direct workspace writes
- `git_isolated` writeback with both `apply` and `discard`
- session deletion cleanup
- non-git isolated rejection
- successful and rejected NDJSON execution streams

Environment variables for integration:

| Variable | Description |
|----------|-------------|
| `BO_STAFF_IT_AGENTS` | `codex`, `claude`, or `codex,claude` |
| `BO_STAFF_IT_SCENARIOS` | Comma-separated scenario filter (e.g., `codex.profile,claude.task.planning`) |
| `BO_STAFF_IT_KEEP` | `1` to keep temp directories |
| `BO_STAFF_IT_PAUSE_SEC` | Pause between scenarios (default: `2`) |
| `BO_STAFF_IT_SHOW_FULL_JSON` | `1` to show full JSON responses |

Timeout stress scenarios (`codex.runtime.timeout`, `claude.runtime.timeout`) are excluded from the default matrix and only run when explicitly selected via `BO_STAFF_IT_SCENARIOS`.

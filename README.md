# bo_staff

bo_staff is a stateless control bridge for running Codex and Claude against a local workspace through one HTTP API.

It provides:
- one public surface across Codex and Claude
- one live event stream out while an execution is running
- one execution-scoped BO-MCP surface for progress, artifacts, and handoff signals
- direct execution in a caller-provided workspace
- optional opaque backend continuation passthrough
- one trust boundary owned by bo_staff rather than provider-specific sandbox prompts

It does not:
- create git worktrees or sandboxes
- apply or discard repository changes
- manage durable sessions
- persist execution state after the process exits

## Quick Start

```bash
npm install
npm start
```

```bash
bo "fix the failing tests"
```

```text
Status: completed

Output:
  Fixed two validation tests -- the expected error message
  had changed after the input sanitization refactor.
```

## Prerequisites

- Node.js 24+
- At least one supported backend CLI installed and authenticated:
  - `claude`
  - `codex`

## CLI

```bash
bo <prompt> [flags]
```

The workspace defaults to the current directory.

| Flag | Description |
|------|-------------|
| `-b, --backend <name>` | Backend: `claude` or `codex`. Auto-detected if omitted. |
| `-m, --model <id>` | Model ID. Defaults per backend. |
| `-w, --workspace <path>` | Workspace directory. Defaults to cwd. |
| `-t, --timeout <seconds>` | Execution timeout. Default: 600. |
| `--reasoning <tier>` | Reasoning tier: `none`, `light`, `standard`, `deep`. |
| `--stream` | Stream NDJSON events instead of waiting for the sync result. |
| `--json` | Print JSON. |
| `--verbose` | Include full event history in sync output, or print all stream events. |
| `--url <url>` | Gateway URL. Default: `http://127.0.0.1:3000`. |

Examples:

```bash
bo "fix the failing tests"
bo "add input validation" --backend codex
bo "analyze codebase" --stream --verbose
```

## Public HTTP API

### `POST /run`

Layer 0/1 entrypoint. Send a prompt and get back a compact result.

Request:

```json
{
  "prompt": "fix the failing tests",
  "workspace": "/path/to/project"
}
```

Response:

```json
{
  "status": "completed",
  "output": "Fixed the failing validation tests by updating expected error messages.",
  "artifacts": [],
  "continuation": {
    "backend": "codex",
    "token": "opaque-backend-token"
  },
  "usage": {
    "input_tokens": 12000,
    "output_tokens": 850,
    "duration_ms": 47000
  },
  "execution_id": "exec_abc123"
}
```

Fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `prompt` | string | required | What the agent should do |
| `workspace` | string | cwd | Directory to run in |
| `backend` | string | auto | `claude` or `codex` |
| `model` | string | per backend | Model ID |
| `timeout` | number | 600 | Seconds before timeout |
| `reasoning` | string | `standard` | Reasoning tier |
| `stream` | boolean | false | If true, `POST /run` returns NDJSON |
| `verbose` | boolean | false | Include full event history in sync output |

Notes:
- bo_staff runs directly in the provided workspace.
- bo_staff does not create a git sandbox or compute a repository diff.
- Backend CLIs are launched with fully permissive provider-side permission modes.
- `continuation` is returned only when the backend exposes a resumable opaque token.

### BO-MCP

BO-MCP is an internal runtime protocol exposed to the agent during one execution. It is not a separate product surface.

The current BO-MCP tools are:

| Tool | Purpose |
|------|---------|
| `bomcp.progress.update` | Emit live progress for the caller stream |
| `bomcp.artifact.register` | Register an in-scope file the agent produced |
| `bomcp.artifact.require` | Check whether an in-scope file exists |
| `bomcp.control.handoff` | Emit a typed execution-scoped handoff signal such as `blocked`, `needs_input`, `continue_with_prompt`, or `completed` |

bo_staff does not maintain a pause/resume/input state machine between executions. The caller owns the workflow loop between runs.

Provider note:
- bo_staff keeps one cohesive trust boundary by running provider CLIs in their most permissive mode.
- Workspace scope, BO-MCP lease checks, request validation, and tool configuration are enforced by bo_staff.
- Do not treat provider-native sandbox modes as part of the bo_staff contract.

### `POST /run` with `"stream": true`

Returns NDJSON.

For admitted executions, the stream ends with exactly one terminal event:
- `execution.completed`
- `execution.failed`
- `execution.cancelled`

For preflight rejection before execution admission, the stream contains `system.error` only.

```bash
curl -sN http://127.0.0.1:3000/run \
  -H 'content-type: application/json' \
  -d '{ "prompt": "fix the tests", "workspace": ".", "stream": true }'
```

### Execution endpoints

These operate only on live executions.

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/executions/:id/cancel` | Cancel a running execution |
| `GET` | `/executions/:id` | Inspect active execution state |
| `GET` | `/health` | Health check |

## Advanced API

`POST /executions/stream` is the full Layer 2 execution API. Use it if you need:
- `continuation`
- `workspace.scope`
- `tool_configuration`
- `lease.allowed_tools`
- direct access to BO-MCP event streams

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `BO_STAFF_DATA_DIR` | `.bo_staff` in cwd | Runtime data directory |
| `BO_STAFF_MAX_BODY_BYTES` | `1048576` | Max request body size |
| `BO_STAFF_MAX_CONCURRENT_EXECUTIONS` | `8` | Max concurrent executions |
| `BO_DEFAULT_BACKEND` | auto | Default backend when multiple are available |
| `HOST` | `127.0.0.1` | Bind host |
| `PORT` | `3000` | Bind port |

## Verification

- `npm run verify` runs `tsc --noEmit` and the contract test suite in `test/contract`.
- `npm run verify` is not full CLI-backed end-to-end coverage.
- Use `npm run test:integration` to run the integration smoke suite against installed and authenticated backends.

## Internals

For the internal runtime architecture, see [SPEC.md](./SPEC.md).

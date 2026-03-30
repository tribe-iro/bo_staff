# bo_staff Technical Specification

This document describes the internal runtime architecture of bo_staff as it exists now.

Public API behavior belongs in [README.md](./README.md). BO-MCP runtime behavior is described here as part of the bo_staff internal architecture.

## Purpose

bo_staff is a stateless execution gateway for local Codex and Claude runtimes.

Its job is to:
- normalize incoming requests into one internal execution shape
- run one agent execution against one workspace
- expose BO-MCP execution tooling during that execution
- stream runtime events back to the connected controller
- act as the single trust boundary above provider CLIs

BO-MCP is not documented as a separate product-level protocol anymore. In bo_staff, it is an internal execution/control surface owned by this runtime.

## Current Channel Usage

The current codebase exposes multiple practical channels into and out of an execution.

Inbound channels used by the runtime today:
- prompt envelope built by bo_staff
- workspace files and attachments referenced by the prompt
- MCP tools available during execution

Outbound channels observable in the runtime today:
- final response content emitted in terminal execution events
- workspace file writes performed by the agent
- caller-provided MCP side effects outside bo_staff's core result contract
- BO-MCP tool calls for handoff signals, artifact notices, and progress

Current implementation notes:
- bo_staff treats BO-MCP as an execution-scoped signaling surface, not as the primary answer payload
- BO-MCP artifact events are runtime notices about artifacts; the durable artifact itself remains outside the event stream
- opaque backend continuation is caller-owned input and backend-owned output; bo_staff only passes it through during a live execution

Its job is not to:
- manage git-backed workspace isolation
- apply or discard repository changes
- provide durable persistence after process exit
- orchestrate multi-agent workflows

## Runtime Model

bo_staff has one active runtime path:
- caller-provided workspace: run directly in that directory or a scoped subdirectory
- no workspace provided: create an ephemeral temporary directory for the execution

There is no framework-owned git worktree path anymore.

## Main Components

- [src/server.ts](/home/tribeiro/Projects/bo_staff/src/server.ts): process startup and HTTP server
- [src/http/router.ts](/home/tribeiro/Projects/bo_staff/src/http/router.ts): route dispatch
- [src/gateway.ts](/home/tribeiro/Projects/bo_staff/src/gateway.ts): request normalization and execution dispatch
- [src/engine/execution-manager.ts](/home/tribeiro/Projects/bo_staff/src/engine/execution-manager.ts): execution orchestration
- [src/engine/workspace-manager.ts](/home/tribeiro/Projects/bo_staff/src/engine/workspace-manager.ts): direct workspace preparation and cleanup
- [src/engine/execution-finalization.ts](/home/tribeiro/Projects/bo_staff/src/engine/execution-finalization.ts): terminal event emission and cleanup
- [src/bomcp/](/home/tribeiro/Projects/bo_staff/src/bomcp): BO-MCP envelopes, IPC bridge, lease enforcement, tool handling
- [src/adapters/](/home/tribeiro/Projects/bo_staff/src/adapters): backend-specific CLI adapters

## Request Lifecycle

### 1. HTTP ingress

The main execution endpoints are:
- `POST /run`
- `POST /executions/stream`

`POST /run` is the compact/public entrypoint.

`POST /executions/stream` is the authoritative internal execution path. It establishes an NDJSON stream and forwards the normalized request to the gateway.

### 2. Normalization and validation

[src/api/normalize.ts](/home/tribeiro/Projects/bo_staff/src/api/normalize.ts) handles layered request shapes.

[src/validation.ts](/home/tribeiro/Projects/bo_staff/src/validation.ts) produces a `NormalizedExecutionRequest`.

Important current rules:
- workspace execution is direct-only
- removed isolation fields are rejected
- `workspace.source_root` must be an absolute readable directory when provided
- `workspace.scope.subpath` must stay within `workspace.source_root`
- attachment paths must stay within the effective workspace scope
- `lease.allowed_tools` is validated against BO-MCP tool names
- removed public policy fields are rejected explicitly

### 3. Execution setup

[ExecutionManager](/home/tribeiro/Projects/bo_staff/src/engine/execution-manager.ts) performs:
1. admission control
2. lease creation
3. ephemeral execution-state creation
4. workspace preparation
5. prompt-envelope construction
6. IPC server startup for `bomcp-server`
7. backend adapter execution

### 4. Workspace preparation

[WorkspaceManager](/home/tribeiro/Projects/bo_staff/src/engine/workspace-manager.ts) has two cases:
- provided workspace: use the source root or resolved scoped subpath as `runtime_working_directory`
- ephemeral workspace: create a temporary execution-local directory

Cleanup removes only bo_staff-managed runtime directories. It never mutates or deletes the caller's workspace.

Provider permission model:
- provider CLIs are launched in their fully permissive mode
- bo_staff-owned validation, workspace scope, BO-MCP lease checks, tool configuration, and cancellation semantics are the governing runtime controls
- provider-native sandbox prompts are intentionally not part of the bo_staff contract

### 5. BO-MCP bridge

The executing agent talks to bo_staff through a per-execution `bomcp-server` process over a Unix domain socket.

[BomcpToolHandler](/home/tribeiro/Projects/bo_staff/src/bomcp/tool-handler.ts) currently handles:
- typed handoff signals
- artifact registration/lookup
- progress updates

Lease enforcement is performed before dispatch.

Current BO-MCP tool surface:
- `bomcp.control.handoff`
- `bomcp.artifact.register`
- `bomcp.artifact.require`
- `bomcp.progress.update`

Current handoff kinds:
- `blocked`
- `needs_input`
- `needs_approval`
- `retry`
- `fresh_context`
- `continue_with_node`
- `continue_with_prompt`
- `completed`

### 6. Finalization

[execution-finalization.ts](/home/tribeiro/Projects/bo_staff/src/engine/execution-finalization.ts) emits:
- `execution.completed` or `execution.failed`
- `execution.cancelled` when the execution is aborted after admission

Current finalization semantics:
- no git diff or materialization plan is computed
- no sandbox path is retained or emitted
- managed runtime directories are cleaned up immediately after terminal emission

## Continuation Passthrough

bo_staff does not own conversation continuity.

Current behavior:
- the caller may provide `continuation.backend` and `continuation.token`
- validation requires `continuation.backend` to match `request.backend`
- adapters pass the opaque token to the matching backend CLI when supported
- terminal completion events may surface a new opaque continuation token when the backend emits one
- bo_staff persists nothing before or after process exit

## Output Model

The compact sync response is built by [src/api/sync-response.ts](/home/tribeiro/Projects/bo_staff/src/api/sync-response.ts).

Current behavior:
- `output`, `artifacts`, `usage`, and `execution_id` are real runtime outputs
- `continuation` is surfaced only when a backend emits a resumable opaque token
- no git-derived sandbox or change plan is reported

## Live Execution Control

The public runtime control surface for an active execution is intentionally narrow:
- cancel
- inspect active execution state

bo_staff does not implement a pause/resume/input approval loop across executions. If an agent emits a handoff like `needs_input` or `needs_approval`, the caller decides what to do in the next execution.

## Known Internal Gaps

No open internal implementation gaps are tracked in this document right now.

The active backlog lives in [TODO.md](./TODO.md).

## Invariants

- one controller stream per execution
- controller disconnect cancels the active execution
- the `bomcp` MCP server namespace is reserved
- BO-MCP tool calls are validated against the execution lease before execution
- BO-MCP is execution-scoped and does not own durable workflow state across runs
- bo_staff never writes back to a git repository on the caller's behalf
- bo_staff holds no execution state after teardown beyond normal process-local memory still referenced by active code paths

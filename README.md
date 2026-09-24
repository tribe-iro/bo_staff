# bo

`bo` runs Claude Code and Codex against a local workspace through one HTTP service, one TypeScript client, one CLI, and one A2A binding.

## Start and use

```bash
npm install
npm start
```

`npm start` is exactly `bo serve`. In another terminal:

```bash
bo engines
bo run "fix the failing tests"
bo run -c "now the flaky one too"          # continue this directory's latest session
bo run --engine codex --model MODEL --effort high "review this repository"
bo run --skill ./skills/release --mcp ./mcp.json "prepare the release"
bo sessions
bo runs
bo follow run_...
bo cancel run_...
bo config
```

The service uses each engine CLI's existing login and acts with that operator's credentials. Subscription authentication is off by default. `BO_ALLOW_SUBSCRIPTION_AUTH=1` or `bo serve --allow-subscription-auth` is an operator opt-in for using their own subscription in a single-user setup; it does not grant permission to share an account, route other people's work through it, or resell provider usage. Whether a particular use is permitted depends on the account, plan, and deployment. For a shared or customer-facing service, use an appropriate API key, cloud provider, or business authentication arrangement, or obtain the provider's approval. Review [Anthropic's Claude Code legal guidance](https://code.claude.com/docs/en/legal-and-compliance), [Agent SDK guidance](https://code.claude.com/docs/en/agent-sdk/overview), and [OpenAI's Codex authentication guidance](https://developers.openai.com/codex/auth) and [terms](https://openai.com/policies/terms-of-use/).

A non-loopback listener requires a bearer token. Without a token, the server answers only requests whose `Host` is a loopback name (`127.0.0.1`, `localhost`, `[::1]`), so a web page cannot reach it through DNS rebinding (`403 forbidden_host`). A bo bearer token controls access to the service; it does not give each caller a separate engine account.

```bash
bo serve --host 127.0.0.1 --port 3000 --max-runs 8 --default-engine claude-code
bo serve --host 0.0.0.0 --token "$BO_TOKEN"
```

Server environment: `HOST`, `PORT`, `BO_TOKEN`, `BO_MAX_RUNS`, `BO_DEFAULT_ENGINE`, `BO_PUBLIC_URL`, `BO_A2A_WORKSPACE`, and `BO_ALLOW_SUBSCRIPTION_AUTH`. `BO_*` variables are never passed to engine processes. `bo serve --allow-subscription-auth` is the same as `BO_ALLOW_SUBSCRIPTION_AUTH=1`.

`bo serve` prints each engine's state at startup, then one log line per run event (`started`, `completed`/`failed`/`cancelled` with time, model, tokens and cost). A failed run's line is followed by the engine's own diagnostic (error, stderr tail), with credentials redacted.

`bo serve -v` also logs each run's steps.

Client and CLI environment: `BO_URL` (default `http://127.0.0.1:3000`) and `BO_TOKEN`.

bo keeps its own directories: `${XDG_CONFIG_HOME:-~/.config}/bo/config.toml` (settings you write) and `${XDG_STATE_HOME:-~/.local/state}/bo/` (the session index and the Codex home). One server per state directory.

### config.toml

```toml
url = "http://127.0.0.1:3000"   # where the CLI finds the server

[run]            # defaults for new sessions of `bo run` and `bo acp`
engine = "codex" # engine, model and effort shape new sessions; a continued session keeps its own
model = "…"
effort = "high"
access = "write"
verbose = 1      # 0 answer only, 1 steps and summary, 2 reasoning and tool output

[serve]          # defaults for `bo serve`
host = "127.0.0.1"
port = 3000
max_runs = 8
default_engine = "claude-code"
allow_subscription_auth = true # operator opt-in; see subscription guidance above
```

Precedence is flag > environment > config.toml > built-in default. The token is never read from the file. Unknown keys and wrong types are errors that name the file and key. `bo config` prints every setting with its value and its source.

## CLI

```text
bo serve [--host HOST] [--port PORT] [--token TOKEN] [--max-runs N] [--default-engine ENGINE] [--allow-subscription-auth] [-v]
bo run [flags] [prompt...]
bo run -c [flags] [prompt...]
bo sessions [--all | --workspace DIR | --delete ID]
bo show [SESSION_ID]
bo runs
bo follow RUN_ID
bo cancel RUN_ID
bo engines
bo config
bo acp [--url URL] [--token TOKEN]
```

Run flags map directly to `RunSpec`: `--engine`, `--model`, `--effort`, `--instructions`, repeatable `--skill`, `--mcp`, `--subagents`, `--workspace`, repeatable `--extra-root`, `--access`, `--internet`/`--no-internet`, `--interactive`/`--no-interactive`, `--schema`, `-c`/`--continue`, `--session`, `--fork`, repeatable `--image`, `--timeout`, repeatable `--env NAME=value`, `--max-turns`, `--max-tokens`, and `--no-project-instructions`.

The workspace defaults to the current directory. A standalone `-` inserts stdin into the prompt; with no prompt words stdin is the prompt. `--` ends flag parsing, so later words beginning with `-` are prompt text. Interactive mode defaults from the terminal and is disabled when stdin supplies prompt content.

A run starts a new session unless you continue one: `-c` continues this directory's latest session (with `--engine`, its latest session on that engine), `--session <id|key>` any other (a key names a session in this directory, and starts one under that key when none exists yet), and `--fork` branches either. `bo sessions` lists this directory's sessions, newest first, with their token totals; `bo show` prints a session's runs (this directory's latest by default) as `bo run` rendered them, each under its prompt.

Output is quiet by default:

| | stdout | stderr |
|---|---|---|
| default, terminal | the agent's words, streamed | a status line that erases itself; approval prompts; failures and denied actions |
| default, piped | the answer, once | failures and denied actions only |
| `-v` | same | one line per step (`▸` action, `✗` failed, `⊘` denied and why, `plan 2/5 · step`, `!` notice), a summary line (model, time, tokens, cost), how to continue |
| `-vv` | same | also reasoning, tool output, subagent messages, run and session ids |
| `--json` | NDJSON events | nothing |

Errors start with `bo:` and end with what to do next. Colour is used only on a terminal and never with `NO_COLOR`. `--json` writes NDJSON events. Exit status is `0` for completion, `1` for a failed run, `2` for usage/API problems, and `130` for cancellation.

`--mcp`, `--subagents`, and `--schema` read canonical JSON objects from files. MCP configuration is intentionally structured rather than encoded in a shell mini-language.

## TypeScript client

```ts
import { Bo } from "./src/client.ts";

const bo = new Bo();
const run = await bo.run({
  input: "fix the failing tests",
  workspace: "/absolute/project",
  engine: "codex",
  model: "MODEL",
  effort: "high",
  skills: ["/absolute/project/skills/release"],
  mcp: {
    github: {
      command: "github-mcp-server",
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN! },
      tools: ["get_issue", "create_comment"],
    },
  },
});

const terminal = await run.done({
  onItem: async (item, handle) => {
    if (item.type === "action" && item.status === "awaiting_approval") {
      await handle.respond(item.id, { decision: "allow" });
    }
  },
});
```

The client exposes `bo.run(spec)`, `bo.engines()`, `bo.runs.get(id)`, `bo.runs.list()`, and `bo.sessions.list(workspace?)`. A `RunHandle` exposes `events()`, `done()`, `message()`, `respond()`, and `cancel()`. Client-only sugar permits `input` as a string and `workspace` as a string; every other field is identical to the wire contract.

## HTTP API

```text
GET    /v1/engines
POST   /v1/runs
GET    /v1/runs
GET    /v1/runs/{id}
GET    /v1/runs/{id}/events
GET    /v1/sessions[?workspace=ABSOLUTE_PATH]
GET    /v1/sessions/{id}
GET    /v1/sessions/{id}/runs
DELETE /v1/sessions/{id}
POST   /v1/runs/{id}/messages
POST   /v1/runs/{id}/items/{item}/response
POST   /v1/runs/{id}/cancel
```

`POST /v1/runs` returns `201`, a `Location` header, and the initial `Run`. `Idempotency-Key` is supported. Events use SSE and resume through `Last-Event-ID`; disconnecting does not cancel the run. `run` and `item` events carry ids; `delta` events (`{item_id, offset, text}`, text streamed into an item since its latest version) are not logged and carry none. Instead, every new connection gets each item's text so far as one delta at offset 0, and `offset` (in Unicode code points) says where a delta starts, so a resuming client appends only the part past what it has. The TypeScript client does this itself: its deltas come out exactly once.

### Contract

Every request and response shape is defined once, in `src/contract/schema.ts`, and published as
[`contract/bo.v1.schema.json`](contract/bo.v1.schema.json) (JSON Schema) and [`contract/openapi.json`](contract/openapi.json)
(OpenAPI 3.1); `npm run contract` regenerates them and a test keeps them current. Within `/v1`, changes are additive
only (new optional fields, item types, action kinds); clients ignore what they do not know. Anything else is `/v2`.
The server's own output is tested against the schemas.

A run spec:

```json
{
  "input": [{ "kind": "text", "text": "fix the failing tests" }],
  "workspace": { "root": "/home/me/project" },
  "engine": "codex",
  "effort": "high",
  "permissions": { "access": "write" },
  "limits": { "max_turns": 40 },
  "session": { "latest": true }
}
```


Defaults: engine is the server default; model and effort are engine defaults (`model` accepts a model id or one of its aliases; `effort` must be one of the selected model's `efforts`, or the default model's when `model` is omitted); access is `write`; internet is enabled only when access is `full`; interactive is false; project instructions are included; timeout is 1800 seconds. A session pins its engine and its workspace: an explicit conflicting engine is rejected, and so is continuing or forking a session from another workspace root (at `/session/id`). One run at a time holds a session (`session_busy` otherwise); a run that starts a session under a new key holds that key from the start. If another request creates the keyed session while this request is being prepared, the latter gets `session_busy` and can retry to continue it. `session.latest` continues the newest session of this workspace root (restricted to `engine` when set); if there is none, the spec is invalid at `/session/latest`. `session.key` (`^[A-Za-z0-9._:-]{1,128}$`, unique per workspace) is a caller-chosen name: it continues the session with that key, or starts one under it; `Session.key` reports it, and `GET /v1/sessions?workspace=…` finds it. `session` takes exactly one of `id`, `latest` or `key`, each with an optional `fork`.

A session is a conversation: one engine, one workspace, many runs. `GET /v1/sessions` lists `{id, engine, workspace, title, model, runs, usage, created_at, updated_at}`, most recently used first, from bo's session index (up to 50 per workspace), which survives restarts. The engines keep the conversations themselves. `GET /v1/sessions/{id}/runs` returns the session's finished runs, oldest first, as `{run, items}` (the terminal `Run` and each item in its final state), from a history bo keeps per session (at most 8 MiB, oldest runs dropped first). `DELETE /v1/sessions/{id}` forgets a session and its history in bo (`409 session_busy` while a run holds it); the engine's own history is untouched. A session change the server could not write to disk is logged when it happens, and `bo serve` exits non-zero if any is still unsaved when it stops. An unreadable or malformed session index stops startup so the file remains available for repair. Unknown fields are rejected.

`instructions` are added to the engine's own system prompt. With `project_instructions` (default true), the workspace root's `AGENTS.md` and then `CLAUDE.md` (each at most 32 KiB; a file linked under both names is read once) come first; nothing else from the workspace configures the engine. A subagent's `effort` is checked against its model (its `model`, else the run's, else the default). `env` sets variables for the engine and every tool it runs (`BO_*` names are reserved; bo's own run variables win). `limits` are enforced by bo the same way for every engine: `max_turns` counts the agent's own model calls, `max_tokens` the input (cached included) and output tokens of every model call in the run, subagents included; the run fails with `limit_exceeded` at the first call past one. An access level is what the engine may do without asking: in an interactive run, the caller may approve an action beyond it.

Input parts are `{kind:"text",text}`, `{kind:"image",path,media_type}`, or `{kind:"data",data}`. Images are limited to 5 MiB and require a model whose `images` is true. A run result is a text or data part. Output schemas are strict draft-07 object schemas (standard `format`s are validated), limited to 64 KiB, without remote references.

Run events and streamed text share a 32 MiB budget. A result that cannot fit is reported by a terminal run with `resource_exhausted`.

MCP servers are stdio `{command,args?,env?,tools?}` or HTTP `{url,headers?,tools?}`. `tools` is an enforced allowlist. Supplying an MCP server authorizes its allowed tools even in `read` access; those tools can have effects beyond the workspace sandbox. The caller chooses this capability, including through an ACP editor's MCP server configuration. Skills are absolute server-local directories containing `SKILL.md`. Workspace, skill, image, and executable paths are resolved on the service machine; this service is single-tenant and acts with its operator's CLI credentials.

`GET /v1/engines` reports availability, version, authentication kind, and models as `{id, aliases, default, efforts, images}`. Every capability in this document works on every engine; the only per-model difference is `images` (whether a model accepts image input, in the prompt and in later messages). Engines are probed at startup; an unavailable engine is probed again (at most every 30 seconds) when it is next asked for, and an available one keeps its probe until restart. A terminal `Run` reports the actual `{id,version}` engine and model used.

`Run.usage` is what that run used: the tokens of its model calls, subagents included (`input_tokens` counts every input token, cached ones included; `cached_input_tokens` the input read from cache; `output_tokens` every output token, reasoning included; `cost_usd` when the engine reports cost). `Session.usage` is the sum of its runs.

`POST /v1/runs/{id}/messages` returns `202` once the message is queued. It appears in the event stream as a user message item only when the engine accepts it; a message the engine never receives becomes a warning notice with the reason.

An action awaiting approval is answered with `{decision}`; `allow_for_run` allows every later action of the same kind for the rest of the run (for `mcp`, the same server and tool; for `other`, the same name). A question is answered with `{answers: {question_id: [..]}}`.

Problems use RFC 9457 `application/problem+json` with `type` `urn:bo:problem:<name>`. Run errors are `auth_failed`, `rate_limited`, `context_exceeded`, `timeout`, `invalid_output`, `limit_exceeded`, `resource_exhausted`, `engine_unavailable`, or `engine_error`. The server log carries each failed run's engine diagnostic (stderr tail, native error); the public message stays generic.

Engine events without their own item type become `notice` items: API retries, context compaction, and MCP servers that failed to start.

## A2A

The agent card is at `/.well-known/agent-card.json`; JSON-RPC is at `/a2a`. Extension `urn:bo:a2a:run:v1` carries the flat `RunSpec` minus input in message metadata and bo items in status-update metadata. Without extension metadata, `BO_A2A_WORKSPACE` supplies the workspace. A context is the session keyed `a2a:<hash of contextId>`, so it continues across restarts. Pending input is answered with a data part `{item_id, response}`.

## ACP

`bo acp` speaks the [Agent Client Protocol](https://agentclientprotocol.com) v1 on stdin/stdout, so editors that host ACP agents (Zed, JetBrains, Neovim's CodeCompanion) drive both engines through bo. It is a client of a running `bo serve` (`--url`, `--token`, or the usual config). In Zed:

```json
{ "agent_servers": { "bo": { "command": "bo", "args": ["acp"] } } }
```

One prompt is one bo run, interactive, in the editor's `cwd` (plus its additional directories) with the editor's MCP servers. The session's options are `model` (every available engine's models, grouped by engine, as `<engine>/<model>`; a session keeps its engine after its first prompt), `effort` (the selected model's efforts), and `mode`: `read`, `write`, `write-internet` or `full` (not offered when bo runs as root), also exposed as ACP modes. Their defaults come from config.toml.

| bo | ACP |
|---|---|
| agent message deltas, reasoning | `agent_message_chunk`, `agent_thought_chunk` |
| plan | `plan` |
| action | `tool_call` then `tool_call_update` (kind, status, locations, the action as `rawInput`, the outcome as `rawOutput`); edits carry `diff` content, commands their output |
| subagent items | content of the delegating tool call |
| action awaiting approval | `session/request_permission`: Allow, Allow for this prompt, Deny |
| question | `elicitation/create` form (empty answers when the editor has no forms) |
| delivered steering message | `user_message_chunk` |
| `completed` · `cancelled` · `max_turns` / `max_tokens` exceeded | `end_turn` · `cancelled` · `max_turn_requests` / `max_tokens`; other failures are JSON-RPC errors with bo's message |

`Run.usage` is returned as the prompt's `usage`. Prompt images (at most 5 MiB each) become files in a private temporary directory for their run and are removed when it ends. MCP servers whose names collide once normalised to bo's name rules are refused, and so is a config value no option offers. A prompt sent while one runs waits its turn; `_session/steering {sessionId, prompt}` sends it into the running one instead. ACP sessions are bo sessions keyed `acp:<uuid>`: `session/list` lists the workspace's sessions (including `bo run` ones, by `ses_…` id), `session/load` replays one from bo's history, `session/resume` reopens without replay (a `ses_…` id only in its own workspace), and `session/delete` ends a turn in progress, then forgets it. bo-only settings go in `_meta.bo` on `session/new` or `session/resume`: `instructions`, `project_instructions`, `skills`, `subagents`, `limits`, `env`, `timeout_s`, validated like `RunSpec` (errors point at `/_meta/bo/…`).

## Engine mapping

| Capability | Claude Code | Codex |
|---|---|---|
| execution | Agent SDK streaming query | app-server JSON-RPC |
| read access | sandbox deny-write | `read-only` sandbox |
| write access | `acceptEdits`, workspace sandbox | `workspace-write`, explicit writable roots |
| full access | unsandboxed | `danger-full-access` |
| skills | temporary local plugin | staged extra skill roots |
| MCP | SDK servers plus policy allowlist | app-server servers plus `enabled_tools` |
| subagents | SDK agents | generated role files |
| structured output | JSON-schema output format | output schema |
| steer/cancel | streaming input / interrupt | turn steer / interrupt |
| questions | `AskUserQuestion` | `request_user_input` (feature `default_mode_request_user_input`) |
| plan | task tools (`TaskCreate`, `TaskUpdate`) | `update_plan` tool (`tools.update_plan.enabled`) |
| limits | bo counts model calls and tokens | bo counts model calls and tokens |
| operator settings | not loaded (`settingSources: []`, `strictMcpConfig`, bundled skills off) | not loaded: bo's own `CODEX_HOME`; apps, plugins, bundled skills off |
| memory | auto-memory off (`autoMemoryEnabled: false`) | memories off (codex default) |
| workspace config | not loaded (project settings need `settingSources`) | workspace untrusted: no `.codex/` layer, no AGENTS.md |
| project instructions | bo reads AGENTS.md, CLAUDE.md into `instructions` | same |

Runs are hermetic with respect to the operator's engine configuration: permission rules, hooks, plugins, MCP servers, claude.ai connectors, bundled skills and profiles in `~/.claude` or `~/.codex/config.toml` never apply, and neither does a workspace's own engine configuration (`.claude/settings.json`, `.codex/config.toml`). Codex runs use `${XDG_STATE_HOME:-~/.local/state}/bo/codex` as `CODEX_HOME`; it keeps session rollouts (for resume and fork), links only the operator's `auth.json`, and never keeps a `config.toml`. Codex still discovers skills under the workspace's `.agents/skills` and the operator's `~/.agents/skills`; it has no switch to turn those off.

Every run owns an engine process group. Completion, failure, cancellation, timeout, server shutdown, and resource exhaustion terminate the entire group with bounded TERM/KILL escalation.

## Performance

`npm run bench` measures real runs ("Reply with exactly: OK" at the lowest effort); `npm run bench -- core` measures
event fan-out. On the development machine (2026-09-23; Claude Code 2.1.280, codex-cli 0.155.1):

| | Claude Code | Codex |
|---|---|---|
| startup probe | 0.7 s | 2.9 s |
| created → session reported (engine started) | p50 0.8 s | p50 0.5 s |
| created → first streamed text | p50 2.4 s | p50 3.5 s |
| created → finished | p50 3.3 s | p50 3.7 s |

Engine start is under a second on both, so bo does not pre-warm engines; the rest is model time. Fan-out: 9 000
items to 32 SSE subscribers in 1.0 s (290 000 events/s, p50 delivery 0.5 s); a subscriber more than 1 024 events
behind is dropped and resumes with `Last-Event-ID` at once, missing nothing.

## Verification

```bash
npm test
BO_ALLOW_SUBSCRIPTION_AUTH=1 npm run test:integration
BO_ALLOW_SUBSCRIPTION_AUTH=1 npm run conformance
```

The integration and conformance suites use the real installed Claude Code and Codex CLIs, real models, real sandboxes, and operator authentication.

The commands above explicitly opt in to subscription authentication for test runs; use them only with an account and setup for which that use is permitted.
Conformance writes live recordings to the ignored `test/transcripts/` directory. Committed replay fixtures in `test/fixtures/transcripts/` keep `npm test` independent of live credentials and fail if either engine's fixtures are missing. Review recordings before copying any into the committed fixtures.

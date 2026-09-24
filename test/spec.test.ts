import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeSession } from "../src/ids.ts";
import { parseResponse, resolveSpec } from "../src/spec.ts";
import { SessionIndex } from "../src/core/sessions.ts";
import { fixedCatalog, info, skillDir, tmpdir } from "./helpers.ts";

const infos = [info("claude-code"), info("codex")];
const ctx = fixedCatalog(infos, "claude-code");

async function base() {
  const root = await tmpdir();
  return { root, body: { input: [{ kind: "text", text: "hi" }], workspace: { root } } as Record<string, unknown> };
}

async function errors(body: unknown, c = ctx) {
  const r = await resolveSpec(body, c);
  assert.ok("problem" in r);
  return "problem" in r ? (r.problem.errors ?? []).map((e) => `${e.pointer} ${e.detail}`) : [];
}

test("minimal spec resolves with defaults", async () => {
  const { root, body } = await base();
  const r = await resolveSpec(body, ctx);
  assert.ok("spec" in r);
  if (!("spec" in r)) return;
  assert.equal(r.spec.engine, "claude-code");
  assert.equal(r.spec.root, await import("node:fs/promises").then((f) => f.realpath(root)));
  assert.equal(r.spec.access, "write");
  assert.equal(r.spec.internet, false);
  assert.equal(r.spec.interactive, false);
  assert.equal(r.spec.timeoutMs, 1_800_000);
  assert.match(r.spec.runId, /^run_/);
});

test("engine options pass through and unknown models are rejected before admission", async () => {
  const { body } = await base();
  const resolved = await resolveSpec({ ...body, engine: "codex", model: "m1", effort: "high", instructions: "be exact" }, ctx);
  assert.ok("spec" in resolved);
  if ("spec" in resolved) assert.deepEqual(
    { engine: resolved.spec.engine, model: resolved.spec.model, effort: resolved.spec.effort, instructions: resolved.spec.instructions },
    { engine: "codex", model: "m1", effort: "high", instructions: "be exact" },
  );
  assert.ok((await errors({ ...body, model: "missing" })).some((error) => error.startsWith("/model unknown model")));
});

test("models resolve aliases to canonical ids; efforts are checked per model", async () => {
  const { body } = await base();
  const aliased = await resolveSpec({ ...body, model: "m1-alias", effort: "low" }, ctx);
  assert.ok("spec" in aliased && aliased.spec.model === "m1" && aliased.spec.effort === "low");
  const byDefault = await resolveSpec({ ...body, effort: "high" }, ctx);
  assert.ok("spec" in byDefault && byDefault.spec.model === undefined && byDefault.spec.effort === "high", "no model: checked against the default");
  assert.deepEqual(await errors({ ...body, effort: "max" }), ["/effort must be one of low, high for m1"]);
  assert.deepEqual(await errors({ ...body, model: "m2", effort: "low" }), ["/effort m2 does not accept an effort"]);
  const sub = await resolveSpec({ ...body, subagents: { helper: { description: "d", instructions: "i", model: "m1-alias" } } }, ctx);
  assert.ok("spec" in sub && sub.spec.subagents.helper!.model === "m1");
  assert.ok((await errors({ ...body, subagents: { helper: { description: "d", instructions: "i", model: "nope" } } })).includes("/subagents/helper/model unknown model for claude-code"));
  const open = fixedCatalog([info("claude-code", { models: [] })], "claude-code");
  const any = await resolveSpec({ ...body, model: "whatever", effort: "turbo" }, open);
  assert.ok("spec" in any && any.spec.model === "whatever", "an engine that lists no models accepts any");
});

test("unknown fields are rejected at every level with JSON pointers", async () => {
  const { body } = await base();
  const e = await errors({ ...body, extra: 1, agent: { nope: 1 }, permissions: { x: 1 } });
  assert.ok(e.includes("/extra unknown field"));
  assert.ok(e.includes("/agent unknown field"));
  assert.ok(e.includes("/permissions/x unknown field"));
});

test("input parts are validated", async () => {
  const { root } = await base();
  const png = path.join(root, "x.png");
  await writeFile(png, "png");
  const e = await errors({
    workspace: { root },
    input: [{ kind: "text", text: " " }, { kind: "image", path: "rel.png", media_type: "image/png" }, { kind: "image", path: png, media_type: "text/plain" }, { kind: "file" }, { kind: "data" }],
  });
  assert.ok(e.some((x) => x.startsWith("/input/0/text")));
  assert.ok(e.some((x) => x.startsWith("/input/1/path") && x.includes("absolute")));
  assert.ok(e.some((x) => x.startsWith("/input/2/media_type")));
  assert.ok(e.some((x) => x.startsWith("/input/3/kind")));
  assert.ok(e.some((x) => x.startsWith("/input/4/data")));
  assert.ok((await errors({ workspace: { root }, input: [] })).some((x) => x.startsWith("/input ")));
});

test("image parts resolve and require the images feature", async () => {
  const { root, body } = await base();
  const png = path.join(root, "x.png");
  await writeFile(png, "png");
  const input = [{ kind: "image", path: png, media_type: "image/png" }];
  const r = await resolveSpec({ ...body, input }, ctx);
  assert.ok("spec" in r && r.spec.input[0]!.kind === "image");
  const noImages = await resolveSpec({ ...body, input, model: "m2" }, ctx);
  assert.ok(!("spec" in noImages) && noImages.problem.detail === "m2 does not accept images");
});

test("workspace root and extra roots", async () => {
  const { root, body } = await base();
  assert.ok((await errors({ ...body, workspace: { root: "relative" } })).some((x) => x.startsWith("/workspace/root")));
  assert.ok((await errors({ ...body, workspace: { root: path.join(root, "missing") } })).some((x) => x === "/workspace/root must exist"));
  const inside = path.join(root, "sub");
  await mkdir(inside);
  const e = await errors({ ...body, workspace: { root, extra_roots: [root, inside] } });
  assert.ok(e.some((x) => x.startsWith("/workspace/extra_roots/0")));
  assert.ok(e.some((x) => x.startsWith("/workspace/extra_roots/1")));
  const other = await tmpdir();
  const r = await resolveSpec({ ...body, workspace: { root, extra_roots: [other] } }, ctx);
  assert.ok("spec" in r && r.spec.extraRoots.length === 1);
});

test("internet defaults to access full and cannot be disabled with full", async () => {
  const { body } = await base();
  const full = await resolveSpec({ ...body, permissions: { access: "full" } }, ctx);
  assert.ok("spec" in full && full.spec.internet === true);
  assert.ok((await errors({ ...body, permissions: { access: "full", internet: false } })).some((x) => x.startsWith("/permissions/internet")));
  const read = await resolveSpec({ ...body, permissions: { access: "read", internet: true } }, ctx);
  assert.ok("spec" in read && read.spec.internet === true);
});

test("skills, mcp servers and subagents", async () => {
  const { root, body } = await base();
  const skill = await skillDir(root, "good-skill");
  const noSkill = path.join(root, "empty");
  await mkdir(noSkill);
  const bad = await skillDir(root, "Bad_Name");
  const e = await errors({ ...body, skills: [skill, skill, noSkill, bad] });
  assert.ok(e.some((x) => x.startsWith("/skills/1") && x.includes("duplicate")));
  assert.ok(e.some((x) => x.startsWith("/skills/2") && x.includes("SKILL.md")));
  assert.ok(e.some((x) => x.startsWith("/skills/3")));
  const e2 = await errors({ ...body, mcp: { "bad name": { command: "x" }, a: { url: "::" }, b: { command: "x", url: "y" } } });
  assert.ok(e2.some((x) => x.startsWith("/mcp/bad name")));
  assert.ok(e2.some((x) => x.startsWith("/mcp/a/url")));
  assert.ok(e2.some((x) => x.startsWith("/mcp/b/url")));
  const e3 = await errors({ ...body, subagents: { Echo: { description: "d", instructions: "i" }, ok: { description: "", instructions: "i" } } });
  assert.ok(e3.some((x) => x.startsWith("/subagents/Echo")));
  assert.ok(e3.some((x) => x.startsWith("/subagents/ok/description")));
  const r = await resolveSpec({ ...body, skills: [skill], mcp: { fx: { command: "node", tools: ["a"] } }, subagents: { echo: { description: "d", instructions: "i" } } }, ctx);
  assert.ok("spec" in r);
  if ("spec" in r) assert.deepEqual(r.spec.skills, [{ name: "good-skill", path: skill }]);
});

test("session decides the engine and conflicts are reported", async () => {
  const { body } = await base();
  const id = encodeSession("codex", "thread-1");
  const r = await resolveSpec({ ...body, session: { id, fork: true } }, ctx);
  assert.ok("spec" in r && r.spec.engine === "codex" && r.spec.session?.fork === true);
  assert.ok((await errors({ ...body, session: { id }, engine: "claude-code" })).some((x) => x.startsWith("/engine")));
  assert.ok((await errors({ ...body, session: { id: "nope" } })).some((x) => x.startsWith("/session/id")));
});

test("output schema, interactive, timeout", async () => {
  const { body } = await base();
  assert.ok((await errors({ ...body, output: { schema: { type: "string" } } })).some((x) => x.startsWith("/output/schema")));
  assert.ok((await errors({ ...body, timeout_s: 0 })).some((x) => x.startsWith("/timeout_s")));
  assert.ok((await errors({ ...body, interactive: "yes" })).some((x) => x.startsWith("/interactive")));
  const r = await resolveSpec({ ...body, output: { schema: { type: "object" } }, interactive: true, timeout_s: 5 }, ctx);
  assert.ok("spec" in r && r.spec.timeoutMs === 5000 && r.spec.schema !== undefined && r.spec.interactive);
});

test("output schemas may use formats, and the compiled validator enforces them", async () => {
  const { body } = await base();
  const schema = { type: "object", properties: { at: { type: "string", format: "date-time" } }, required: ["at"] };
  for (let i = 0; i < 3; i++) {
    const r = await resolveSpec({ ...body, output: { schema } }, ctx);
    assert.ok("spec" in r && r.spec.validateOutput);
    if (!("spec" in r)) return;
    assert.equal(r.spec.validateOutput!({ at: "2026-09-23T10:00:00Z" }), true);
    assert.equal(r.spec.validateOutput!({ at: "yesterday" }), false);
  }
  assert.ok((await errors({ ...body, output: { schema: { type: "object", properties: { x: { type: "string", format: "no-such-format" } } } } })).some((x) => x.startsWith("/output/schema")));
});

test("response bodies: exactly one of decision or answers, answers are string lists", () => {
  assert.deepEqual(parseResponse({ decision: "allow" }), { response: { decision: "allow" } });
  assert.deepEqual(parseResponse({ answers: { "a/b": ["x"] } }), { response: { answers: { "a/b": ["x"] } } });
  const both = parseResponse({ decision: "allow", answers: {} });
  assert.ok("problem" in both && both.problem.type === "urn:bo:problem:invalid_request");
  const bad = parseResponse({ answers: { "a/b": [1] } });
  assert.ok("problem" in bad && bad.problem.errors?.[0]?.pointer === "/answers/a~1b/0");
});

test("engine availability is enforced; every capability works on every engine", async () => {
  const { body } = await base();
  const none = await resolveSpec(body, fixedCatalog(infos));
  assert.ok(!("spec" in none) && none.problem.errors?.some((e) => e.pointer === "/engine"));
  const down = await resolveSpec(body, fixedCatalog([info("claude-code", { available: false, reason: "nope" })], "claude-code"));
  assert.ok(!("spec" in down) && down.problem.type === "urn:bo:problem:engine_unavailable" && down.problem.detail.includes("nope"));
  for (const engine of ["claude-code", "codex"]) {
    const everything = await resolveSpec({ ...body, engine, interactive: true, limits: { max_turns: 3, max_tokens: 9 }, output: { schema: { type: "object" } } }, ctx);
    assert.ok("spec" in everything, engine);
  }
});

test("project instructions: AGENTS.md then CLAUDE.md, a linked duplicate once, before the caller's; opt-out; size cap", async () => {
  const { root, body } = await base();
  await writeFile(path.join(root, "AGENTS.md"), "use tabs\n");
  await symlink(path.join(root, "AGENTS.md"), path.join(root, "CLAUDE.md"));
  const linked = await resolveSpec({ ...body, instructions: "be brief" }, ctx);
  assert.ok("spec" in linked && linked.spec.instructions === "use tabs\n\nbe brief");
  const other = await tmpdir();
  await writeFile(path.join(other, "AGENTS.md"), "agents");
  await writeFile(path.join(other, "CLAUDE.md"), "claude");
  const both = await resolveSpec({ ...body, workspace: { root: other } }, ctx);
  assert.ok("spec" in both && both.spec.instructions === "agents\n\nclaude");
  const off = await resolveSpec({ ...body, workspace: { root: other }, project_instructions: false }, ctx);
  assert.ok("spec" in off && off.spec.instructions === undefined);
  await writeFile(path.join(other, "CLAUDE.md"), "x".repeat(33 * 1024));
  assert.deepEqual(await errors({ ...body, workspace: { root: other } }), ["/project_instructions CLAUDE.md must be at most 32 KiB"]);
  const looping = await tmpdir();
  await symlink("AGENTS.md", path.join(looping, "AGENTS.md"));
  assert.deepEqual(await errors({ ...body, workspace: { root: looping } }), ["/project_instructions AGENTS.md could not be read"]);
});

test("env: names, values, and reserved BO_* names", async () => {
  const { body } = await base();
  const r = await resolveSpec({ ...body, env: { GITHUB_TOKEN: "t", _X1: "" } }, ctx);
  assert.ok("spec" in r && r.spec.env.GITHUB_TOKEN === "t");
  const shape = await errors({ ...body, env: { "1BAD": "x", OK: 3 } });
  assert.ok(shape.some((x) => x.startsWith("/env/1BAD key must match")), shape.join());
  assert.ok(shape.includes("/env/OK must be a string"), shape.join());
  assert.deepEqual(await errors({ ...body, env: { BO_TOKEN: "x" } }), ["/env/BO_TOKEN BO_* names are reserved"], "checked once the shape is right");
});

test("limits are validated", async () => {
  const { body } = await base();
  const r = await resolveSpec({ ...body, limits: { max_turns: 5, max_tokens: 20_000 } }, ctx);
  assert.ok("spec" in r);
  if ("spec" in r) assert.deepEqual(r.spec.limits, { maxTurns: 5, maxTokens: 20_000 });
  assert.deepEqual(await errors({ ...body, limits: { max_turns: 0, max_tokens: 1.5, x: 1 } }), [
    "/limits/x unknown field", "/limits/max_turns must be an integer 1–10000", "/limits/max_tokens must be an integer 1–1000000000",
  ]);
});

test("subagent effort is checked against the subagent's model; image input against the run's model", async () => {
  const { root, body } = await base();
  const ok = await resolveSpec({ ...body, subagents: { helper: { description: "d", instructions: "i", effort: "high" } } }, ctx);
  assert.ok("spec" in ok && ok.spec.subagents.helper!.effort === "high");
  assert.deepEqual(await errors({ ...body, subagents: { helper: { description: "d", instructions: "i", model: "m2", effort: "high" } } }),
    ["/subagents/helper/effort m2 does not accept an effort"]);
  const png = path.join(root, "x.png");
  await writeFile(png, "png");
  const input = [{ kind: "image", path: png, media_type: "image/png" }];
  const noImages = await resolveSpec({ ...body, model: "m2", input }, ctx);
  assert.ok("problem" in noImages && noImages.problem.detail === "m2 does not accept images");
});

test("session.latest resolves the workspace's newest session (for engine, when given); none is a field error", async () => {
  const { root, body } = await base();
  const real = await import("node:fs/promises").then((f) => f.realpath(root));
  const index = SessionIndex.memory();
  const claude = encodeSession("claude-code", "c1");
  const codex = encodeSession("codex", "x1");
  index.note({ id: claude, engine: "claude-code", workspace: real, input: [] });
  index.note({ id: codex, engine: "codex", workspace: real, input: [] });
  const latest = await resolveSpec({ ...body, session: { latest: true } }, ctx, index);
  assert.ok("spec" in latest && latest.spec.engine === "codex" && latest.spec.session?.native === "x1", "the newest, and its engine");
  const forClaude = await resolveSpec({ ...body, engine: "claude-code", session: { latest: true, fork: true } }, ctx, index);
  assert.ok("spec" in forClaude && forClaude.spec.session?.native === "c1" && forClaude.spec.session.fork);
  const none = await resolveSpec({ ...body, session: { latest: true } }, ctx, SessionIndex.memory());
  assert.ok("problem" in none);
  assert.deepEqual(none.problem.errors, [{ pointer: "/session/latest", detail: `no earlier session in ${real}` }]);
  assert.deepEqual(await errors({ ...body, session: { latest: true, id: claude } }), ["/session must have exactly one of id, latest or key"]);
  assert.deepEqual(await errors({ ...body, session: { latest: false } }), ["/session/latest must be true"]);
});

test("a continued or forked session carries the engine's totals as this run's usage baseline", async () => {
  const { root, body } = await base();
  const index = SessionIndex.memory();
  const id = encodeSession("claude-code", "c1");
  const totals = { input_tokens: 90, output_tokens: 9, cached_input_tokens: 50 };
  index.note({ id, engine: "claude-code", workspace: await realpath(root), input: [], ended: { usage: totals, totals } });
  for (const session of [{ id }, { id, fork: true }]) {
    const r = await resolveSpec({ ...body, session }, ctx, index);
    assert.ok("spec" in r && r.spec.session?.totals === totals, JSON.stringify(session));
  }
  const fresh = await resolveSpec({ ...body, session: { id: encodeSession("claude-code", "unknown") } }, ctx, index);
  assert.ok("spec" in fresh && fresh.spec.session?.totals === undefined);
});

test("session.key continues the keyed session in this workspace, or starts one under the key", async () => {
  const { root, body } = await base();
  const real = await import("node:fs/promises").then((f) => f.realpath(root));
  const index = SessionIndex.memory();
  const started = await resolveSpec({ ...body, session: { key: "acp:abc" } }, ctx, index);
  assert.ok("spec" in started && started.spec.session === undefined && started.spec.sessionKey === "acp:abc", "no session yet: a new one, under the key");
  const id = encodeSession("codex", "t1");
  index.note({ id, engine: "codex", workspace: real, input: [], key: "acp:abc" });
  const continued = await resolveSpec({ ...body, session: { key: "acp:abc" } }, ctx, index);
  assert.ok("spec" in continued && continued.spec.session?.native === "t1" && continued.spec.engine === "codex" && continued.spec.sessionKey === undefined);
  assert.deepEqual(await errors({ ...body, session: { key: "no spaces" } }), ["/session/key must match ^[A-Za-z0-9._:-]{1,128}$"]);
  assert.deepEqual(await errors({ ...body, session: { key: "acp:none", fork: true } }, ctx), [`/session/fork no session with key acp:none in ${real} to fork`]);
});

test("a session belongs to its workspace: continuing or forking it from another is a field error", async () => {
  const { body } = await base();
  const index = SessionIndex.memory();
  const id = encodeSession("claude-code", "c1");
  index.note({ id, engine: "claude-code", workspace: "/elsewhere", input: [] });
  for (const session of [{ id }, { id, fork: true }]) {
    const r = await resolveSpec({ ...body, session }, ctx, index);
    assert.ok("problem" in r);
    assert.deepEqual(r.problem.errors, [{ pointer: "/session/id", detail: "belongs to /elsewhere; continue it there" }]);
  }
  const unknown = await resolveSpec({ ...body, session: { id: encodeSession("claude-code", "gone") } }, ctx, index);
  assert.ok("spec" in unknown, "a session bo no longer indexes is the engine's to find");
});

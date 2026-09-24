import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionIndex } from "../src/core/sessions.ts";
import { encodeSession } from "../src/ids.ts";
import { sleep, tmpdir } from "./helpers.ts";

const text = (t: string) => [{ kind: "text" as const, text: t }];

test("the index persists atomically (0600), survives a reopen, and answers latest per workspace, engine and context", async () => {
  const file = path.join(await tmpdir(), "state", "sessions.json");
  const index = await SessionIndex.open(file);
  const a = encodeSession("claude-code", "a");
  const b = encodeSession("codex", "b");
  index.note({ id: a, engine: "claude-code", workspace: "/w", input: text("fix the tests\nplease"), key: "acp:1" });
  await sleep(5);
  index.note({ id: b, engine: "codex", workspace: "/w", input: text("review") });
  const used = { input_tokens: 100, output_tokens: 7, cached_input_tokens: 60, cost_usd: 0.01 };
  const engineTotals = { input_tokens: 900, output_tokens: 70, cached_input_tokens: 600, cost_usd: 0.09 };
  index.note({ id: a, engine: "claude-code", workspace: "/w", input: text("ignored: the title is the first prompt"), model: "m", ended: { usage: used, totals: engineTotals } });
  index.note({ id: a, engine: "claude-code", workspace: "/w", input: text("x"), ended: { usage: used } });
  await index.flush();
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reopened = await SessionIndex.open(file);
  assert.equal(reopened.latest({ workspace: "/w" })?.id, a, "the most recently used");
  assert.equal(reopened.latest({ workspace: "/w", engine: "codex" })?.id, b);
  assert.equal(reopened.latest({ workspace: "/w", key: "acp:1" })?.id, a);
  assert.equal(reopened.latest({ workspace: "/elsewhere", key: "acp:1" }), undefined, "keys are per workspace");
  assert.equal(reopened.latest({ workspace: "/other" }), undefined);
  const [first] = reopened.list("/w");
  assert.deepEqual({ ...first, created_at: "", updated_at: "" }, {
    id: a, engine: "claude-code", workspace: "/w", title: "fix the tests", key: "acp:1", model: "m", runs: 2,
    usage: { input_tokens: 200, output_tokens: 14, cached_input_tokens: 120, cost_usd: 0.02 }, created_at: "", updated_at: "",
  }, "usage sums the runs; the key is public; no internal fields (engine totals)");
  assert.deepEqual(reopened.totals(a), engineTotals, "the engine's totals are kept (the next run's baseline)");
  assert.equal(reopened.totals(b), undefined);
  assert.equal(reopened.list().length, 2);
});

test("the index keeps the newest 50 sessions per workspace", async () => {
  const index = SessionIndex.memory();
  for (let i = 0; i < 55; i++) index.note({ id: encodeSession("codex", `s${i}`), engine: "codex", workspace: "/w", input: text(`task ${i}`) });
  const listed = index.list("/w");
  assert.equal(listed.length, 50);
  assert.ok(!listed.some((s) => s.title === "task 0"));
});

test("a damaged index is preserved; titles are one short line", async () => {
  const file = path.join(await tmpdir(), "sessions.json");
  await writeFile(file, "{not json");
  await assert.rejects(SessionIndex.open(file), /session index .* is unreadable/);
  assert.equal(await readFile(file, "utf8"), "{not json");
  await rm(file);
  const index = await SessionIndex.open(file);
  index.note({ id: encodeSession("codex", "x"), engine: "codex", workspace: "/w", input: text("y".repeat(200)) });
  assert.equal(index.list()[0]!.title.length, 80);
  index.note({ id: encodeSession("codex", "img"), engine: "codex", workspace: "/w", input: [{ kind: "image", path: "/p.png", media_type: "image/png" }] });
  assert.equal(index.latest({ workspace: "/w" })!.title, "(image)");
  await index.flush();
  assert.match(await readFile(file, "utf8"), /"sessions"/);
});

test("an index read error other than absence fails startup", async () => {
  const dir = await tmpdir();
  await mkdir(path.join(dir, "sessions.json"));
  await assert.rejects(SessionIndex.open(path.join(dir, "sessions.json")), /EISDIR/);
});

const sessionRun = (id: string, text: string) => ({
  run: { id, session_id: "s", status: "completed" as const, engine: { id: "codex" as const, version: "1" }, model: null, created_at: "", usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 }, result: { kind: "text" as const, text } },
  items: [{ id: "i", created_at: "", type: "message" as const, role: "user" as const, content: [{ kind: "text" as const, text }], status: "completed" as const }],
});

test("history: one 0600 file per session, oldest first; past its size the oldest runs go, the newest stays", async () => {
  const { FileHistory } = await import("../src/core/history.ts");
  const dir = await tmpdir();
  const history = new FileHistory(dir, undefined, 1_000);
  history.append("ses_a", sessionRun("run_1", "first"));
  history.append("ses_a", sessionRun("run_2", "second"));
  history.append("ses_b", sessionRun("run_3", "other"));
  assert.deepEqual((await history.read("ses_a")).map((r) => r.run.id), ["run_1", "run_2"]);
  const [file] = (await import("node:fs/promises").then((fs) => fs.readdir(dir))).filter(Boolean);
  assert.equal((await stat(path.join(dir, file!))).mode & 0o777, 0o600);
  history.append("ses_a", sessionRun("run_4", "x".repeat(900)));
  assert.deepEqual((await history.read("ses_a")).map((r) => r.run.id), ["run_4"], "the oldest runs made room; the newest is kept even alone");
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), [], "rewritten through a temporary file, renamed into place");
  history.remove("ses_a");
  assert.deepEqual(await history.read("ses_a"), []);
  assert.deepEqual((await history.read("ses_b")).map((r) => r.run.id), ["run_3"]);
});

test("history read errors and malformed records are reported", async () => {
  const { FileHistory } = await import("../src/core/history.ts");
  const dir = await tmpdir();
  const history = new FileHistory(dir);
  history.append("ses_a", sessionRun("run_1", "first"));
  await history.flush();
  const [file] = await readdir(dir);
  await writeFile(path.join(dir, file!), "{not json\n");
  await assert.rejects(history.read("ses_a"), SyntaxError);
  await rm(path.join(dir, file!));
  await mkdir(path.join(dir, file!));
  await assert.rejects(history.read("ses_a"), /EISDIR/);
});

test("the index owns history: kept across a reopen, removed with its session (delete or eviction)", async () => {
  const file = path.join(await tmpdir(), "sessions.json");
  const index = await SessionIndex.open(file);
  const a = encodeSession("codex", "a");
  index.note({ id: a, engine: "codex", workspace: "/w", input: text("hi") });
  index.append(a, sessionRun("run_1", "hi"));
  index.append(encodeSession("codex", "unknown"), sessionRun("run_x", "ignored: not indexed"));
  await index.flush();
  const reopened = await SessionIndex.open(file);
  assert.deepEqual((await reopened.runs(a)).map((r) => r.run.id), ["run_1"]);
  assert.equal(reopened.delete(a), true);
  assert.equal(reopened.delete(a), false);
  assert.deepEqual(await reopened.runs(a), []);
  assert.equal(reopened.get(a), undefined);
  const evicting = SessionIndex.memory();
  const first = encodeSession("codex", "s0");
  for (let i = 0; i < 51; i++) {
    const id = encodeSession("codex", `s${i}`);
    evicting.note({ id, engine: "codex", workspace: "/w", input: text(`t${i}`) });
    evicting.append(id, sessionRun(`run_${i}`, "x"));
  }
  assert.deepEqual(await evicting.runs(first), [], "an evicted session's history goes with it");
});

test("flush() reports writes that failed: the index until a later save catches up, lost history once", async () => {
  const { FileHistory } = await import("../src/core/history.ts");
  const blocked = path.join(await tmpdir(), "state");
  const index = await SessionIndex.open(path.join(blocked, "sessions.json"));
  await writeFile(blocked, "a file where the directory should be");
  index.note({ id: encodeSession("codex", "a"), engine: "codex", workspace: "/w", input: [] });
  await assert.rejects(index.flush(), /session index .* not saved/);
  await rm(blocked);
  index.note({ id: encodeSession("codex", "b"), engine: "codex", workspace: "/w", input: [] });
  await index.flush();   // each save writes the whole index: nothing is behind any more

  const notADir = path.join(await tmpdir(), "history");
  await writeFile(notADir, "");
  const history = new FileHistory(notADir);
  history.append("ses_a", sessionRun("run_1", "lost"));
  await assert.rejects(history.flush(), /session history not saved/);
  await history.flush();
});

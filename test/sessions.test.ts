import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
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
  index.note({ id: a, engine: "claude-code", workspace: "/w", input: text("fix the tests\nplease"), context: "ctx1" });
  await sleep(5);
  index.note({ id: b, engine: "codex", workspace: "/w", input: text("review") });
  index.note({ id: a, engine: "claude-code", workspace: "/w", input: text("ignored: the title is the first prompt"), model: "m", ended: true });
  await index.flush();
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const reopened = await SessionIndex.open(file);
  assert.equal(reopened.latest({ workspace: "/w" })?.id, a, "the most recently used");
  assert.equal(reopened.latest({ workspace: "/w", engine: "codex" })?.id, b);
  assert.equal(reopened.latest({ context: "ctx1" })?.id, a);
  assert.equal(reopened.latest({ workspace: "/other" }), undefined);
  const [first] = reopened.list("/w");
  assert.deepEqual({ ...first, created_at: "", updated_at: "" }, {
    id: a, engine: "claude-code", workspace: "/w", title: "fix the tests", model: "m", runs: 1, created_at: "", updated_at: "",
  }, "no internal fields (context) on the public shape");
  assert.equal(reopened.list().length, 2);
});

test("the index keeps the newest 50 sessions per workspace", async () => {
  const index = SessionIndex.memory();
  for (let i = 0; i < 55; i++) index.note({ id: encodeSession("codex", `s${i}`), engine: "codex", workspace: "/w", input: text(`task ${i}`) });
  const listed = index.list("/w");
  assert.equal(listed.length, 50);
  assert.ok(!listed.some((s) => s.title === "task 0"));
});

test("an unreadable index starts empty and says so; titles are one short line", async () => {
  const file = path.join(await tmpdir(), "sessions.json");
  await writeFile(file, "{not json");
  const logged: string[] = [];
  const index = await SessionIndex.open(file, (m) => logged.push(m));
  assert.deepEqual(index.list(), []);
  assert.match(logged[0]!, /unreadable; starting empty/);
  index.note({ id: encodeSession("codex", "x"), engine: "codex", workspace: "/w", input: text("y".repeat(200)) });
  assert.equal(index.list()[0]!.title.length, 80);
  index.note({ id: encodeSession("codex", "img"), engine: "codex", workspace: "/w", input: [{ kind: "image", path: "/p.png", media_type: "image/png" }] });
  assert.equal(index.latest({ workspace: "/w" })!.title, "(image)");
  await index.flush();
  assert.match(await readFile(file, "utf8"), /"sessions"/, "the next write replaces the unreadable file");
});

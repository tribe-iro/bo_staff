// Golden replay: every recorded transcript under test/transcripts/<engine>/<C>.jsonl must still translate to
// the committed <C>.ops.json and <C>.outcome.json. Recorded by `npm run conformance`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { ENGINE_IDS } from "../src/model.ts";
import { replayTranscript } from "./replay.ts";
import { createTranscriptRecorder } from "./tap.ts";
import { tmpdir } from "./helpers.ts";

const ROOT = path.join(import.meta.dirname, "transcripts");

for (const engine of ENGINE_IDS) {
  const dir = path.join(ROOT, engine);
  const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)) : [];
  for (const name of names) {
    const ops = path.join(dir, `${name}.ops.json`);
    if (!existsSync(ops)) continue;
    test(`${engine} ${name} replays to its goldens`, () => {
      const spec = JSON.parse(readFileSync(path.join(dir, `${name}.spec.json`), "utf8")) as { schema: Record<string, unknown> | null };
      const replay = replayTranscript(engine, readFileSync(path.join(dir, `${name}.jsonl`), "utf8"), { schema: spec.schema ?? undefined });
      assert.deepEqual(JSON.parse(JSON.stringify(replay.ops)), JSON.parse(readFileSync(ops, "utf8")));
      assert.deepEqual(JSON.parse(JSON.stringify(replay.outcome)), JSON.parse(readFileSync(path.join(dir, `${name}.outcome.json`), "utf8")));
    });
  }
}

test("conformance recorder rejects secrets before writing", async () => {
  const root = await tmpdir();
  const recorder = createTranscriptRecorder(root, "codex", "unsafe");
  assert.throws(() => recorder.record({ headers: { authorization: "Bearer secret" } }), /unsafe transcript/);
  recorder.record({ method: "turn/completed", params: { turn: { status: "completed" } } });
  await recorder.flush();
  assert.doesNotMatch(await readFile(path.join(root, "codex", "unsafe.jsonl"), "utf8"), /secret|authorization/i);
});

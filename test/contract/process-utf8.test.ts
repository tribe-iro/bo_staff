import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { streamCommand, type CommandStreamEvent } from "../../src/adapters/process.ts";

// Property: when the output cap falls in the middle of a multi-byte UTF-8 sequence, the
// truncated capture must end at a character boundary — never emit a replacement char from a
// split sequence. '€' (U+20AC) is 3 bytes (E2 82 AC); a 4-byte cap lands after "aaa" + the
// lead byte, so the partial char must be dropped, leaving exactly "aaa".
test("output truncation never splits a UTF-8 sequence", async () => {
  let terminal: Extract<CommandStreamEvent, { type: "terminated" }> | undefined;
  for await (const event of streamCommand({
    command: process.execPath,
    args: ["-e", "process.stdout.write('aaa\\u20ac')"],
    cwd: os.tmpdir(),
    timeoutMs: 10_000,
    maxOutputBytes: 4,
  })) {
    if (event.type === "terminated") {
      terminal = event;
    }
  }

  assert.ok(terminal, "a terminated event is emitted");
  assert.equal(terminal!.reason, "stdout_overflow");
  assert.equal(terminal!.stdout, "aaa", "partial multibyte char is dropped at the cap");
  assert.ok(!terminal!.stdout.includes("�"), "no U+FFFD replacement character");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeSession, encodeSession, mint } from "../src/ids.ts";

test("mint produces prefixed 24-hex ids", () => {
  assert.match(mint("run"), /^run_[0-9a-f]{24}$/);
  assert.match(mint("itm"), /^itm_[0-9a-f]{24}$/);
});

test("session codec round-trips", () => {
  const id = encodeSession("codex", "0199a-b.c_d");
  assert.match(id, /^ses_[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeSession(id), { engine: "codex", native: "0199a-b.c_d" });
});

test("session codec rejects bad prefix, engine and native id", () => {
  assert.equal(decodeSession("run_abc"), null);
  assert.equal(decodeSession(`ses_${Buffer.from("gemini:abc").toString("base64url")}`), null);
  assert.equal(decodeSession(`ses_${Buffer.from("codex:a/b").toString("base64url")}`), null);
  assert.equal(decodeSession(`ses_${Buffer.from("codex").toString("base64url")}`), null);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, symlink } from "node:fs/promises";
import path from "node:path";
import { authPolicy, engineEnv, killGroup, orderedInput, spawnInGroup, stageSkills, terminateProcessGroup } from "../src/harness/common.ts";
import { skillDir, sleep, tmpdir } from "./helpers.ts";

test("orderedInput preserves text, data, and image order", () => {
  const r = orderedInput([
    { kind: "text", text: "a" },
    { kind: "data", data: { x: 1 } },
    { kind: "image", path: "/i.png", media_type: "image/png" },
    { kind: "text", text: "b" },
  ]);
  assert.deepEqual(r, [
    { kind: "text", text: "a" },
    { kind: "text", text: 'Structured input:\n```json\n{\n  "x": 1\n}\n```' },
    { kind: "image", path: "/i.png", mediaType: "image/png" },
    { kind: "text", text: "b" },
  ]);
});

test("stageSkills copies real files, dereferencing symlinks", async () => {
  const src = await tmpdir();
  const one = await skillDir(src, "one");
  const two = await skillDir(src, "two");
  const link = path.join(src, "two-link");
  await symlink(two, link);
  const out = await tmpdir();
  await stageSkills([{ name: "one", path: one }, { name: "two", path: link }], out);
  assert.match(await readFile(path.join(out, "one", "SKILL.md"), "utf8"), /name: one/);
  assert.match(await readFile(path.join(out, "two", "SKILL.md"), "utf8"), /name: two/);
});

test("killGroup kills grandchildren", async () => {
  const child = spawnInGroup("sh", ["-c", "sleep 60 & wait"], {});
  await sleep(200);
  const marker = () => {
    try { return execFileSync("pgrep", ["-g", String(child.pid)]).toString().trim(); } catch { return ""; }
  };
  assert.notEqual(marker(), "");
  killGroup(child, "SIGKILL");
  await sleep(200);
  assert.equal(marker(), "");
});

test("termination kills children left behind after the group leader exits", async () => {
  const leader = spawnInGroup("sh", ["-c", "sleep 61 & exit 0"], {});
  await new Promise((r) => leader.once("exit", r));
  await sleep(100);
  const alive = () => { try { return execFileSync("pgrep", ["-g", String(leader.pid)]).toString().trim(); } catch { return ""; } };
  assert.notEqual(alive(), "", "background child survives its leader");
  await terminateProcessGroup(leader, undefined, 50);
  assert.equal(alive(), "");
});

test("authPolicy", () => {
  assert.deepEqual(authPolicy("api_key", {}), { allowed: true });
  assert.deepEqual(authPolicy("cloud_provider", {}), { allowed: true });
  const refused = authPolicy("subscription", {});
  assert.ok(!refused.allowed && refused.reason.includes("BO_ALLOW_SUBSCRIPTION_AUTH"));
  assert.deepEqual(authPolicy("subscription", { BO_ALLOW_SUBSCRIPTION_AUTH: "1" }), { allowed: true });
  assert.equal((authPolicy("none", {}) as { reason: string }).reason.startsWith("not logged in"), true);
});

test("engineEnv drops bo's own configuration and applies overrides", () => {
  const env = engineEnv({ PATH: "/bin", BO_TOKEN: "t", BO_ALLOW_SUBSCRIPTION_AUTH: "1", ROBOT: "keep", TMPDIR: "/tmp" }, { TMPDIR: "/private" });
  assert.deepEqual(env, { PATH: "/bin", ROBOT: "keep", TMPDIR: "/private" });
});

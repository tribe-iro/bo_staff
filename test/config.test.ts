import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Config, ConfigError } from "../src/config.ts";
import { tmpdir } from "./helpers.ts";

async function withFile(toml: string | undefined, env: Record<string, string> = {}) {
  const home = await tmpdir();
  if (toml !== undefined) {
    await mkdir(path.join(home, "bo"), { recursive: true });
    await writeFile(path.join(home, "bo", "config.toml"), toml);
  }
  return Config.load({ XDG_CONFIG_HOME: home, ...env });
}

test("precedence: flag > environment > config.toml > default, each with its source", async () => {
  const c = await withFile('url = "http://file:1"\n[run]\nengine = "codex"\nverbose = 2\n[serve]\nport = 4000\nallow_subscription_auth = true\n', { PORT: "5000" });
  assert.equal(c.exists, true);
  assert.deepEqual(c.get("serve.port", 6000), { value: 6000, source: "flag" });
  assert.deepEqual(c.get("serve.port"), { value: 5000, source: "env PORT" });
  assert.deepEqual(c.get("url"), { value: "http://file:1", source: "config.toml" });
  assert.deepEqual(c.get("run.engine"), { value: "codex", source: "config.toml" });
  assert.deepEqual(c.get("serve.max_runs"), { value: 8, source: "default" });
  assert.deepEqual(c.get("run.model"), { value: undefined, source: "default" });
  assert.deepEqual(c.get("serve.allow_subscription_auth"), { value: true, source: "config.toml" });
  const rows = c.explain();
  assert.ok(rows.some((r) => r.key === "run.verbose" && r.value === 2 && r.source === "config.toml"));
});

test("a missing file is fine; a bad file or environment value names where it came from", async () => {
  assert.equal((await withFile(undefined)).exists, false);
  await assert.rejects(withFile("[run]\nengnie = \"codex\"\n"), (e: unknown) => e instanceof ConfigError && /config\.toml: unknown key run\.engnie$/.test(e.message));
  await assert.rejects(withFile("[runs]\nx = 1\n"), /unknown table \[runs\]/);
  await assert.rejects(withFile("[run]\nverbose = 3\n"), /run\.verbose must be an integer 0–2/);
  await assert.rejects(withFile("[run\n"), (e: unknown) => e instanceof ConfigError && /config\.toml: /.test(e.message));
  const c = await withFile(undefined, { BO_MAX_RUNS: "many", BO_ALLOW_SUBSCRIPTION_AUTH: "1" });
  assert.throws(() => c.get("serve.max_runs"), /BO_MAX_RUNS must be an integer 1–1000/);
  assert.equal(c.get("serve.allow_subscription_auth").value, true);
});

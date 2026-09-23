// Live server lifecycle: shutdown with active runs, admission, auth, and the subscription-auth policy.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { BoProblem, Bo } from "../../src/client.ts";
import { LIVE_TIMEOUT, enginesUnderTest, pgrep, startBo, text, waitFor, workspace } from "./harness.ts";

const probe = await startBo();
const targets = await enginesUnderTest(probe.bo);
await probe.stop();
const live = targets.filter((t) => !t.skip);

describe("server lifecycle live", { timeout: 20 * LIVE_TIMEOUT }, () => {
  test("SIGTERM with active runs: every run is cancelled, every engine tree dies, the server exits", { timeout: LIVE_TIMEOUT }, async () => {
    const server = await startBo();
    const markers = live.map((t, i) => ({ harness: t.id, marker: `sleep ${1500 + i * 7 + Math.floor(Math.random() * 5)}` }));
    const handles = await Promise.all(markers.map(async ({ harness, marker }) => server.bo.run({
      input: text(`Run the shell command \`${marker}\` and wait for it.`), workspace: { root: await workspace() },
      engine: harness, permissions: { access: "full" },
    })));
    for (const { marker } of markers) assert.ok(await waitFor(() => pgrep(marker).length > 0, LIVE_TIMEOUT / 2, 500), `${marker} started`);
    const followers = handles.map((handle) => {
      const ready = Promise.withResolvers<void>();
      const done = (async () => {
        for await (const event of handle.events()) {
          ready.resolve();
          if (event.event === "run" && /completed|failed|cancelled/.test(event.data.status)) return event.data;
        }
        return handle.run;
      })().catch(() => handle.run);
      return { ready: ready.promise, done };
    });
    await Promise.all(followers.map((f) => f.ready));
    const stopping = Date.now();
    const code = await server.stop("SIGTERM");
    assert.equal(code, 0, server.stderr());
    assert.ok(Date.now() - stopping < 15_000, `shutdown took ${Date.now() - stopping}ms`);
    for (const run of await Promise.all(followers.map((f) => f.done))) assert.equal(run.status, "cancelled", "clients receive the terminal event before the server exits");
    for (const { marker } of markers) assert.ok(await waitFor(() => pgrep(marker).length === 0, 20_000), `${marker} survived shutdown`);
  });

  test("BO_MAX_RUNS admission and bearer auth on a live server", { timeout: LIVE_TIMEOUT }, async () => {
    const t = live[0]!;
    const server = await startBo({ BO_MAX_RUNS: "1", BO_TOKEN: "it-secret" });
    try {
      const anon = await fetch(`${server.url}/v1/engines`);
      assert.equal(anon.status, 401);
      const bo = new Bo({ url: server.url, token: "it-secret" });
      const root = await workspace();
      const first = await bo.run({ input: text("Run `sleep 30`, then reply DONE."), workspace: { root }, engine: t.id, permissions: { access: "full" } });
      await assert.rejects(bo.run({ input: text("hi"), workspace: { root }, engine: t.id }),
        (e: unknown) => e instanceof BoProblem && e.problem.type === "urn:bo:problem:too_many_runs");
      await first.cancel();
      assert.equal((await first.done()).status, "cancelled");
      const after = await bo.run({ input: text("Reply with exactly: ADMITTED"), workspace: { root }, engine: t.id });
      assert.equal((await after.done()).status, "completed");
    } finally {
      await server.stop();
    }
  });

  test("subscription logins are refused unless BO_ALLOW_SUBSCRIPTION_AUTH=1", { timeout: LIVE_TIMEOUT }, async (t) => {
    const subscription = targets.filter((x) => x.info?.authentication === "subscription");
    if (!subscription.length) return t.skip("no engine is logged in with a subscription on this machine");
    const server = await startBo({ BO_ALLOW_SUBSCRIPTION_AUTH: "" });
    try {
      const infos = await server.bo.engines();
      for (const s of subscription) {
        const info = infos.find((i) => i.id === s.id)!;
        assert.equal(info.available, false);
        assert.match(info.reason ?? "", /subscription/);
        await assert.rejects(server.bo.run({ input: text("hi"), workspace: { root: await workspace() }, engine: s.id }),
          (e: unknown) => e instanceof BoProblem && e.problem.type === "urn:bo:problem:engine_unavailable");
      }
    } finally {
      await server.stop();
    }
  });
});

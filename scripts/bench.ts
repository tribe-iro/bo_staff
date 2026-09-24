// Latency and throughput, measured.
//
//   npm run bench                 both engines, 5 runs each
//   npm run bench -- codex 3      one engine, N runs
//   npm run bench -- core         event fan-out: one run, 9 000 items, 32 SSE subscribers
//
// Engine mode uses the real CLIs, models and logins (BO_ALLOW_SUBSCRIPTION_AUTH=1 for subscription logins): each run
// is "Reply with exactly: OK" at the default model's lowest effort.

import { performance } from "node:perf_hooks";
import { Bo } from "../src/client.ts";
import { createClaudeCode } from "../src/harness/claude-code/index.ts";
import { createCodex } from "../src/harness/codex/index.ts";
import type { Harness } from "../src/harness/port.ts";
import { startServer } from "../src/http/server.ts";
import { ENGINE_IDS, TERMINAL, type EngineId } from "../src/model.ts";
import { tmpdir, scripted, ok } from "../test/helpers.ts";

const [mode = "engines", count] = process.argv.slice(2);

function stats(values: number[]): string {
  if (!values.length) return "–";
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  return `p50 ${at(0.5).toFixed(0)} ms · max ${sorted.at(-1)!.toFixed(0)} ms`;
}

async function engines(ids: readonly EngineId[], n: number): Promise<void> {
  const env = { ...process.env };
  const harnesses: Record<EngineId, Harness> = { "claude-code": createClaudeCode({ env }), codex: createCodex({ env }) };
  for (const id of ids) {
    const t = performance.now();
    const info = await harnesses[id].probe();
    process.stdout.write(`${id}: probe ${(performance.now() - t).toFixed(0)} ms${info.available ? "" : ` (unavailable: ${info.reason})`}\n`);
  }
  const server = await startServer({ port: 0, env, engines: ids.map((id) => harnesses[id]), sessionsFile: null });
  const bo = new Bo({ url: server.url });
  const catalog = await bo.engines();
  try {
    for (const id of ids) {
      const info = catalog.find((e) => e.id === id);
      if (!info?.available) continue;
      const efforts = info.models.find((m) => m.default)?.efforts ?? [];
      const toSession: number[] = [];
      const toDelta: number[] = [];
      const toEnd: number[] = [];
      for (let i = 0; i < n; i++) {
        const start = performance.now();
        const handle = await bo.run({
          input: "Reply with exactly: OK", workspace: await tmpdir("bo-bench-"), engine: id, ...(efforts[0] ? { effort: efforts[0] } : {}),
        });
        let session: number | undefined;
        let delta: number | undefined;
        for await (const e of handle.events()) {
          const now = performance.now() - start;
          if (session === undefined && e.event === "run" && e.data.session_id) session = now;
          if (delta === undefined && e.event === "delta") delta = now;
          if (e.event === "run" && TERMINAL.has(e.data.status)) break;
        }
        toEnd.push(performance.now() - start);
        if (session !== undefined) toSession.push(session);
        if (delta !== undefined) toDelta.push(delta);
      }
      process.stdout.write(`${id}: ${n} runs\n  created → session reported  ${stats(toSession)}\n  created → first delta       ${stats(toDelta)}\n  created → terminal          ${stats(toEnd)}\n`);
    }
  } finally {
    await server.close();
  }
}

async function core(): Promise<void> {
  const ITEMS = 9_000;   // a run holds at most 10 000 items (the prompt is one)
  const SUBSCRIBERS = 32;
  const gate = Promise.withResolvers<void>();
  const server = await startServer({
    port: 0, env: {}, sessionsFile: null,
    engines: [scripted("claude-code", async (_s, io) => {
      await gate.promise;
      for (let i = 0; i < ITEMS; i++) io.upsert(`n${i}`, { type: "notice", level: "info", text: `item ${i}` });
      return ok();
    })],
  });
  try {
    const run = await (await fetch(`${server.url}/v1/runs`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [{ kind: "text", text: "go" }], workspace: { root: await tmpdir("bo-bench-") } }),
    })).json() as { id: string };
    const latencies: number[] = [];
    // Real clients: a subscriber that falls more than 1 024 events behind is dropped and resumes with Last-Event-ID,
    // which the client does by itself.
    const bo = new Bo({ url: server.url });
    const subscribers = Array.from({ length: SUBSCRIBERS }, async () => {
      let seen = 0;
      const handle = await bo.runs.get(run.id);
      for await (const e of handle.events({ after: 2 })) {
        if (e.event === "item") { seen++; latencies.push(Date.now() - Date.parse(e.data.created_at)); }
        if (e.event === "run" && TERMINAL.has(e.data.status)) break;
      }
      return seen;
    });
    await new Promise((r) => setTimeout(r, 200));   // every subscriber attached
    const start = performance.now();
    gate.resolve();
    const seen = await Promise.all(subscribers);
    const seconds = (performance.now() - start) / 1000;
    const delivered = seen.reduce((a, b) => a + b, 0);
    latencies.sort((a, b) => a - b);
    process.stdout.write(`core: ${ITEMS} items × ${SUBSCRIBERS} subscribers → ${delivered} deliveries in ${seconds.toFixed(2)} s `
      + `(${Math.round(delivered / seconds)} events/s); delivery latency p50 ${latencies[Math.floor(latencies.length / 2)]} ms, `
      + `p99 ${latencies[Math.floor(latencies.length * 0.99)]} ms\n`);
  } finally {
    await server.close();
  }
}

if (mode === "core") await core();
else {
  const ids = (ENGINE_IDS as readonly string[]).includes(mode) ? [mode as EngineId] : mode === "engines" ? ENGINE_IDS : undefined;
  if (!ids) throw new Error(`usage: npm run bench [-- engines|claude-code|codex [N] | core]`);
  await engines(ids, Number(count ?? 5));
}

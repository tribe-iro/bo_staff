// Live CLI integration: the real `bin/bo.mjs` process against a real server and real models.

import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LIVE_TIMEOUT, ROOT, enginesUnderTest, pgrep, startBo, token, waitFor, workspace, type BoProcess } from "./harness.ts";

const server: BoProcess = await startBo();
after(async () => { await server.stop(); });
const targets = await enginesUnderTest(server.bo);

interface Cli { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }

function bo(args: string[], opts: { stdin?: string; cwd?: string; onStderr?: (chunk: string, child: ReturnType<typeof spawn>) => void; keepStdinOpen?: boolean } = {}): Promise<Cli> & { child: ReturnType<typeof spawn> } {
  const [command, ...rest] = args;
  const child = spawn(process.execPath, [path.join(ROOT, "bin", "bo.mjs"), command!, "--url", server.url, ...rest], {
    cwd: opts.cwd ?? ROOT, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1", XDG_CONFIG_HOME: server.stateHome },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); opts.onStderr?.(c.toString(), child); });
  if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
  if (!opts.keepStdinOpen) child.stdin.end();
  const done = new Promise<Cli>((resolve) => child.once("exit", (code, signal) => resolve({ code, signal, stdout, stderr })));
  return Object.assign(done, { child });
}

for (const target of targets) {
  const h = target.id;
  describe(`${h}: bo CLI live`, { skip: target.skip, timeout: 30 * LIVE_TIMEOUT }, () => {
    test("default: stdout is only the answer and stderr is silent; -v adds steps and the summary", { timeout: 2 * LIVE_TIMEOUT }, async () => {
      const t = token("CLI");
      const r = await bo(["run", "--engine", h, "--workspace", await workspace(), "--no-interactive", `Reply with exactly: ${t}`]);
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout.trim(), t, `stdout: ${JSON.stringify(r.stdout)}`);
      assert.equal(r.stderr, "", "a clean run says nothing but its answer");
      const v = await bo(["run", "-v", "--engine", h, "--workspace", await workspace(), "--no-interactive", `Reply with exactly: ${t}`]);
      assert.equal(v.stdout.trim(), t);
      assert.match(v.stderr, /✓ done · .+ · \d+s · [\d.]+k? in/);
      assert.match(v.stderr, /continue: bo run -c/);
    });

    test("--json: NDJSON events ending in a terminal run", { timeout: LIVE_TIMEOUT }, async () => {
      const r = await bo(["run", "--engine", h, "--workspace", await workspace(), "--json", "Reply with exactly: JSON-OK"]);
      assert.equal(r.code, 0, r.stderr);
      const events = r.stdout.trim().split("\n").map((l) => JSON.parse(l) as { event: string; id?: number; data: { status?: string } });
      assert.equal(events[0]!.event, "run");
      const last = events.at(-1)!;
      assert.equal(last.event, "run");
      assert.equal(last.data.status, "completed");
    });

    test("prompt from stdin, then continue: by session id, and with -c after a server restart", { timeout: 3 * LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const secret = token("KIWI");
      const first = await bo(["run", "--engine", h, "--workspace", root, "--json", "-"], { stdin: `Remember the code word ${secret}. Reply only with OK.` });
      assert.equal(first.code, 0, first.stderr);
      const last = JSON.parse(first.stdout.trim().split("\n").at(-1)!) as { data: { session_id: string } };
      const second = await bo(["run", "--workspace", root, "--session", last.data.session_id, "--no-interactive", "What was the code word? Reply with only the code word."]);
      assert.equal(second.code, 0, second.stderr);
      assert.ok(second.stdout.includes(secret), second.stdout);
      // The session index is durable: a new server over the same state continues the directory's latest session.
      const restarted = await startBo({ XDG_STATE_HOME: server.stateHome });
      try {
        const third = await bo(["run", "--url", restarted.url, "--workspace", root, "-c", "--no-interactive", "Say the code word again. Reply with only the code word."]);
        assert.equal(third.code, 0, third.stderr);
        assert.ok(third.stdout.includes(secret), third.stdout);
        const sessions = await bo(["sessions", "--url", restarted.url, "--workspace", root]);
        assert.match(sessions.stdout, new RegExp(`Remember the code word ${secret}\\.[^\\n]*${h}[^\\n]*\\s3\\s`));
      } finally {
        await restarted.stop();
      }
    });

    test("--interactive approval answered on stdin", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      let answered = false;
      const r = await bo(["run", "--engine", h, "--workspace", root, "--access", "read", "--interactive", "Create b.txt containing ok."], {
        keepStdinOpen: true,
        onStderr: (chunk, child) => {
          if (!answered && chunk.includes("[y] yes")) { answered = true; child.stdin!.write("y\n"); }
        },
      });
      assert.ok(answered, `no approval prompt:\n${r.stderr}`);
      assert.equal(r.code, 0, r.stderr);
      assert.ok(existsSync(path.join(root, "b.txt")));
    });

    test("--schema prints the structured result as JSON", { timeout: LIVE_TIMEOUT }, async () => {
      const root = await workspace();
      const schema = path.join(root, "schema.json");
      await writeFile(schema, JSON.stringify({ type: "object", properties: { answer: { type: "integer" } }, required: ["answer"], additionalProperties: false }));
      const r = await bo(["run", "--engine", h, "--workspace", root, "--schema", schema, "--no-interactive", "What is 6 times 7?"]);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), { answer: 42 });
    });

    test("Ctrl-C cancels the run, exits 130, and kills the engine tree", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = `sleep ${1200 + Math.floor(Math.random() * 90)}`;
      const run = bo(["run", "--engine", h, "--workspace", await workspace(), "--access", "full", "--no-interactive", `Run the shell command \`${marker}\` and wait for it.`]);
      // The default output is quiet, so the trigger is the engine's process itself, not a progress line.
      // Anchored: the bo CLI's own command line contains the marker too (in its prompt).
      const started = await waitFor(() => pgrep(`^${marker}$`).length > 0, LIVE_TIMEOUT / 2, 250);
      run.child.kill("SIGINT");
      const r = await run;
      assert.ok(started, `${marker} never started: ${r.stderr}`);
      assert.equal(r.code, 130, r.stderr);
      assert.ok(await waitFor(() => pgrep(marker).length === 0, 20_000), `${marker} still running`);
    });

    test("follow, runs, cancel on a live run", { timeout: LIVE_TIMEOUT }, async () => {
      const marker = `sleep ${1300 + Math.floor(Math.random() * 90)}`;
      const handle = await server.bo.run({ input: [{ kind: "text", text: `Run the shell command \`${marker}\` and wait for it.` }], workspace: { root: await workspace() }, engine: h, permissions: { access: "full" } });
      const attached = bo(["follow", handle.id]);
      assert.ok(await waitFor(() => pgrep(marker).length > 0, LIVE_TIMEOUT / 2, 500), "agent started the command");
      const ps = await bo(["runs"]);
      assert.match(ps.stdout, new RegExp(`${handle.id}\\s+running`));
      const cancel = await bo(["cancel", handle.id]);
      assert.equal(cancel.code, 0, cancel.stderr);
      const a = await attached;
      assert.equal(a.code, 130, a.stderr);
      assert.ok(await waitFor(() => pgrep(marker).length === 0, 20_000));
    });
  });
}

test("engines and problems", async () => {
  const hs = await bo(["engines"]);
  assert.equal(hs.code, 0);
  for (const t of targets) assert.match(hs.stdout, new RegExp(`^[●○] ${t.id} `, "m"));
  const usage = await bo(["bogus"]);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /^bo: unknown command "bogus"\n/);
  const problem = await bo(["run", "--workspace", "/definitely/not/here", "hi"]);
  assert.equal(problem.code, 2);
  assert.match(problem.stderr, /^bo: the run spec is invalid\n  workspace\.root  must exist\n/);
});

import test from "node:test";
import assert from "node:assert/strict";
import { BoStaffClient, BoStaffClientHttpError, BoStaffClientStreamError } from "../../src/client.ts";
import { main as runCli } from "../../src/cli.ts";

test("client parses NDJSON execution streams", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({
        event: "execution.accepted",
        request_id: "req_1",
        execution_id: "exec_1",
        emitted_at: new Date().toISOString(),
        data: {}
      }) + "\n"));
      controller.enqueue(encoder.encode(JSON.stringify({
        event: "execution.completed",
        request_id: "req_1",
        execution_id: "exec_1",
        emitted_at: new Date().toISOString(),
        data: {}
      }) + "\n"));
      controller.close();
    }
  });
  const client = new BoStaffClient({
    baseUrl: "http://example.test",
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson"
      }
    })
  });

  const events: string[] = [];
  for await (const event of client.executeStream({
    backend: "codex",
    task: { prompt: "x" },
    session: { mode: "ephemeral" },
    workspace: { source_root: process.cwd() },
    output: { schema: { type: "object" } }
  })) {
    events.push(event.event);
  }

  assert.deepEqual(events, ["execution.accepted", "execution.completed"]);
});

test("cli prints remote HTTP validation errors cleanly and exits nonzero", async () => {
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  let stderr = "";
  let exitCode: number | undefined;
  const exitSignal = new Error("process.exit");

  try {
    globalThis.fetch = async () => new Response(JSON.stringify({
      error: {
        code: "validation_error",
        message: "schema is invalid"
      }
    }), {
      status: 400,
      headers: {
        "content-type": "application/json"
      }
    });
    process.exit = ((code?: number) => {
      exitCode = code ?? 0;
      throw exitSignal;
    }) as typeof process.exit;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    }) as typeof process.stderr.write;

    await assert.rejects(
      () => runCli(["--url", "http://example.test", "x"]),
      (error: unknown) => error === exitSignal
    );

    assert.equal(exitCode, 1);
    assert.match(stderr, /schema is invalid/);
    assert.doesNotMatch(stderr, /BoStaffClientHttpError/);
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stderr.write = originalStderrWrite;
  }
});

test("client getSession returns undefined on 404", async () => {
  const client = new BoStaffClient({
    baseUrl: "http://example.test",
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: "not_found",
        message: "missing"
      }
    }), {
      status: 404,
      headers: {
        "content-type": "application/json"
      }
    })
  });

  const session = await client.getSession("missing");
  assert.equal(session, undefined);
});

test("client getExecution returns undefined on 404", async () => {
  const client = new BoStaffClient({
    baseUrl: "http://example.test",
    fetchImpl: async () => new Response(JSON.stringify({
      error: {
        code: "not_found",
        message: "missing"
      }
    }), {
      status: 404,
      headers: {
        "content-type": "application/json"
      }
    })
  });

  const execution = await client.getExecution("exec_missing");
  assert.equal(execution, undefined);
});

test("client preserves malformed remote response bodies as remote failures", async () => {
  const client = new BoStaffClient({
    baseUrl: "http://example.test",
    fetchImpl: async () => new Response("<html>bad gateway</html>", {
      status: 502,
      headers: {
        "content-type": "text/html"
      }
    })
  });

  await assert.rejects(
    () => client.execute({
      backend: "codex",
      task: { prompt: "x" }
    }),
    (error: unknown) => {
      assert.ok(error instanceof BoStaffClientHttpError);
      assert.equal(error.status, 502);
      assert.match(error.message, /bad gateway/i);
      return true;
    }
  );
});

test("client surfaces malformed NDJSON lines as stream errors", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode("{not-json}\n"));
      controller.close();
    }
  });
  const client = new BoStaffClient({
    baseUrl: "http://example.test",
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson"
      }
    })
  });

  await assert.rejects(
    async () => {
      for await (const _event of client.executeStream({
        backend: "codex",
        task: { prompt: "x" }
      })) {
        // consume
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof BoStaffClientStreamError);
      assert.match(error.message, /Malformed NDJSON event/);
      return true;
    }
  );
});

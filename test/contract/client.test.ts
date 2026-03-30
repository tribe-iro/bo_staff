import test from "node:test";
import assert from "node:assert/strict";
import { BoStaffClient, BoStaffClientHttpError, BoStaffClientStreamError } from "../../src/client.ts";


test("client parses NDJSON execution streams", async () => {
  const encoder = new TextEncoder();
  const now = new Date().toISOString();
  const sender = { type: "runtime" as const, id: "test" };
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({
        message_id: "m1",
        execution_id: "exec_1",
        kind: "execution.started",
        sequence: 1,
        timestamp: now,
        sender,
        request_id: "req_1",
        payload: { backend: "codex" }
      }) + "\n"));
      controller.enqueue(encoder.encode(JSON.stringify({
        message_id: "m2",
        execution_id: "exec_1",
        kind: "execution.completed",
        sequence: 2,
        timestamp: now,
        sender,
        request_id: "req_1",
        payload: { execution_id: "exec_1", status: "completed" }
      }) + "\n"));
      controller.close();
    }
  });
  const client = new BoStaffClient({
    url: "http://example.test",
    fetchImpl: async () => new Response(stream, {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson"
      }
    })
  });

  const events: Array<{ kind: string; execution_id?: string; senderId: string }> = [];
  for await (const event of client.executeStream({
    backend: "codex",
    execution_profile: { model: "gpt-5" },
    task: { prompt: "x" },
    workspace: { source_root: process.cwd() },
    output: { schema: { type: "object" } }
  })) {
    events.push({ kind: event.kind, execution_id: event.execution_id, senderId: event.sender.id });
  }

  assert.deepEqual(events, [
    { kind: "execution.started", execution_id: "exec_1", senderId: "test" },
    { kind: "execution.completed", execution_id: "exec_1", senderId: "test" },
  ]);
});

test("client getExecution returns undefined on 404", async () => {
  const client = new BoStaffClient({
    url: "http://example.test",
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
    url: "http://example.test",
    fetchImpl: async () => new Response("<html>bad gateway</html>", {
      status: 502,
      headers: {
        "content-type": "text/html"
      }
    })
  });

  await assert.rejects(
    () => client.health(),
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
    url: "http://example.test",
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
        execution_profile: { model: "gpt-5" },
        task: { prompt: "x" }
      })) {
        // consume
      }
    },
    (error: unknown) => {
      assert.ok(error instanceof BoStaffClientStreamError);
      assert.match(error.message, /Malformed NDJSON/);
      return true;
    }
  );
});

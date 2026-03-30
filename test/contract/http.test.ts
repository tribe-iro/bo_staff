import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  handleExecuteStream,
  readJsonBody,
  writeRejectedStream
} from "../../src/http/handlers/executions.ts";
import { handleRun } from "../../src/http/handlers/run.ts";
import { buildSyncResult } from "../../src/api/sync-response.ts";
import { routeHttp } from "../../src/http/router.ts";

class MockResponse extends EventEmitter {
  statusCode = 0;
  headers: Record<string, string> = {};
  chunks: string[] = [];
  writableEnded = false;
  destroyed = false;

  writeHead(status: number, headers: Record<string, string>) {
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  write(chunk: string) {
    this.chunks.push(chunk);
    return true;
  }

  end(bodyOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void) {
    if (typeof bodyOrCallback === "string") {
      this.chunks.push(bodyOrCallback);
    }
    this.writableEnded = true;
    const done = typeof bodyOrCallback === "function" ? bodyOrCallback : callback;
    if (done) {
      done();
    }
    return this;
  }

  text(): string {
    return this.chunks.join("");
  }
}

test("stream handler converts post-header execution throws into NDJSON failure events", async () => {
  const response = new MockResponse();
  await handleExecuteStream(
    response as never,
    {
      async execute() {
        throw new Error("boom after stream start");
      }
    } as never,
    {},
    "req_1"
  );

  assert.equal(response.statusCode, 200);
  const lines = response.text().trim().split("\n").map((line) => JSON.parse(line));
  const errorEvent = lines.find((e: { kind?: string }) => e.kind === "system.error");
  assert.ok(errorEvent, "should emit system.error event");
  assert.match(errorEvent.payload.message, /boom after stream start/);
});

test("GET /health failures are contained as structured server errors", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "GET", url: "/health" } as never,
    response: response as never,
    gateway: {
      async health() {
        throw new Error("boom");
      }
    } as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 500);
  const body = JSON.parse(response.text()) as { error: { code: string; message: string } };
  assert.equal(body.error.code, "runtime_error");
  assert.match(body.error.message, /boom/);
});

test("GET /executions/:id returns live execution state", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "GET", url: "/executions/exec_1" } as never,
    response: response as never,
    gateway: {
      getActiveExecution() {
        return {
          execution_id: "exec_1",
          status: "running",
          backend: "claude",
          started_at: new Date().toISOString(),
          artifacts: new Map(),
          processed_request_ids: new Map(),
          lease: { execution_id: "exec_1", allowed_tools: [], issued_at: new Date().toISOString() },
        };
      }
    } as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.text()) as { execution_id: string; status: string };
  assert.equal(body.execution_id, "exec_1");
  assert.equal(body.status, "running");
});

test("GET /executions/:id returns 404 for inactive execution", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "GET", url: "/executions/exec_missing" } as never,
    response: response as never,
    gateway: {
      getActiveExecution() { return undefined; }
    } as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 404);
});

test("pre-dispatch stream rejection emits system.error", async () => {
  const response = new MockResponse();
  await writeRejectedStream(response as never, "req_1", {
    code: "invalid_json",
    message: "bad body",
  });

  assert.equal(response.statusCode, 200);
  const lines = response.text().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].kind, "system.error");
  assert.equal(lines[0].payload.code, "invalid_json");
});

test("cancel execution endpoint is routed", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "POST", url: "/executions/exec_1/cancel" } as never,
    response: response as never,
    gateway: {
      async cancelExecution() {
        return "accepted" as const;
      }
    } as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 202);
  const body = JSON.parse(response.text()) as { cancelled: boolean; execution_id: string };
  assert.equal(body.cancelled, true);
  assert.equal(body.execution_id, "exec_1");
});

test("removed operator endpoints are not routed", async () => {
  const response = new MockResponse();
  for (const endpoint of [
    "/executions/exec_1/resume",
    "/executions/exec_1/input",
    "/executions/exec_1/approve",
    "/executions/exec_1/deny",
  ]) {
    const handled = await routeHttp({
      request: { method: "POST", url: endpoint } as never,
      response: response as never,
      gateway: {} as never,
      maxBodyBytes: 1024,
    });
    assert.equal(handled, false);
  }
});

test("handleRun reuses the pre-normalized request instead of calling gateway.execute(raw)", async () => {
  const response = new MockResponse();
  let executeNormalizedCalled = false;

  await handleRun(
    response as never,
    {
      async execute() {
        throw new Error("handleRun should not call gateway.execute after pre-normalizing");
      },
      async executeNormalized(input: {
        request: unknown;
        lease?: unknown;
        streamWriter: (envelope: unknown) => Promise<void>;
      }) {
        executeNormalizedCalled = true;
        await input.streamWriter({
          execution_id: "exec_1",
          message_id: "msg_1",
          kind: "execution.completed",
          sequence: 1,
          timestamp: new Date().toISOString(),
          sender: { type: "runtime", id: "runtime" },
          payload: {
            execution_id: "exec_1",
            status: "completed",
            output: JSON.stringify({ payload: { content: "ok" }, artifacts: [] }),
            artifacts: [],
          },
        });
      }
    } as never,
    { prompt: "fix the tests" },
    "req_1"
  );

  assert.equal(executeNormalizedCalled, true);
  assert.equal(response.statusCode, 200);
});

test("readJsonBody rejects non-json content types", async () => {
  await assert.rejects(
    () => readJsonBody({
      headers: { "content-type": "text/plain" },
      async *[Symbol.asyncIterator]() {
        yield Buffer.from("{}");
      }
    } as never, 1024),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 415);
      return true;
    }
  );
});

test("unknown routes return false", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "DELETE", url: "/sessions/foo" } as never,
    response: response as never,
    gateway: {} as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, false);
});

test("buildSyncResult deduplicates artifacts emitted during execution and completion", () => {
  const result = buildSyncResult([
    {
      execution_id: "exec_1",
      message_id: "msg_1",
      kind: "artifact.registered",
      sequence: 1,
      timestamp: new Date().toISOString(),
      sender: { type: "runtime", id: "runtime" },
      payload: { kind: "report", path: "out.txt" },
    },
    {
      execution_id: "exec_1",
      message_id: "msg_2",
      kind: "execution.completed",
      sequence: 2,
      timestamp: new Date().toISOString(),
      sender: { type: "runtime", id: "runtime" },
      payload: {
        execution_id: "exec_1",
        status: "completed",
        output: JSON.stringify({ payload: { content: "ok" } }),
        artifacts: [{ kind: "report", path: "out.txt" }],
      },
    },
  ] as never);

  assert.equal(result.artifacts.length, 1);
  assert.deepEqual(result.artifacts[0], { kind: "report", path: "out.txt", metadata: undefined });
});

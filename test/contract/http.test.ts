import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  handleExecuteStream,
  readJsonBody,
  writeRejectedStream
} from "../../src/http/handlers/executions.ts";
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

test("stream rejection stays parseable as NDJSON", async () => {
  const response = new MockResponse();
  await handleExecuteStream(
    response as never,
    {
      async execute(_: unknown, __: string, options?: { onEvent?: (event: unknown) => void }) {
        await options?.onEvent?.({
          event: "execution.rejected",
          request_id: "req_1",
          execution_id: "exec_1",
          emitted_at: new Date().toISOString(),
          data: {
            reason: "validation"
          }
        });
        return {
          httpStatus: 400,
          body: {} as never,
          events: []
        };
      }
    } as never,
    {},
    "req_1"
  );

  assert.equal(response.statusCode, 200);
  const events = response.text().trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(events[0].event, "execution.rejected");
});

test("GET endpoint failures are contained as structured server errors", async () => {
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

test("execution lookup endpoints are routed", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "GET", url: "/executions/exec_1" } as never,
    response: response as never,
    gateway: {
      async getExecution() {
        return {
          api_version: "v0.1",
          request_id: "req_1",
          execution: {
            execution_id: "exec_1",
            status: "completed",
            terminal: true,
            degraded: false,
            retryable: false,
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
          },
          persistence: {
            status: "persisted"
          },
          execution_profile: {
            requested_performance_tier: "balanced",
            requested_reasoning_tier: "standard",
            selection_mode: "managed",
            resolved_backend_model: "gpt-5",
            resolution_source: "managed"
          },
          session: {
            handle: null,
            continuity_kind: "none",
            durability_kind: "ephemeral"
          },
          workspace: {
            topology: "direct",
            scope_status: "unbounded",
            writeback_status: "not_requested",
            materialization_status: "not_requested"
          },
          capabilities: {} as never,
          result: {
            summary: "ok",
            payload: {},
            pending_items: []
          },
          artifacts: [],
          control_gates: {
            pending: [],
            resolved: []
          },
          errors: []
        };
      }
    } as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.text()) as { execution: { execution: { execution_id: string } } };
  assert.equal(body.execution.execution.execution_id, "exec_1");
});

test("pre-dispatch stream rejection does not fabricate an execution handle", async () => {
  const response = new MockResponse();
  await writeRejectedStream(response as never, "req_1", {
    code: "invalid_json",
    message: "bad body",
    httpStatus: 400
  });

  assert.equal(response.statusCode, 200);
  const [event] = response.text().trim().split("\n").map((line) => JSON.parse(line) as {
    execution_id: string | null;
    data: { http_status: number };
  });
  assert.equal(event.execution_id, null);
  assert.equal(event.data.http_status, 400);
});

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
  const [event] = response.text().trim().split("\n").map((line) => JSON.parse(line) as {
    event: string;
    data: { code: string; message: string };
  });
  assert.equal(event.event, "execution.failed");
  assert.equal(event.data.code, "runtime_error");
  assert.match(event.data.message, /boom after stream start/);
});

test("stream disconnect cancels an execution created before the first event", async () => {
  const response = new MockResponse();
  let cancelledExecutionId: string | undefined;
  await handleExecuteStream(
    response as never,
    {
      async execute(_: unknown, __: string, options?: {
        onExecutionCreated?: (executionId: string) => Promise<void> | void;
        onEvent?: (event: unknown) => Promise<void> | void;
      }) {
        await options?.onExecutionCreated?.("exec_1");
        response.emit("close");
        return {
          httpStatus: 200,
          body: {} as never,
          events: []
        };
      },
      async cancelExecution(executionId: string) {
        cancelledExecutionId = executionId;
        return "accepted" as const;
      }
    } as never,
    {},
    "req_1"
  );

  assert.equal(cancelledExecutionId, "exec_1");
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

test("router rejects invalid session handles on path endpoints", async () => {
  const response = new MockResponse();
  const handled = await routeHttp({
    request: { method: "DELETE", url: "/sessions/%2Fescape" } as never,
    response: response as never,
    gateway: {} as never,
    maxBodyBytes: 1024
  });

  assert.equal(handled, true);
  assert.equal(response.statusCode, 400);
  const body = JSON.parse(response.text()) as { error: { code: string } };
  assert.equal(body.error.code, "invalid_session_handle");
});

import { parentPort, workerData } from "node:worker_threads";
import { SqliteBoStaffRepository } from "./sqlite.ts";
import type { BoStaffRepository } from "./types.ts";

interface WorkerRequest {
  id: number;
  method: keyof BoStaffRepository;
  args: unknown[];
}

interface WorkerSuccess {
  id: number;
  ok: true;
  value: unknown;
}

interface WorkerFailure {
  id: number;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
    code?: string;
    httpStatus?: number;
  };
}

const port = parentPort;
if (!port) {
  throw new Error("sqlite-worker requires a parent port");
}
const workerPort = port;

const repository = new SqliteBoStaffRepository((workerData as { dataDir: string }).dataDir);

workerPort.on("message", (message: WorkerRequest) => {
  void handleMessage(message);
});

async function handleMessage(message: WorkerRequest): Promise<void> {
  try {
    const method = repository[message.method] as (...args: unknown[]) => Promise<unknown>;
    const value = await method.apply(repository, message.args);
    const response: WorkerSuccess = {
      id: message.id,
      ok: true,
      value
    };
    workerPort.postMessage(response);
  } catch (error) {
    const response: WorkerFailure = {
      id: message.id,
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        code: typeof (error as { code?: unknown })?.code === "string"
          ? (error as { code: string }).code
          : undefined,
        httpStatus: typeof (error as { httpStatus?: unknown })?.httpStatus === "number"
          ? (error as { httpStatus: number }).httpStatus
          : undefined
      }
    };
    workerPort.postMessage(response);
  }
}

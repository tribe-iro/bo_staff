import { createServer } from "node:http";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createBoStaff } from "./create-gateway.ts";
import { writeJsonError } from "./http/errors.ts";
import { routeHttp } from "./http/router.ts";
import { generateHandle } from "./utils.ts";

export async function createBoStaffServer() {
  const dataDir = process.env.BO_STAFF_DATA_DIR ?? path.join(process.cwd(), ".bo_staff");
  const maxBodyBytes = Number(process.env.BO_STAFF_MAX_BODY_BYTES ?? 1024 * 1024);
  const gateway = await createBoStaff({
    dataDir,
    profilesFile: process.env.BO_STAFF_PROFILES_FILE,
    maxConcurrentExecutions: parsePositiveInt(process.env.BO_STAFF_MAX_CONCURRENT_EXECUTIONS)
  });

  const server = createServer(async (request, response) => {
    const handled = await routeHttp({
      request,
      response,
      gateway,
      maxBodyBytes: Number.isFinite(maxBodyBytes) && maxBodyBytes > 0 ? maxBodyBytes : 1024 * 1024
    });
    if (handled) {
      return;
    }

    writeJsonError(response, {
      requestId: generateHandle("req"),
      status: 404,
      code: "not_found",
      message: "Not found"
    });
  });
  attachGracefulShutdown(server, gateway);
  return server;
}

export function formatStartupError(input: { error: unknown; host: string; port: number }): string {
  const { error, host, port } = input;
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "EADDRINUSE") {
      return `Port ${port} is already in use on ${host}. Stop the other process or start bo_staff with PORT=${port + 1} npm start.`;
    }
    if (code === "EACCES") {
      return `Permission denied while binding ${host}:${port}. Choose a different port with PORT=<port> npm start.`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function startBoStaffServer(input?: { host?: string; port?: number }): Promise<Server> {
  const host = input?.host ?? process.env.HOST ?? "127.0.0.1";
  const port = input?.port ?? Number(process.env.PORT ?? 3000);
  const server = await createBoStaffServer();
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(port, host, onListening);
  });
  return server;
}

function attachGracefulShutdown(server: Server, gateway: Awaited<ReturnType<typeof createBoStaff>>): void {
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    process.stderr.write(`Received ${signal}; draining bo_staff...\n`);
    const serverClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.shutdown();
    await serverClosed;
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  startBoStaffServer({ host, port })
    .then(() => {
      process.stdout.write(`bo_staff listening on http://${host}:${port}\n`);
    })
    .catch((error) => {
      process.stderr.write(`${formatStartupError({ error, host, port })}\n`);
      process.exitCode = 1;
    });
}

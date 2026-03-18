import { spawn } from "node:child_process";
import { TextDecoder } from "node:util";
import { UpstreamRuntimeError } from "../errors.ts";

const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const STDIN_CHUNK_BYTES = 64 * 1024;
const SIGTERM_GRACE_MS = 3_000;
type OutputStreamName = "stdout" | "stderr";
type TerminationReason = "exited" | "timed_out" | "stdout_overflow" | "stderr_overflow" | "aborted";

export type CommandStreamEvent =
  | { type: "stdout"; text: string }
  | { type: "stderr"; text: string }
  | {
    type: "terminated";
    reason: TerminationReason;
    exitCode: number | null;
    stdout: string;
    stderr: string;
  };

interface StreamAccumulator {
  readonly stream: OutputStreamName;
  readonly decoder: TextDecoder;
  text: string;
  bytes: number;
}

export async function* streamCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  stdinText?: string;
  signal?: AbortSignal;
}): AsyncGenerator<CommandStreamEvent, void, void> {
  const { command, args, cwd, env, timeoutMs, stdinText, signal } = input;
  const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const stdout = createAccumulator("stdout");
  const stderr = createAccumulator("stderr");
  let terminationReason: TerminationReason = "exited";
  let terminated = false;
  let exitCode: number | null = 1;
  let pendingError: unknown;
  let sigkillTimer: NodeJS.Timeout | undefined;
  const queue: CommandStreamEvent[] = [];
  let notifier: (() => void) | undefined;

  const notify = () => {
    const current = notifier;
    notifier = undefined;
    current?.();
  };

  const waitForEvent = async () => {
    if (queue.length > 0 || terminated || pendingError) {
      return;
    }
    await new Promise<void>((resolve) => {
      notifier = resolve;
    });
  };

  const killGracefully = (reason: Exclude<TerminationReason, "exited">) => {
    if (terminationReason === "exited") {
      terminationReason = reason;
    }
    child.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      child.kill("SIGKILL");
    }, SIGTERM_GRACE_MS);
  };

  const timer = setTimeout(() => {
    killGracefully("timed_out");
  }, timeoutMs);
  const onAbort = () => {
    killGracefully("aborted");
  };
  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const appendOutput = (accumulator: StreamAccumulator, chunk: Buffer | string) => {
    if (terminationReason !== "exited") {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextBytes = accumulator.bytes + buffer.length;
    if (nextBytes > maxOutputBytes) {
      const remainingBytes = Math.max(0, maxOutputBytes - accumulator.bytes);
      if (remainingBytes > 0) {
        const safePrefix = buffer.subarray(0, findUtf8SafePrefixLength(buffer, remainingBytes));
        const text = accumulator.decoder.decode(safePrefix, { stream: true });
        accumulator.text += text;
        accumulator.bytes += safePrefix.length;
        if (text) {
          queue.push({ type: accumulator.stream, text });
        }
      }
      killGracefully(accumulator.stream === "stdout" ? "stdout_overflow" : "stderr_overflow");
      notify();
      return;
    }

    const text = accumulator.decoder.decode(buffer, { stream: true });
    accumulator.text += text;
    accumulator.bytes = nextBytes;
    if (text) {
      queue.push({ type: accumulator.stream, text });
      notify();
    }
  };

  child.stdout.on("data", (chunk) => appendOutput(stdout, chunk));
  child.stderr.on("data", (chunk) => appendOutput(stderr, chunk));
  void writeStdinText(child.stdin, stdinText).catch((error) => {
    pendingError = error;
    killGracefully("aborted");
    notify();
  });
  child.on("error", (error) => {
    pendingError = error;
    notify();
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
      sigkillTimer = undefined;
    }
    exitCode = code;
    terminated = true;
    const flushedStdout = stdout.decoder.decode();
    const flushedStderr = stderr.decoder.decode();
    stdout.text += flushedStdout;
    stderr.text += flushedStderr;
    if (flushedStdout) {
      queue.push({ type: "stdout", text: flushedStdout });
    }
    if (flushedStderr) {
      queue.push({ type: "stderr", text: flushedStderr });
    }
    queue.push({
      type: "terminated",
      reason: terminationReason,
      exitCode,
      stdout: stdout.text,
      stderr: stderr.text
    });
    notify();
  });

  try {
    while (true) {
      await waitForEvent();
      if (pendingError) {
        throw pendingError;
      }
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (terminated) {
        break;
      }
    }
  } finally {
    clearTimeout(timer);
    if (sigkillTimer) {
      clearTimeout(sigkillTimer);
    }
    if (signal) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

async function writeStdinText(
  stream: NonNullable<ReturnType<typeof spawn>["stdin"]>,
  text: string | undefined
): Promise<void> {
  if (text === undefined) {
    stream.end();
    return;
  }
  for (let offset = 0; offset < text.length; offset += STDIN_CHUNK_BYTES) {
    const chunk = text.slice(offset, offset + STDIN_CHUNK_BYTES);
    const accepted = stream.write(chunk);
    if (!accepted) {
      await waitForWritableDrain(stream);
    }
  }
  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function waitForWritableDrain(stream: NonNullable<ReturnType<typeof spawn>["stdin"]>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
    };
    stream.on("drain", onDrain);
    stream.on("error", onError);
  });
}

export async function runCommand(input: {
  command: string;
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxOutputBytes?: number;
  stdinText?: string;
}): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let terminal: Extract<CommandStreamEvent, { type: "terminated" }> | undefined;
  for await (const event of streamCommand(input)) {
    if (event.type === "terminated") {
      terminal = event;
    }
  }

  if (!terminal) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  if (terminal.reason === "timed_out") {
    throw new UpstreamRuntimeError(`Command timed out after ${input.timeoutMs}ms: ${input.command}`);
  }
  if (terminal.reason === "aborted") {
    throw new UpstreamRuntimeError(`Command aborted: ${input.command}`);
  }
  if (terminal.reason === "stdout_overflow") {
    throw new UpstreamRuntimeError(`Command stdout exceeded ${input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES} bytes: ${input.command}`);
  }
  if (terminal.reason === "stderr_overflow") {
    throw new UpstreamRuntimeError(`Command stderr exceeded ${input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES} bytes: ${input.command}`);
  }

  return {
    stdout: terminal.stdout,
    stderr: terminal.stderr,
    exitCode: terminal.exitCode ?? 1
  };
}

function createAccumulator(stream: OutputStreamName): StreamAccumulator {
  return {
    stream,
    decoder: new TextDecoder("utf-8"),
    text: "",
    bytes: 0
  };
}

function findUtf8SafePrefixLength(buffer: Buffer, maxBytes: number): number {
  let end = Math.min(buffer.length, maxBytes);
  if (end === buffer.length) {
    return end;
  }
  let start = end;
  while (start > 0 && isUtf8ContinuationByte(buffer[start - 1])) {
    start -= 1;
  }
  if (start === 0) {
    return 0;
  }
  const expectedLength = utf8SequenceLength(buffer[start - 1]);
  const actualLength = end - (start - 1);
  return actualLength >= expectedLength ? end : start - 1;
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceLength(value: number): number {
  if ((value & 0b1000_0000) === 0) {
    return 1;
  }
  if ((value & 0b1110_0000) === 0b1100_0000) {
    return 2;
  }
  if ((value & 0b1111_0000) === 0b1110_0000) {
    return 3;
  }
  if ((value & 0b1111_1000) === 0b1111_0000) {
    return 4;
  }
  return 1;
}

import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";

export interface DataDirLock {
  release(): Promise<void>;
}

export async function acquireDataDirLock(dataDir: string): Promise<DataDirLock> {
  await mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, ".bo-staff.lock");
  const handle = await acquireExclusiveLock(lockPath);
  try {
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      acquired_at: new Date().toISOString()
    }, null, 2), "utf8");
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    async release() {
      await handle.close().catch(() => undefined);
      await rm(lockPath, { force: true }).catch(() => undefined);
    }
  };
}

async function acquireExclusiveLock(lockPath: string): Promise<import("node:fs/promises").FileHandle> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }

    const stale = await isStaleLockFile(lockPath);
    if (!stale) {
      throw new Error(`bo_staff data directory is already locked: ${lockPath}`);
    }
    const quarantinePath = `${lockPath}.stale.${process.pid}.${randomUUID()}`;
    try {
      await rename(lockPath, quarantinePath);
      await rm(quarantinePath, { force: true }).catch(() => undefined);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        continue;
      }
    }
  }
  throw new Error(`bo_staff data directory is already locked: ${lockPath}`);
}

async function isStaleLockFile(lockPath: string): Promise<boolean> {
  let pid: unknown;
  try {
    const raw = await readFile(lockPath, "utf8");
    pid = JSON.parse(raw).pid;
  } catch {
    return true;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

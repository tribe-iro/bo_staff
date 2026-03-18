export class SessionLeaseManager {
  private readonly active = new Set<string>();

  tryAcquire(handle: string | null): boolean {
    if (!handle) {
      return true;
    }
    if (this.active.has(handle)) {
      return false;
    }
    this.active.add(handle);
    return true;
  }

  release(handle: string | null): void {
    if (!handle) {
      return;
    }
    this.active.delete(handle);
  }

  async withLease<T>(handle: string | null, operation: () => Promise<T>): Promise<{ acquired: true; value: T } | { acquired: false }> {
    if (!this.tryAcquire(handle)) {
      return { acquired: false };
    }
    try {
      return {
        acquired: true,
        value: await operation()
      };
    } finally {
      this.release(handle);
    }
  }
}

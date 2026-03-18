export class ExecutionAdmissionController {
  private readonly maxConcurrent: number;
  private inFlight = 0;
  private draining = false;
  private readonly waiters = new Set<() => void>();
  private drainPromise?: Promise<void>;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  tryAcquire(): boolean {
    if (this.draining || this.inFlight >= this.maxConcurrent) {
      return false;
    }
    this.inFlight += 1;
    return true;
  }

  release(): void {
    if (this.inFlight > 0) {
      this.inFlight -= 1;
    }
    if (this.draining && this.inFlight === 0) {
      this.notifyWaiters();
    }
  }

  async drain(): Promise<void> {
    this.draining = true;
    if (this.inFlight === 0) {
      return;
    }
    if (!this.drainPromise) {
      this.drainPromise = new Promise<void>((resolve) => {
        this.waiters.add(resolve);
      }).finally(() => {
        this.drainPromise = undefined;
      });
    }
    await this.drainPromise;
  }

  isDraining(): boolean {
    return this.draining;
  }

  resume(): void {
    if (this.inFlight !== 0) {
      throw new Error("Cannot resume admission control while executions are still in flight");
    }
    this.draining = false;
  }

  private notifyWaiters(): void {
    for (const waiter of this.waiters) {
      waiter();
    }
    this.waiters.clear();
  }
}

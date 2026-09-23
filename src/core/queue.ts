export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly buffer: T[] = [];
  private waiter?: (r: IteratorResult<T>) => void;
  private closed = false;
  private readonly capacity: number;

  constructor(capacity = Number.POSITIVE_INFINITY) {
    if (capacity < 0 || Number.isNaN(capacity)) throw new RangeError("queue capacity must be non-negative");
    this.capacity = capacity;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get size(): number {
    return this.buffer.length;
  }

  push(value: T): boolean {
    if (this.closed) return false;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value, done: false });
    } else if (this.buffer.length < this.capacity) {
      this.buffer.push(value);
    } else return false;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = undefined;
      w({ value: undefined, done: true });
    }
  }

  next(): Promise<IteratorResult<T>> {
    if (this.buffer.length) return Promise.resolve({ value: this.buffer.shift()!, done: false });
    if (this.closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => { this.waiter = resolve; });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}

export class OperationQueue {
  private chain: Promise<unknown> = Promise.resolve();

  enqueue<T>(operation: () => Promise<T>): Promise<T> {
    // Keep the queue moving even if the previous operation rejected; each
    // caller receives its own success or failure from `next`.
    const next = this.chain.then(operation, () => operation());
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}

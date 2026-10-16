export interface ScheduledAsyncOperation {
  readonly done: Promise<void>;
  readonly cancel: () => void;
}

export class SerializedAsyncQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  schedule(delayMs: number, operation: () => Promise<void>): ScheduledAsyncOperation {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timer = null;
      void this.run(operation).then(resolveDone, resolveDone);
    }, delayMs);

    return {
      done,
      cancel: () => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
        resolveDone();
      },
    };
  }

  async drain(): Promise<void> {
    while (true) {
      const tail = this.tail;
      await tail;
      if (tail === this.tail) return;
    }
  }
}

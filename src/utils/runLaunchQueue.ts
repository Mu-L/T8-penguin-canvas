export interface RunLaunchQueue {
  readonly busy: boolean;
  readonly size: number;
  acquire: () => Promise<() => void>;
}

/**
 * Serializes the short, shared launch phase (preflight + durable Run creation)
 * without serializing the Provider execution that follows it.
 */
export function createRunLaunchQueue(): RunLaunchQueue {
  let tail = Promise.resolve();
  let size = 0;

  return {
    get busy() {
      return size > 0;
    },
    get size() {
      return size;
    },
    async acquire() {
      size += 1;
      let releaseCurrent!: () => void;
      const current = new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const previous = tail;
      tail = previous.catch(() => undefined).then(() => current);
      await previous.catch(() => undefined);

      let released = false;
      return () => {
        if (released) return;
        released = true;
        size = Math.max(0, size - 1);
        releaseCurrent();
      };
    },
  };
}

export async function waitWithCountdown(
  ms: number,
  label: string,
  report: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const deadline = performance.now() + ms;
  const update = () => report(`Waiting: ${Math.max(0, (deadline - performance.now()) / 1000).toFixed(1)} s — ${label}`);
  update();
  const interval = setInterval(update, 100);
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new Error("automation script stopped"));
      };
      const timer = setTimeout(finish, ms);
      signal?.addEventListener("abort", abort, { once: true });
    });
  } finally {
    clearInterval(interval);
  }
}

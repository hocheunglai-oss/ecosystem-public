export type InboxRefreshResult = 'success' | 'failure' | 'cancelled';

type Options = {
  read: (more: boolean) => Promise<InboxRefreshResult>;
  canRead: () => boolean;
  canPoll: () => boolean;
  schedule?: (callback: () => void, delay: number) => () => void;
};

/** One read at a time; the next automatic read is measured from completion. */
export function createInboxPolling({ read, canRead, canPoll, schedule = (callback, delay) => {
  const timer = setTimeout(callback, delay);
  return () => clearTimeout(timer);
} }: Options) {
  let stopped = false;
  let failures = 0;
  let flight: Promise<InboxRefreshResult> | null = null;
  let cancelTimer: (() => void) | undefined;
  const pause = () => { cancelTimer?.(); cancelTimer = undefined; };
  const resume = () => {
    pause();
    if (stopped || flight || !canPoll()) return;
    cancelTimer = schedule(() => { cancelTimer = undefined; wake(); }, Math.min(60_000, 5_000 * 2 ** failures));
  };
  function refresh(more = false): Promise<InboxRefreshResult> {
    if (stopped || !canRead()) return Promise.resolve('cancelled');
    if (flight) return flight;
    pause();
    const task = Promise.resolve().then(() => stopped || !canRead() ? 'cancelled' as const : read(more))
      .catch(() => 'failure' as const).then(result => {
        if (flight === task) {
          flight = null;
          if (result === 'success') failures = 0;
          else if (result === 'failure') failures = Math.min(failures + 1, 4);
          resume();
        }
        return result;
      });
    flight = task;
    return task;
  }
  function wake() {
    pause();
    if (!stopped && canPoll()) void refresh();
  }
  async function refreshAfterCurrent() {
    // Writes invalidate the active read. Wait for its abort to settle before
    // fetching the server's current count, including after receipt replay.
    if (flight) await flight;
    return refresh();
  }
  return { refresh, refreshAfterCurrent, wake, pause, resume, stop: () => { stopped = true; pause(); } };
}

export interface WorkerLane {
  name: string;
  run: () => Promise<unknown>;
}

/** Each lane is serialized; slow creative work never blocks order processing. */
export function startWorkerLanes(
  lanes: WorkerLane[],
  options: { intervalMs?: number; disabled?: () => boolean; onError?: (name: string) => void } = {},
) {
  let stopped = false;
  const pending = new Map<string, Promise<void>>();
  const failures = new Map<string, number>();
  const tick = () => {
    if (stopped || options.disabled?.()) return;
    for (const lane of lanes) {
      if (pending.has(lane.name)) continue;
      const task = Promise.resolve().then(lane.run).then(() => undefined)
        .catch(() => {
          failures.set(lane.name, (failures.get(lane.name) ?? 0) + 1);
          options.onError?.(lane.name);
        }).finally(() => pending.delete(lane.name));
      pending.set(lane.name, task);
    }
  };
  const timer = setInterval(tick, options.intervalMs ?? 500);
  return {
    tick,
    status: () => ({ stopped, active: [...pending.keys()], failures: Object.fromEntries(failures) }),
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.all([...pending.values()]);
    },
  };
}

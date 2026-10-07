import type { Work } from "./transport.ts";

/** Launch every slice immediately. A completed lane can collect while slower
 * lanes are still computing; only the session merge waits for the whole wave. */
export async function executeWave(slices: Work[], collectors: Work[], submit: (work: Work) => Promise<void>) {
  const pending = slices.map(work => ({ lane: work.lane, task: submit(work) }));
  const collected = collectors.map(async collector => {
    const lane = await Promise.allSettled(pending.filter(item => item.lane === collector.lane).map(item => item.task));
    const failed = lane.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    await submit(collector);
  });
  // Settle all started sends before returning an error or pausing. Otherwise
  // leftover writes could collide with a resumed wave using the same accounts.
  const results = await Promise.allSettled([...pending.map(item => item.task), ...collected]);
  const failed = results.find(result => result.status === "rejected");
  if (failed?.status === "rejected") throw failed.reason;
}

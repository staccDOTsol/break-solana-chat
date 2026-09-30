/** Keep a bounded number of disjoint writes active. Persist only the contiguous
 * confirmed prefix, so interrupted and failed pipelines can be safely replayed. */
export async function uploadPipeline(
  start: number,
  limit: number,
  batchBytes: number,
  depth: number,
  writeRange: (start: number, end: number) => Promise<number>,
  savePrefix: (end: number, writes: number) => Promise<void>,
) {
  if (
    ![start, limit, batchBytes, depth].every(Number.isSafeInteger) ||
    start < 0 ||
    limit <= start ||
    batchBytes < 1 ||
    depth < 1 ||
    depth > 4
  )
    throw new Error("Invalid upload pipeline");
  let next = start,
    prefix = start,
    totalWrites = 0,
    stopped = false;
  let checkpoint = Promise.resolve();
  const completed = new Map<number, { end: number; writes: number }>();
  const results = await Promise.allSettled(
    Array.from({ length: depth }, async () => {
      try {
        while (!stopped && next < limit) {
          const from = next,
            end = Math.min(from + batchBytes, limit);
          next = end;
          const writes = await writeRange(from, end);
          totalWrites += writes;
          completed.set(from, { end, writes });
          let contiguousWrites = 0;
          while (completed.has(prefix)) {
            const range = completed.get(prefix)!;
            completed.delete(prefix);
            prefix = range.end;
            contiguousWrites += range.writes;
          }
          if (contiguousWrites) {
            const durableEnd = prefix,
              count = contiguousWrites;
            checkpoint = checkpoint.then(() => savePrefix(durableEnd, count));
            await checkpoint;
          }
        }
      } catch (error) {
        stopped = true;
        throw error;
      }
    }),
  );
  await checkpoint;
  const failure = results.find((r) => r.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return { end: prefix, writes: totalWrites };
}

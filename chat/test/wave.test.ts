import { strict as assert } from "node:assert";
import { test } from "node:test";
import { executeWave } from "../src/chain/wave.ts";
import type { Work } from "../src/chain/transport.ts";

const work = (lane: number, collect = false) => ({ lane, instruction: { data: [collect ? 9 : 8] } }) as unknown as Work;
const tick = () => new Promise(resolve => setImmediate(resolve));

test("a completed lane collects before a slower lane, but the wave waits for every collector", async () => {
  const slices = [work(0), work(1), work(0), work(1)], collectors = [work(0, true), work(1, true)];
  const pending = new Map<Work, () => void>(); let finished = false;
  const task = executeWave(slices, collectors, item => new Promise(resolve => pending.set(item, resolve))).then(() => { finished = true; });
  assert.equal(pending.size, 4);
  pending.get(slices[0])!(); await tick(); assert(!pending.has(collectors[0]));
  pending.get(slices[2])!(); await tick(); assert(pending.has(collectors[0])); assert(!pending.has(collectors[1]));
  pending.get(collectors[0])!(); pending.get(slices[1])!(); pending.get(slices[3])!(); await tick();
  assert(!finished); pending.get(collectors[1])!(); await task; assert(finished);
});

test("a failed slice cannot collect, and failure waits for all already-started work", async () => {
  const slices = [work(0), work(1)], collectors = [work(0, true), work(1, true)];
  let release!: () => void; const called: Work[] = [];
  const task = executeWave(slices, collectors, async item => {
    called.push(item);
    if (item === slices[0]) throw new Error("failed slice");
    if (item === slices[1]) await new Promise<void>(resolve => { release = resolve; });
  });
  let settled = false; const checked = assert.rejects(task, /failed slice/).then(() => { settled = true; });
  await tick(); assert(!settled); assert(!called.includes(collectors[0]));
  release(); await checked; assert(called.includes(collectors[1]));
});

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { recordPace, runProgress, type Pace } from "../server/run-progress.ts";
import type { Header } from "../src/chain/layout.ts";

const at = Date.parse("2026-09-28T12:00:00Z");
const header: Header = { phase: 3, layer: 0, cursor: 2048, position: 0, count: 1, token: 10, epoch: 8 };
const job = () => ({ input: Array(14).fill(10), processed: 0, generated: [] as number[], maximum: 4,
  baseCount: 0, pending: { countBefore: 0 }, pace: {} as Pace, measuredAt: undefined as string | undefined });

test("overall progress includes all prompt tokens, output passes and vocabulary work", () => {
  const j = job();
  const first = runProgress(j, header, "running", true, at);
  assert(first.percent > 0 && first.percent < 0.1, "one wave must not look like 1/36 of an entire turn");
  assert(first.totalWork > 1_000_000);
  assert.equal(first.nextToken, null); assert.equal(first.estimateState, "learning");
  const nextLayer = runProgress(j, { ...header, layer: 1, phase: 2, cursor: 0 }, "running", true, at);
  assert(nextLayer.percent > first.percent && nextLayer.percent < 0.2);
  const lastInput = { ...j, processed: 13, pending: { countBefore: 13 } };
  const beforeVocab = runProgress(lastInput, { ...header, phase: 13, layer: 35, cursor: 0, count: 14 }, "running", true, at);
  assert(beforeVocab.percent > 70 && beforeVocab.percent < 80);
});

test("phase order, terminal checkpoints and continuation do not reset or invent progress", () => {
  const j = job();
  const phases = [[5, 16], [15, 0], [15, 2048], [6, 0], [7, 0], [8, 0], [9, 0], [16, 0], [10, 0], [11, 0]];
  let previous = 0;
  for (const [phase, cursor] of phases) {
    const p = runProgress(j, { ...header, phase, cursor }, "running", true, at).percent;
    assert(p > previous, `phase ${phase} moved backwards`); previous = p;
  }
  const terminal = { ...header, phase: 0, layer: 35, cursor: 0 };
  const before = runProgress(j, terminal, "running", true, at);
  const after = runProgress({ ...j, processed: 1, pending: undefined }, terminal, "running", true, at);
  assert.equal(before.percent, after.percent);
  assert.equal(runProgress({ ...j, pending: undefined, baseCount: 50 }, { ...terminal, count: 50 }, "queued", true, at).percent, 0);
  const migrated = runProgress({ ...j, baseCount: undefined }, header, "running", true, at);
  assert.equal(migrated.percent, runProgress(j, header, "running", true, at).percent);
});

test("ETAs use measured waves, include prefill, and exclude pauses and stale readings", () => {
  const j = job();
  for (const phase of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16])
    for (let i = 0; i < 3; i++) recordPace(j, phase, [3, 6, 8, 13].includes(phase) ? 8000 : phase === 10 ? 16000 : 1500, at);
  const p = runProgress(j, header, "running", true, at);
  assert.equal(p.estimateState, "measured");
  assert(p.nextToken!.lowSeconds > 6 * 3600);
  assert(p.finish!.lowSeconds > p.nextToken!.lowSeconds);
  assert.equal(runProgress(j, header, "paused", true, at).finish, null);
  assert.equal(runProgress(j, header, "running", true, at + 120_000).estimateState, "waiting");
  const resumed = structuredClone(j); recordPace(resumed, 3, 8000, at + 86_400_000);
  assert.deepEqual(runProgress(resumed, header, "running", true, at + 86_400_000).finish, p.finish);
});

test("the final visible token still leaves context work, and EOS completion reaches 100%", () => {
  const j = { ...job(), processed: 14, generated: [1, 2, 3, 4], pending: { countBefore: 17 } };
  const p = runProgress(j, { ...header, count: 18 }, "running", true, at);
  assert(p.percent > 90 && p.percent < 100); assert.equal(p.nextToken, null);
  const done = runProgress({ ...j, generated: [1], pending: undefined }, header, "done", true, at);
  assert.equal(done.percent, 100); assert.equal(done.finish!.highSeconds, 0);
});

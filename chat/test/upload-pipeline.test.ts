import { strict as assert } from "node:assert";
import { test } from "node:test";
import { uploadPipeline } from "../scripts/upload-pipeline.ts";

test("upload pipeline covers disjoint bytes and bounds the final partial batch", async () => {
  const ranges: number[][] = [],
    checkpoints: number[] = [];
  const result = await uploadPipeline(
    128,
    153,
    10,
    4,
    async (start, end) => {
      ranges.push([start, end]);
      return 1;
    },
    async (end) => {
      checkpoints.push(end);
    },
  );
  assert.deepEqual(ranges, [
    [128, 138],
    [138, 148],
    [148, 153],
  ]);
  assert.deepEqual(result, { end: 153, writes: 3 });
  assert.equal(checkpoints.at(-1), 153);
});

test("late first batch permits later writes without advancing past the gap", async () => {
  const starts: number[] = [],
    checkpoints: number[] = [];
  let finish!: () => void;
  let active = 0,
    peak = 0;
  const pending = uploadPipeline(
    0,
    50,
    10,
    2,
    async (start) => {
      starts.push(start);
      peak = Math.max(peak, ++active);
      if (start === 0)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      active--;
      return 1;
    },
    async (end) => {
      checkpoints.push(end);
    },
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(starts, [0, 10, 20, 30, 40]);
  assert.deepEqual(checkpoints, []);
  assert.equal(peak, 2);
  finish();
  assert.deepEqual(await pending, { end: 50, writes: 5 });
  assert.deepEqual(checkpoints, [50]);
});

test("failed pipelines drain active writes and preserve only a confirmed prefix", async () => {
  let finish!: () => void;
  let settled = false;
  const checkpoints: number[] = [];
  const pending = uploadPipeline(
    0,
    30,
    10,
    3,
    async (start) => {
      if (start === 10) throw new Error("confirmation failed");
      if (start === 20)
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return 1;
    },
    async (end) => {
      checkpoints.push(end);
    },
  );
  const checked = assert.rejects(pending, /confirmation failed/).then(() => {
    settled = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.deepEqual(checkpoints, [10]);
  finish();
  await checked;
  assert.deepEqual(checkpoints, [10]);
});

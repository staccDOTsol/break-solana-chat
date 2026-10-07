import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchingUploadPrefix } from "../scripts/upload-integrity.ts";

test("a zeroed write inside a saved prefix rewinds to the missing chunk", () => {
  const model = Buffer.alloc(128 + 3 * 3760 + 17, 7);
  const chain = Buffer.from(model);
  chain.fill(0, 128 + 3760, 128 + 2 * 3760);
  assert.equal(matchingUploadPrefix(model, chain), 128 + 3760);
});
test("legitimate model zeros, chain header changes, and partial final chunks compare correctly", () => {
  const model = Buffer.alloc(128 + 2 * 3760 + 17, 0);
  model.fill(9, 128 + 3760);
  const chain = Buffer.from(model);
  chain.fill(42, 0, 128);
  assert.equal(matchingUploadPrefix(model, chain), model.length);
  chain[chain.length - 1] = 0;
  assert.equal(matchingUploadPrefix(model, chain), 128 + 2 * 3760);
});
test("landed bytes beyond the saved prefix are recovered only up to the first gap", () => {
  const model = Buffer.alloc(128 + 4 * 3760, 3);
  const chain = Buffer.from(model);
  chain.fill(0, 128 + 2 * 3760, 128 + 3 * 3760);
  assert.equal(matchingUploadPrefix(model, chain), 128 + 2 * 3760);
  assert.throws(() => matchingUploadPrefix(model, chain.subarray(1)));
});

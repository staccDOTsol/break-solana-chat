import { test } from "node:test";
import assert from "node:assert/strict";
import BN from "bn.js";
import { curveSellMinimum } from "../src/market/quote.ts";

test("curve sell minimum matches Pump SDK's tenth-percent floor at lamport precision", () => {
  const quoted = new BN("1000000001");
  assert.equal(curveSellMinimum(quoted, 2).toString(), "980000001");
  assert.equal(curveSellMinimum(quoted, 1.29).toString(), "988000001");
  assert.equal(curveSellMinimum(quoted, 0).toString(), quoted.toString());
  assert.equal(quoted.toString(), "1000000001", "display quote must remain unchanged");
});

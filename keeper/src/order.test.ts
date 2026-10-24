import { test } from "node:test";
import assert from "node:assert/strict";
import { isNewer, orderBuys, slotsNeedingBlockOrder } from "./order.js";

test("only slots with several transactions need block order", () => {
  const buys = [
    { signature: "a", slot: 10, eventNo: 0 },
    { signature: "a", slot: 10, eventNo: 1 },
    { signature: "b", slot: 11, eventNo: 0 },
    { signature: "c", slot: 11, eventNo: 0 },
  ];
  assert.deepEqual(slotsNeedingBlockOrder(buys), [11]);
});

test("orders by slot then position in block", () => {
  const buys = [
    { signature: "late", slot: 11, eventNo: 0 },
    { signature: "early", slot: 11, eventNo: 0 },
    { signature: "first", slot: 9, eventNo: 0 },
    { signature: "multi", slot: 12, eventNo: 1 },
    { signature: "multi", slot: 12, eventNo: 0 },
  ];
  const out = orderBuys(buys, new Map([[11, ["x", "early", "y", "late"]]]));
  assert.deepEqual(
    out.map((b) => [b.signature, b.slot, b.index]),
    [["first", 9, 0], ["early", 11, 64], ["late", 11, 192], ["multi", 12, 0], ["multi", 12, 1]],
  );
});

test("missing signature in block is an error, not a silent guess", () => {
  assert.throws(() => orderBuys([{ signature: "z", slot: 5, eventNo: 0 }], new Map([[5, ["a"]]])));
});

test("isNewer is strict", () => {
  assert.equal(isNewer(5, 0, 5, 0), false);
  assert.equal(isNewer(5, 1, 5, 0), true);
  assert.equal(isNewer(4, 99, 5, 0), false);
  assert.equal(isNewer(6, 0, 5, 99), true);
});

// Pure helpers for putting buys in exact chain order. No Solana imports, so
// they can be unit-tested on their own (see order.test.ts).

export type Positioned = {
  signature: string;
  slot: number;
  eventNo: number;
};

/** Matches the on-chain index: transaction position * 64 + event number. */
export const EVENTS_PER_TX = 64;

/** Slots that contain buys from more than one transaction need the block's
 *  transaction order to know who was really last. */
export function slotsNeedingBlockOrder(buys: Positioned[]): number[] {
  const sigsBySlot = new Map<number, Set<string>>();
  for (const b of buys) {
    if (!sigsBySlot.has(b.slot)) sigsBySlot.set(b.slot, new Set());
    sigsBySlot.get(b.slot)!.add(b.signature);
  }
  return [...sigsBySlot].filter(([, s]) => s.size > 1).map(([slot]) => slot);
}

/**
 * Assigns each buy its index within its slot and returns them sorted oldest
 * first. `blockOrder` maps slot -> signatures in block order, for the slots
 * returned by slotsNeedingBlockOrder.
 */
export function orderBuys<T extends Positioned>(
  buys: T[],
  blockOrder: Map<number, string[]>,
): (T & { index: number })[] {
  const withIndex = buys.map((b) => {
    const order = blockOrder.get(b.slot);
    let txPos = 0;
    if (order) {
      txPos = order.indexOf(b.signature);
      if (txPos < 0) throw new Error(`signature ${b.signature} missing from block ${b.slot}`);
    }
    const eventNo = Math.min(b.eventNo, EVENTS_PER_TX - 1);
    return { ...b, index: txPos * EVENTS_PER_TX + eventNo };
  });
  withIndex.sort((a, b) => a.slot - b.slot || a.index - b.index);
  return withIndex;
}

/** True when (slot, index) is strictly after the last one the program saw. */
export function isNewer(slot: number, index: number, lastSlot: number, lastIndex: number): boolean {
  return slot > lastSlot || (slot === lastSlot && index > lastIndex);
}

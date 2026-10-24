// Pre-payout check. Runs on a second, independent RPC provider at
// "finalized" commitment (blocks that can no longer be rolled back) before any
// pot is paid. If anything doesn't line up, the keeper pauses the game
// instead of paying. A wrong payout can't be undone; a pause can.
import { Connection, PublicKey } from "@solana/web3.js";
import { GameState, PauseReason } from "./btl.js";
import { cfg } from "./config.js";
import { Buy, PumpBuyReader } from "./pump.js";

export type AuditResult =
  | { ok: true }
  /** Definitely wrong: pause the game. */
  | { ok: false; pause: true; reason: number; detail: string }
  /** Couldn't check yet (RPC hiccup, not finalized yet): try again later. */
  | { ok: false; pause: false; detail: string };

const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");

export class PayoutAuditor {
  private conn = new Connection(cfg.verifyRpcUrl, "finalized");
  private reader: PumpBuyReader;

  constructor() {
    this.reader = new PumpBuyReader(this.conn, cfg.mint, 0n);
  }

  async check(game: GameState): Promise<AuditResult> {
    this.reader.minBuyLamports = game.minBuyLamports;
    try {
      return await this.run(game);
    } catch (e) {
      return { ok: false, pause: false, detail: `audit could not run: ${(e as Error).message}` };
    }
  }

  private async run(game: GameState): Promise<AuditResult> {
    if (!game.hasBuyer) return { ok: false, pause: false, detail: "no buyer this round" };

    // 1. The recorded winning buy exists, succeeded, is finalized, and says
    //    exactly what the program recorded.
    const tx = await this.conn.getTransaction(game.lastBuySig, {
      maxSupportedTransactionVersion: 0, commitment: "finalized",
    });
    if (!tx) return { ok: false, pause: false, detail: "winning buy not finalized yet" };
    if (tx.meta?.err) return bad(PauseReason.WINNER_UNVERIFIED, "winning transaction failed on-chain");
    if (tx.slot !== game.lastSlot) return bad(PauseReason.WINNER_UNVERIFIED, `slot mismatch (${tx.slot} vs ${game.lastSlot})`);
    const buys = await this.reader.buysIn(tx, game.lastBuySig);
    const match = buys.find((b) => b.buyer.equals(game.lastBuyer) && b.blockTime === game.lastBuyTs);
    if (!match) return bad(PauseReason.WINNER_UNVERIFIED, "recorded winner not found as a qualifying buyer in that transaction");

    // 2. The winner is a plain wallet (the program also enforces this).
    const acct = await this.conn.getAccountInfo(game.lastBuyer);
    if (acct && (!acct.owner.equals(SYSTEM_PROGRAM) || acct.executable)) {
      return bad(PauseReason.WINNER_UNVERIFIED, "recorded winner is not a normal wallet");
    }

    // 3. No qualifying buy happened after the winner and on/before the
    //    deadline. Scan every finalized transaction touching the mint back to
    //    the winner's slot.
    const head = await this.conn.getSlot("finalized");
    const headTime = await this.conn.getBlockTime(head);
    if (headTime === null || headTime <= game.deadline) {
      return { ok: false, pause: false, detail: "finalized chain hasn't passed the deadline yet" };
    }
    const sigs: { signature: string; slot: number }[] = [];
    let before: string | undefined;
    scan: for (;;) {
      const page = await this.conn.getSignaturesForAddress(cfg.mint, { before, limit: 1000 }, "finalized");
      for (const s of page) {
        if (s.slot < game.lastSlot) break scan;
        if (!s.err) sigs.push({ signature: s.signature, slot: s.slot });
      }
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }

    const later: Buy[] = [];
    for (let i = 0; i < sigs.length; i += 8) {
      const chunk = sigs.slice(i, i + 8);
      const txs = await Promise.all(chunk.map((s) =>
        this.conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "finalized" })));
      for (let j = 0; j < chunk.length; j++) {
        const t = txs[j];
        if (!t) return { ok: false, pause: false, detail: `transaction ${chunk[j].signature} unavailable` };
        for (const b of await this.reader.buysIn(t, chunk[j].signature)) {
          if (b.blockTime <= game.deadline && b.blockTime >= game.ignoreBefore) later.push(b);
        }
      }
    }

    // Judge "after the winner" by real chain position, compared against the
    // winner's own signature, never against a computed index.
    let order: string[] | undefined;
    if (later.some((b) => b.slot === game.lastSlot && b.signature !== game.lastBuySig)) {
      const blk = await this.conn.getBlock(game.lastSlot, {
        commitment: "finalized", maxSupportedTransactionVersion: 0,
        transactionDetails: "signatures", rewards: false,
      });
      if (!blk) return { ok: false, pause: false, detail: `block ${game.lastSlot} unavailable` };
      order = blk.signatures;
    }
    const winnerPos = order?.indexOf(game.lastBuySig) ?? -1;
    const missed = later.filter((b) => {
      if (b.slot > game.lastSlot) return true;
      if (b.slot < game.lastSlot) return false;
      if (b.signature === game.lastBuySig) return b.eventNo > match.eventNo;
      return order!.indexOf(b.signature) > winnerPos;
    });
    if (missed.length > 0) {
      const m = missed[missed.length - 1];
      return bad(PauseReason.MISSED_BUY,
        `${missed.length} qualifying buy(s) after the recorded winner, latest by ${m.buyer.toBase58()} in ${m.signature}`);
    }
    return { ok: true };
  }
}

function bad(reason: number, detail: string): AuditResult {
  return { ok: false, pause: true, reason, detail };
}

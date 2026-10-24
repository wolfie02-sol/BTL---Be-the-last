// Prints the live game state: round, pot, last buyer, timer, lock.
import { Connection, Keypair } from "@solana/web3.js";
import { BtlClient, PAUSE_REASON_TEXT } from "./btl.js";
import { cfg } from "./config.js";

const conn = new Connection(cfg.rpcUrl, "confirmed");
const btl = new BtlClient(conn, Keypair.generate()); // read-only
const g = await btl.fetchGame();
const pot = await btl.potLamports();
const slot = await conn.getSlot("confirmed");
const now = (await conn.getBlockTime(slot)) ?? Math.floor(Date.now() / 1000);

console.log(`Round        ${g.round}`);
console.log(`Pot          ${(Number(pot) / 1e9).toFixed(4)} SOL   (paid out so far: ${(Number(g.totalPaidLamports) / 1e9).toFixed(4)} SOL)`);
console.log(`Min buy      ${(Number(g.minBuyLamports) / 1e9).toFixed(2)} SOL`);
if (g.paused) {
  console.log(`SAFETY LOCK  ON since ${new Date(g.pausedAt * 1000).toISOString()} — ${PAUSE_REASON_TEXT[g.pauseReason]}`);
  console.log(`             payouts blocked; run "npm run admin resume" or "npm run admin void"`);
}
if (g.hasBuyer) {
  const left = g.deadline - now;
  console.log(`Last buyer   ${g.lastBuyer.toBase58()}  (tx ${g.lastBuySig})`);
  console.log(`Timer        ${left > 0 ? `${left}s left` : `ran out ${-left}s ago (verifying / awaiting payout)`}  — tier ${g.tier} (${g.durationsS[g.tier]}s)`);
} else {
  console.log(`Last buyer   none yet this round`);
}
console.log(`Avg buy gap  ${(g.emaGapMs / 1000).toFixed(1)}s`);

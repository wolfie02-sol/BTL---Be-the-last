// BTL keeper: watch pump.fun for qualifying buys, report them in order,
// pay out rounds when the timer runs out, and sweep creator fees into the pot.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ConfirmedSignatureInfo,
  Connection,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { anchorErrorName, BtlClient, GameState } from "./btl.js";
import { cfg, loadKeypair } from "./config.js";
import { FeeCrank } from "./fees.js";
import { isNewer, orderBuys, slotsNeedingBlockOrder } from "./order.js";
import { Buy, PumpBuyReader } from "./pump.js";

const log = (m: string) => console.log(`${new Date().toISOString()} ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sol = (l: bigint) => (Number(l) / 1e9).toFixed(4);

const conn = new Connection(cfg.rpcUrl, "confirmed");
const keeper = loadKeypair(cfg.keeperKeypairPath);
const btl = new BtlClient(conn, keeper);
const reader = new PumpBuyReader(conn, cfg.mint, cfg.minBuyLamports);
const fees = new FeeCrank(conn, keeper, cfg.mint, btl.vault);

let game: GameState;
/** Newest signature already processed (persisted so restarts don't skip). */
let cursor: string | undefined;
/** Chain time up to which every buy has been seen and reported. */
let caughtUpTo = 0;

function loadCursor() {
  if (existsSync(cfg.stateFile)) cursor = JSON.parse(readFileSync(cfg.stateFile, "utf8")).cursor;
}
function saveCursor() {
  writeFileSync(cfg.stateFile, JSON.stringify({ cursor }, null, 2));
}

/** All successful signatures touching the mint since `cursor`, oldest first. */
async function newSignatures(): Promise<ConfirmedSignatureInfo[]> {
  const all: ConfirmedSignatureInfo[] = [];
  let before: string | undefined;
  for (;;) {
    const page = await conn.getSignaturesForAddress(
      cfg.mint, { until: cursor, before, limit: 1000 }, "confirmed",
    );
    all.push(...page);
    if (page.length < 1000) break;
    before = page[page.length - 1].signature;
  }
  return all.reverse();
}

async function fetchTxs(sigs: string[]): Promise<Map<string, VersionedTransactionResponse>> {
  const out = new Map<string, VersionedTransactionResponse>();
  for (let i = 0; i < sigs.length; i += 8) {
    const chunk = sigs.slice(i, i + 8);
    const txs = await Promise.all(
      chunk.map((s) => conn.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: "confirmed" })),
    );
    txs.forEach((tx, j) => {
      if (!tx) throw new Error(`transaction ${chunk[j]} not available yet`);
      out.set(chunk[j], tx);
    });
  }
  return out;
}

async function blockOrder(slots: number[]): Promise<Map<number, string[]>> {
  const m = new Map<number, string[]>();
  for (const slot of slots) {
    const block = await conn.getBlock(slot, {
      commitment: "confirmed", maxSupportedTransactionVersion: 0,
      transactionDetails: "signatures", rewards: false,
    });
    if (!block) throw new Error(`block ${slot} not available yet`);
    m.set(slot, block.signatures);
  }
  return m;
}

async function settle(reason: string) {
  for (let attempt = 0; ; attempt++) {
    try {
      const pot = await btl.potLamports();
      const winner = game.lastBuyer;
      const sig = await btl.settle(winner);
      log(`ROUND ${game.round} WON by ${winner.toBase58()} — ${sol(pot)} SOL (${reason}) tx ${sig}`);
      game = await btl.fetchGame();
      return;
    } catch (e) {
      const code = anchorErrorName(e);
      if (code === "NoBuyer") { game = await btl.fetchGame(); return; }
      // TooEarly: chain clock hasn't passed deadline + grace yet. Wait a beat.
      if (attempt > 30) throw e;
      log(`settle retry (${code ?? (e as Error).message})`);
      await sleep(1000);
      game = await btl.fetchGame();
    }
  }
}

async function report(b: Buy & { index: number }) {
  if (game.lastSlot !== 0 && !isNewer(b.slot, b.index, game.lastSlot, game.lastIndex)) return; // already reported
  // This buy came after the current round ended: pay that round out first.
  // Everything before this buy is already reported, so the winner is final.
  if (game.hasBuyer && b.blockTime > game.deadline) await settle("next buy arrived after deadline");

  for (let attempt = 0; ; attempt++) {
    try {
      const sig = await btl.reportBuy(b);
      game = await btl.fetchGame();
      const left = game.deadline - b.blockTime;
      log(`buy ${sol(b.lamports)} SOL by ${b.buyer.toBase58()} [${b.venue}] → tier ${game.tier}, timer ${left}s, round ${game.round} (tx ${sig.slice(0, 8)}…)`);
      return;
    } catch (e) {
      const code = anchorErrorName(e);
      if (code === "OutOfOrder") { game = await btl.fetchGame(); return; }
      if (code === "BelowMinimum") return;
      if (code === "RoundExpired") { game = await btl.fetchGame(); await settle("round expired"); continue; }
      if (attempt > 10) throw e;
      log(`report retry ${attempt + 1} (${code ?? (e as Error).message})`);
      await sleep(500 * (attempt + 1));
    }
  }
}

async function pollOnce() {
  // Chain time at the start of this poll: once processed, every buy up to
  // this moment has been seen.
  const slotNow = await conn.getSlot("confirmed");
  const chainNow = (await conn.getBlockTime(slotNow)) ?? Math.floor(Date.now() / 1000);

  const sigs = await newSignatures();
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  if (ok.length > 0) {
    const txs = await fetchTxs(ok);
    const buys: Buy[] = [];
    for (const s of ok) buys.push(...(await reader.buysIn(txs.get(s)!, s)));
    const ordered = orderBuys(buys, await blockOrder(slotsNeedingBlockOrder(buys)));
    for (const b of ordered) await report(b);
  }
  if (sigs.length > 0) {
    cursor = sigs[sigs.length - 1].signature;
    saveCursor();
  }
  caughtUpTo = chainNow;
}

async function maybeSettleOnTimeout() {
  if (!game.hasBuyer) return;
  // Only pay out once polling has covered SETTLE_SAFETY_S past the deadline,
  // so a buy that landed right before zero can't be missed.
  if (caughtUpTo > game.deadline + cfg.settleSafetyS) await settle("timer ran out");
}

async function main() {
  loadCursor();
  game = await btl.fetchGame();
  if (!game.keeper.equals(keeper.publicKey)) {
    throw new Error(`This wallet (${keeper.publicKey.toBase58()}) is not the game's keeper (${game.keeper.toBase58()}).`);
  }
  if (!cursor) {
    // Fresh start: begin from the latest transaction so history isn't replayed.
    const [latest] = await conn.getSignaturesForAddress(cfg.mint, { limit: 1 }, "confirmed");
    cursor = latest?.signature;
    saveCursor();
  }
  log(`keeper ${keeper.publicKey.toBase58()} watching ${cfg.mint.toBase58()} — round ${game.round}, pot ${sol(await btl.potLamports())} SOL`);

  let lastFeeCrank = 0;
  for (;;) {
    try {
      await pollOnce();
      await maybeSettleOnTimeout();
      if (Date.now() - lastFeeCrank > cfg.feeCrankEveryS * 1000) {
        lastFeeCrank = Date.now();
        await fees.run(log);
      }
    } catch (e) {
      // Cursor only advances after a fully processed batch, so the next poll
      // retries the same transactions.
      log(`poll error: ${(e as Error).message}`);
      game = await btl.fetchGame().catch(() => game);
    }
    await sleep(cfg.pollMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

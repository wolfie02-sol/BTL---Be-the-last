// BTL keeper: watch pump.fun for qualifying buys, report them in order,
// verify and pay out rounds when the timer runs out, and sweep creator fees
// into the pot. When anything looks wrong it pauses the game rather than
// risk paying the wrong wallet.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  ConfirmedSignatureInfo,
  Connection,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import { PayoutAuditor } from "./audit.js";
import { anchorErrorName, BtlClient, GameState, PAUSE_REASON_TEXT, PauseReason } from "./btl.js";
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
const reader = new PumpBuyReader(conn, cfg.mint, 0n);
const auditor = new PayoutAuditor();
const fees = new FeeCrank(conn, keeper, cfg.mint, btl.vault);

let game: GameState;

/** Cursor: a signature from a slot that has been fully processed. We stay one
 *  slot behind the newest so a slot is never cut in half between polls. */
let cursor: string | undefined;
/** Signatures already processed in slots newer than the cursor. */
const seen = new Set<string>();
/** Chain time up to which every buy has been seen and reported. */
let caughtUpTo = 0;

class HaltError extends Error {}

function loadCursor() {
  if (existsSync(cfg.stateFile)) cursor = JSON.parse(readFileSync(cfg.stateFile, "utf8")).cursor;
}
function saveCursor() {
  writeFileSync(cfg.stateFile, JSON.stringify({ cursor }, null, 2));
}

async function refreshGame() {
  game = await btl.fetchGame();
  // Always follow the live on-chain minimum, never a local setting.
  reader.minBuyLamports = game.minBuyLamports;
}

async function alert(message: string) {
  log(`!!! ${message}`);
  if (!cfg.alertWebhookUrl) return;
  try {
    await fetch(cfg.alertWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: `BTL: ${message}`, text: `BTL: ${message}` }),
    });
  } catch (e) {
    log(`alert webhook failed: ${(e as Error).message}`);
  }
}

/** Lock payouts on-chain and stop processing until a human looks. */
async function haltWithPause(reason: number, detail: string): Promise<never> {
  try {
    if (!game.paused) await btl.pause(reason);
  } catch (e) {
    if (anchorErrorName(e) !== "AlreadyPaused") {
      await alert(`FAILED TO PAUSE (${(e as Error).message}). Pause it manually now: npm run admin pause`);
    }
  }
  await refreshGame().catch(() => {});
  await alert(`Game PAUSED in round ${game.round}: ${PAUSE_REASON_TEXT[reason]}. ${detail}. ` +
    `Payouts are blocked. Check it, then run "npm run admin resume" or "npm run admin void".`);
  throw new HaltError(detail);
}

/** All successful signatures touching the mint since the cursor, oldest first. */
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

/** Verify on a second provider, then pay. Never pays on a failed check. */
async function verifyAndSettle(why: string) {
  for (;;) {
    await refreshGame();
    if (!game.hasBuyer) return;
    if (game.paused) throw new HaltError("game is paused");

    const now = Math.floor(Date.now() / 1000);
    const opensAt = game.deadline + game.keeperGraceS + 1;
    if (now < opensAt) {
      await sleep(Math.min(5000, (opensAt - now) * 1000));
      continue;
    }

    const audit = await auditor.check(game);
    if (!audit.ok) {
      if (audit.pause) await haltWithPause(audit.reason, audit.detail);
      log(`payout waiting: ${audit.detail}`);
      await sleep(3000);
      continue;
    }

    try {
      const pot = await btl.potLamports();
      const winner = game.lastBuyer;
      const sig = await btl.settle(winner);
      log(`ROUND ${game.round} WON by ${winner.toBase58()} — ${sol(pot)} SOL (${why}) tx ${sig}`);
      await refreshGame();
      return;
    } catch (e) {
      const code = anchorErrorName(e);
      if (code === "NoBuyer") return await refreshGame();
      if (code === "TooEarly") { await sleep(2000); continue; } // chain clock behind ours
      if (code === "GamePaused") throw new HaltError("game is paused");
      if (code === "WinnerNotWallet" || code === "WrongWinner" || code === "WinnerBelowRent") {
        await haltWithPause(PauseReason.WINNER_UNVERIFIED, `program refused payout: ${code}`);
      }
      log(`settle retry (${code ?? (e as Error).message})`);
      await sleep(2000);
    }
  }
}

async function report(b: Buy & { index: number }) {
  if (game.started && !isNewer(b.slot, b.index, game.lastSlot, game.lastIndex)) return; // already reported
  if (b.blockTime < game.ignoreBefore) return; // before a voided round ended

  // This buy came after the current round ended: pay that round first.
  // Everything before this buy is already reported, so the winner is final.
  if (game.hasBuyer && b.blockTime > game.deadline) await verifyAndSettle("next buy arrived after deadline");

  for (let attempt = 0; ; attempt++) {
    try {
      const sig = await btl.reportBuy(b);
      await refreshGame();
      log(`buy ${sol(b.lamports)} SOL by ${b.buyer.toBase58()} [${b.venue}] → tier ${game.tier}, ` +
        `timer ${game.deadline - b.blockTime}s, round ${game.round} (tx ${sig.slice(0, 8)}…)`);
      return;
    } catch (e) {
      const code = anchorErrorName(e);
      if (code === "OutOfOrder" || code === "StaleBuy") return await refreshGame(); // already counted / doesn't count
      if (code === "RoundExpired") { await verifyAndSettle("round expired"); continue; }
      if (code === "GamePaused") throw new HaltError("game is paused");
      if (code === "BelowMinimum" || code === "TimeWentBackwards") {
        // We and the program disagree about a buy. Don't guess: lock payouts.
        await haltWithPause(PauseReason.KEEPER_FAULT, `program rejected buy ${b.signature} with ${code}`);
      }
      if (attempt >= 10) {
        await haltWithPause(PauseReason.KEEPER_FAULT, `could not record buy ${b.signature}: ${(e as Error).message}`);
      }
      log(`report retry ${attempt + 1} (${code ?? (e as Error).message})`);
      await sleep(500 * (attempt + 1));
    }
  }
}

async function pollOnce() {
  // Chain time at the start of this poll: once processed, every buy up to
  // this moment has been seen. If the RPC can't tell us, don't advance it.
  let chainNow: number | null = null;
  try {
    chainNow = await conn.getBlockTime(await conn.getSlot("confirmed"));
  } catch {
    chainNow = null;
  }

  const sigs = (await newSignatures()).filter((s) => !seen.has(s.signature));
  const ok = sigs.filter((s) => !s.err).map((s) => s.signature);
  if (ok.length > 0) {
    const txs = await fetchTxs(ok);
    const buys: Buy[] = [];
    for (const s of ok) buys.push(...(await reader.buysIn(txs.get(s)!, s)));
    const ordered = orderBuys(buys, await blockOrder(slotsNeedingBlockOrder(buys)));
    for (const b of ordered) await report(b);
  }

  // Everything fetched is processed: remember it, then move the cursor to the
  // newest signature from an older slot than the newest one we saw.
  for (const s of sigs) seen.add(s.signature);
  if (sigs.length > 0) {
    const newestSlot = sigs[sigs.length - 1].slot;
    const settled = [...sigs].reverse().find((s) => s.slot < newestSlot);
    if (settled) {
      cursor = settled.signature;
      saveCursor();
      // Signatures from slots older than the cursor's will never come back.
      for (const s of sigs) if (s.slot < settled.slot) seen.delete(s.signature);
    }
  }
  if (seen.size > 20_000) seen.clear(); // safety valve; report() is idempotent anyway

  if (chainNow !== null) caughtUpTo = chainNow;
}

async function maybeSettleOnTimeout() {
  if (!game.hasBuyer || game.paused) return;
  // Only pay once polling has covered SETTLE_SAFETY_S past the deadline, so a
  // buy that landed right before zero can't be missed. The auditor then
  // re-checks independently before any payout.
  if (caughtUpTo > game.deadline + cfg.settleSafetyS) await verifyAndSettle("timer ran out");
}

async function main() {
  loadCursor();
  await refreshGame();
  if (!game.keeper.equals(keeper.publicKey)) {
    throw new Error(`This wallet (${keeper.publicKey.toBase58()}) is not the game's keeper (${game.keeper.toBase58()}).`);
  }
  if (!cursor) {
    // Fresh start: begin from the latest transaction so history isn't replayed.
    const [latest] = await conn.getSignaturesForAddress(cfg.mint, { limit: 1 }, "confirmed");
    cursor = latest?.signature;
    saveCursor();
  }
  log(`keeper ${keeper.publicKey.toBase58()} watching ${cfg.mint.toBase58()} — round ${game.round}, ` +
    `pot ${sol(await btl.potLamports())} SOL, min buy ${sol(game.minBuyLamports)} SOL`);

  let lastFeeCrank = 0;
  let pausedNoticeAt = 0;
  for (;;) {
    try {
      await refreshGame();
      if (game.paused) {
        // Hold everything (the cursor doesn't move) until resumed or voided.
        if (Date.now() - pausedNoticeAt > 60_000) {
          pausedNoticeAt = Date.now();
          log(`paused (${PAUSE_REASON_TEXT[game.pauseReason] ?? "unknown"}); waiting for resume or void`);
        }
      } else {
        await pollOnce();
        await maybeSettleOnTimeout();
      }
      if (Date.now() - lastFeeCrank > cfg.feeCrankEveryS * 1000) {
        lastFeeCrank = Date.now();
        await fees.run(log);
      }
    } catch (e) {
      // The cursor only advances after a fully processed batch, so the next
      // poll retries the same transactions.
      if (!(e instanceof HaltError)) log(`poll error: ${(e as Error).message}`);
    }
    await sleep(cfg.pollMs);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Reads pump.fun bonding-curve and PumpSwap trades out of transactions and
// keeps only buys of our coin that are big enough to reset the timer.
import { readFileSync } from "node:fs";
import { BorshAccountsCoder, BorshCoder, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  VersionedTransactionResponse,
} from "@solana/web3.js";
import bs58 from "bs58";
import { PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, WSOL_MINT } from "./config.js";

export function loadIdl(name: "pump" | "pump_amm" | "pump_fees"): Idl {
  const url = new URL(`../idl/${name}.json`, import.meta.url);
  try {
    return JSON.parse(readFileSync(url, "utf8")) as Idl;
  } catch {
    throw new Error(`idl/${name}.json not found. Run: npm run fetch-idls`);
  }
}

/** Anchor's self-CPI event marker: sha256("anchor:event")[..8]. */
const EVENT_IX_TAG = Buffer.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d]);
const DEFAULT_KEY = PublicKey.default.toBase58();

export type Buy = {
  signature: string;
  slot: number;
  blockTime: number;
  /** Order of this buy among the buys in the same transaction. */
  eventNo: number;
  buyer: PublicKey;
  lamports: bigint;
  venue: "curve" | "amm";
};

/** Reads a field whether the decoder kept snake_case or produced camelCase. */
function field<T = unknown>(o: Record<string, unknown>, snake: string): T {
  if (snake in o) return o[snake] as T;
  const camel = snake.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return o[camel] as T;
}
const big = (v: unknown): bigint => BigInt((v as { toString(): string }).toString());
const key = (v: unknown): string => (v as PublicKey).toBase58();

export class PumpBuyReader {
  private pump = new BorshCoder(loadIdl("pump"));
  private amm = new BorshCoder(loadIdl("pump_amm"));
  private ammAccounts = new BorshAccountsCoder(loadIdl("pump_amm"));
  /** pool address -> is it our coin's SOL pool */
  private pools = new Map<string, boolean>();

  constructor(
    private conn: Connection,
    private mint: PublicKey,
    private minBuyLamports: bigint,
  ) {}

  /** Every qualifying buy in one transaction, in execution order. */
  async buysIn(tx: VersionedTransactionResponse, signature: string): Promise<Buy[]> {
    if (!tx.meta || tx.meta.err) return [];
    const events = this.rawEvents(tx);
    const out: Buy[] = [];
    for (const ev of events) {
      const b = await this.toBuy(ev, tx, signature);
      if (b && b.lamports >= this.minBuyLamports) out.push({ ...b, eventNo: out.length });
    }
    return out;
  }

  /** Decoded pump / PumpSwap events, from self-CPI first, logs as fallback. */
  private rawEvents(tx: VersionedTransactionResponse) {
    const keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses,
    });
    const found: { program: "pump" | "amm"; name: string; data: Record<string, unknown> }[] = [];

    for (const group of tx.meta!.innerInstructions ?? []) {
      for (const ix of group.instructions) {
        const pid = keys.get(ix.programIdIndex);
        const program = pid?.equals(PUMP_PROGRAM_ID)
          ? "pump"
          : pid?.equals(PUMP_AMM_PROGRAM_ID)
            ? "amm"
            : null;
        if (!program) continue;
        const raw = Buffer.from(bs58.decode(ix.data));
        if (raw.length < 16 || !raw.subarray(0, 8).equals(EVENT_IX_TAG)) continue;
        const ev = this.decode(program, raw.subarray(8).toString("base64"));
        if (ev) found.push({ program, ...ev });
      }
    }
    if (found.length > 0) return found;

    // Older `emit!` style events live in "Program data:" log lines.
    for (const line of tx.meta!.logMessages ?? []) {
      if (!line.startsWith("Program data: ")) continue;
      const b64 = line.slice("Program data: ".length);
      for (const program of ["pump", "amm"] as const) {
        const ev = this.decode(program, b64);
        if (ev) {
          found.push({ program, ...ev });
          break;
        }
      }
    }
    return found;
  }

  private decode(program: "pump" | "amm", b64: string) {
    try {
      const ev = (program === "pump" ? this.pump : this.amm).events.decode(b64);
      return ev ? { name: ev.name, data: ev.data as Record<string, unknown> } : null;
    } catch {
      return null;
    }
  }

  private async toBuy(
    ev: { program: "pump" | "amm"; name: string; data: Record<string, unknown> },
    tx: VersionedTransactionResponse,
    signature: string,
  ): Promise<Omit<Buy, "eventNo"> | null> {
    const d = ev.data;
    const ts = Number(field(d, "timestamp") ?? tx.blockTime ?? 0);

    if (ev.program === "pump" && /^trade_?event$/i.test(ev.name)) {
      if (key(field(d, "mint")) !== this.mint.toBase58()) return null;
      if (!field<boolean>(d, "is_buy")) return null;
      // Only SOL-paired coins count (pump.fun now supports other quote mints).
      const qm = field(d, "quote_mint");
      if (qm && key(qm) !== DEFAULT_KEY && key(qm) !== WSOL_MINT.toBase58()) return null;
      let lamports = big(field(d, "sol_amount"));
      if (lamports === 0n && field(d, "quote_amount") != null) lamports = big(field(d, "quote_amount"));
      return {
        signature, slot: tx.slot, blockTime: ts,
        buyer: field<PublicKey>(d, "user"), lamports, venue: "curve",
      };
    }

    if (ev.program === "amm" && /^buy_?event$/i.test(ev.name)) {
      const pool = field<PublicKey>(d, "pool");
      if (!(await this.isOurPool(pool))) return null;
      return {
        signature, slot: tx.slot, blockTime: ts,
        buyer: field<PublicKey>(d, "user"),
        lamports: big(field(d, "quote_amount_in")),
        venue: "amm",
      };
    }
    return null;
  }

  private async isOurPool(pool: PublicKey): Promise<boolean> {
    const k = pool.toBase58();
    const cached = this.pools.get(k);
    if (cached !== undefined) return cached;
    const info = await this.conn.getAccountInfo(pool, "confirmed");
    let ok = false;
    if (info && info.owner.equals(PUMP_AMM_PROGRAM_ID)) {
      const p = this.ammAccounts.decode("Pool", info.data) as Record<string, unknown>;
      ok =
        key(field(p, "base_mint")) === this.mint.toBase58() &&
        key(field(p, "quote_mint")) === WSOL_MINT.toBase58();
    }
    this.pools.set(k, ok);
    return ok;
  }
}

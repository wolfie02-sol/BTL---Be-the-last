// Thin client for the BTL program.
import { readFileSync } from "node:fs";
import { AnchorProvider, BN, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { cfg, gamePda, vaultPda } from "./config.js";

export type GameState = {
  admin: PublicKey;
  keeper: PublicKey;
  mint: PublicKey;
  minBuyLamports: bigint;
  keeperGraceS: number;
  publicFallbackS: number;
  autoVoidS: number;
  round: number;
  hasBuyer: boolean;
  lastBuyer: PublicKey;
  lastBuyTs: number;
  lastSlot: number;
  lastIndex: number;
  lastBuySig: string;
  started: boolean;
  deadline: number;
  emaGapMs: number;
  tier: number;
  durationsS: number[];
  paused: boolean;
  pausedAt: number;
  pauseReason: number;
  ignoreBefore: number;
  totalPaidLamports: bigint;
};

/** Matches `pause_reason` in the program. */
export const PauseReason = {
  MANUAL: 0,
  WINNER_UNVERIFIED: 1,
  MISSED_BUY: 2,
  KEEPER_FAULT: 3,
} as const;
export const PAUSE_REASON_TEXT: Record<number, string> = {
  0: "paused manually",
  1: "winning buy could not be verified",
  2: "a qualifying buy after the recorded winner was found",
  3: "keeper hit an error it could not safely recover from",
};

const n = (v: { toString(): string }) => Number(v.toString());
const b = (v: { toString(): string }) => BigInt(v.toString());

export class BtlClient {
  readonly program: Program<Idl>;
  readonly game: PublicKey;
  readonly vault: PublicKey;

  constructor(readonly conn: Connection, readonly signer: Keypair) {
    const url = new URL("../../target/idl/btl.json", import.meta.url);
    let idl: Idl;
    try {
      idl = JSON.parse(readFileSync(url, "utf8"));
    } catch {
      throw new Error("target/idl/btl.json not found. Run `anchor build` in the project root first.");
    }
    idl.address = cfg.programId.toBase58();
    const provider = new AnchorProvider(conn, new Wallet(signer), { commitment: "confirmed" });
    this.program = new Program(idl, provider);
    this.game = gamePda(cfg.programId, cfg.mint);
    this.vault = vaultPda(cfg.programId, cfg.mint);
  }

  async fetchGame(): Promise<GameState> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g: any = await (this.program.account as any).game.fetch(this.game, "confirmed");
    return {
      admin: g.admin, keeper: g.keeper, mint: g.mint,
      minBuyLamports: b(g.minBuyLamports),
      keeperGraceS: n(g.keeperGraceS), publicFallbackS: n(g.publicFallbackS), autoVoidS: n(g.autoVoidS),
      round: n(g.round), hasBuyer: g.hasBuyer, lastBuyer: g.lastBuyer,
      lastBuyTs: n(g.lastBuyTs), lastSlot: n(g.lastSlot), lastIndex: Number(g.lastIndex),
      lastBuySig: bs58.encode(Uint8Array.from(g.lastBuySig as number[])),
      started: g.started,
      deadline: n(g.deadline), emaGapMs: n(g.emaGapMs), tier: Number(g.tier),
      durationsS: (g.durationsS as BN[]).map(n),
      paused: g.paused, pausedAt: n(g.pausedAt), pauseReason: Number(g.pauseReason),
      ignoreBefore: n(g.ignoreBefore),
      totalPaidLamports: b(g.totalPaidLamports),
    };
  }

  async potLamports(): Promise<bigint> {
    const info = await this.conn.getAccountInfo(this.vault, "confirmed");
    if (!info) return 0n;
    const rent = await this.conn.getMinimumBalanceForRentExemption(info.data.length);
    return BigInt(Math.max(0, info.lamports - rent));
  }

  private priority() {
    return [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 })];
  }

  async reportBuy(p: {
    buyer: PublicKey; lamports: bigint; blockTime: number; slot: number; index: number; signature: string;
  }): Promise<string> {
    return this.program.methods
      .reportBuy(
        p.buyer,
        new BN(p.lamports.toString()),
        new BN(p.blockTime),
        new BN(p.slot),
        p.index,
        Array.from(bs58.decode(p.signature)),
      )
      .accountsPartial({ game: this.game, keeper: this.signer.publicKey })
      .preInstructions(this.priority())
      .rpc();
  }

  async settle(winner: PublicKey): Promise<string> {
    return this.program.methods
      .settle()
      .accountsPartial({ game: this.game, caller: this.signer.publicKey, vault: this.vault, winner })
      .preInstructions(this.priority())
      .rpc();
  }

  async pause(reason: number): Promise<string> {
    return this.program.methods
      .pause(reason)
      .accountsPartial({ game: this.game, signer: this.signer.publicKey })
      .preInstructions(this.priority())
      .rpc();
  }

  async resume(): Promise<string> {
    return this.program.methods.resume()
      .accountsPartial({ game: this.game, admin: this.signer.publicKey }).rpc();
  }

  async voidRound(): Promise<string> {
    return this.program.methods.voidRound()
      .accountsPartial({ game: this.game, caller: this.signer.publicKey }).rpc();
  }
}

/** Anchor error name from a failed transaction, if any. */
export function anchorErrorName(e: unknown): string | undefined {
  const err = e as { error?: { errorCode?: { code?: string } }; logs?: string[]; message?: string };
  if (err?.error?.errorCode?.code) return err.error.errorCode.code;
  const m = (err?.message ?? "") + (err?.logs ?? []).join("\n");
  return m.match(/Error Code: (\w+)/)?.[1];
}

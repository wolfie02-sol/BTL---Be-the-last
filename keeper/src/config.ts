import "dotenv/config";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { Keypair, PublicKey } from "@solana/web3.js";

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export function loadKeypair(path: string): Keypair {
  const p = path.startsWith("~") ? homedir() + path.slice(1) : path;
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, "utf8"))));
}

export const PUMP_PROGRAM_ID = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
export const PUMP_AMM_PROGRAM_ID = new PublicKey("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
export const WSOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

export const cfg = {
  rpcUrl: need("RPC_URL"),
  /** A second, independent RPC provider used only for the pre-payout check. */
  verifyRpcUrl: need("VERIFY_RPC_URL"),
  mint: new PublicKey(need("MINT")),
  programId: new PublicKey(need("BTL_PROGRAM_ID")),
  keeperKeypairPath: process.env.KEEPER_KEYPAIR ?? "./keeper.json",
  adminKeypairPath: process.env.ADMIN_KEYPAIR ?? "~/.config/solana/id.json",
  /** Only used by init-game. The keeper always reads the live minimum from
   *  the chain, so a stale .env value can't make it skip or misjudge buys. */
  initMinBuyLamports: BigInt(Math.round(Number(process.env.MIN_BUY_SOL ?? "0.2") * 1e9)),
  pollMs: Number(process.env.POLL_MS ?? 1500),
  feeCrankEveryS: Number(process.env.FEE_CRANK_EVERY_S ?? 60),
  settleSafetyS: Number(process.env.SETTLE_SAFETY_S ?? 15),
  stateFile: process.env.STATE_FILE ?? "./keeper-state.json",
  /** Optional Discord/Slack-style webhook: gets a message on every pause. */
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || undefined,
};

export function gamePda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("game"), mint.toBuffer()], programId)[0];
}
export function vaultPda(programId: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("vault"), mint.toBuffer()], programId)[0];
}

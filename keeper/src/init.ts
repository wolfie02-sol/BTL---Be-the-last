// One-time setup: creates the game + pot vault for your coin and prints the
// vault address to put into pump.fun fee sharing.
import { BN } from "@coral-xyz/anchor";
import { Connection, SystemProgram } from "@solana/web3.js";
import { BtlClient } from "./btl.js";
import { cfg, loadKeypair } from "./config.js";

const conn = new Connection(cfg.rpcUrl, "confirmed");
const admin = loadKeypair(cfg.adminKeypairPath);
const keeper = loadKeypair(cfg.keeperKeypairPath);
const btl = new BtlClient(conn, admin);

// Timer tiers. Avg gap between qualifying buys -> timer length.
//   <= 3 s -> 30 s | <= 10 s -> 1 min | <= 30 s -> 2 min | <= 90 s -> 5 min | slower -> 10 min
const params = {
  keeper: keeper.publicKey,
  minBuyLamports: new BN(cfg.minBuyLamports.toString()),
  gapThresholdsMs: [3_000, 10_000, 30_000, 90_000].map((x) => new BN(x)),
  durationsS: [30, 60, 120, 300, 600].map((x) => new BN(x)),
  keeperGraceS: new BN(2),
  publicFallbackS: new BN(24 * 60 * 60),
};

const sig = await btl.program.methods
  .initialize(params)
  .accountsPartial({
    admin: admin.publicKey,
    mint: cfg.mint,
    game: btl.game,
    vault: btl.vault,
    systemProgram: SystemProgram.programId,
  })
  .rpc();

console.log(`Game created: ${sig}`);
console.log(`  game  : ${btl.game.toBase58()}`);
console.log(`  POT VAULT (set as 100% shareholder in pump.fun fee sharing):`);
console.log(`          ${btl.vault.toBase58()}`);
console.log(`  keeper: ${keeper.publicKey.toBase58()} (fund it with ~0.5 SOL for tx fees)`);

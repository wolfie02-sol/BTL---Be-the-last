// One-way: freezes min buy, tiers and timings forever. Run once you're happy
// with the settings so players know the rules can't change under them.
import { Connection } from "@solana/web3.js";
import { BtlClient } from "./btl.js";
import { cfg, loadKeypair } from "./config.js";

const admin = loadKeypair(cfg.adminKeypairPath);
const btl = new BtlClient(new Connection(cfg.rpcUrl, "confirmed"), admin);
const sig = await btl.program.methods
  .lockConfig()
  .accountsPartial({ game: btl.game, admin: admin.publicKey })
  .rpc();
console.log(`Config locked: ${sig}`);

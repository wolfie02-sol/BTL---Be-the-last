// Admin controls for the safety lock.
//   npm run admin pause    lock payouts now (keeper or admin wallet)
//   npm run admin resume   recorded round is correct: unlock (admin only)
//   npm run admin void     cancel the paused round, nobody paid, pot carries
//                          over to the next round (admin; anyone after 7 days)
import { Connection } from "@solana/web3.js";
import { BtlClient, PAUSE_REASON_TEXT, PauseReason } from "./btl.js";
import { cfg, loadKeypair } from "./config.js";

const cmd = process.argv[2];
const admin = loadKeypair(cfg.adminKeypairPath);
const btl = new BtlClient(new Connection(cfg.rpcUrl, "confirmed"), admin);
const g = await btl.fetchGame();

if (cmd === "pause") {
  console.log(`Paused: ${await btl.pause(PauseReason.MANUAL)}`);
} else if (cmd === "resume") {
  if (!g.paused) throw new Error("Game is not paused.");
  console.log(`Paused because: ${PAUSE_REASON_TEXT[g.pauseReason]}`);
  console.log(`Recorded winner: ${g.lastBuyer.toBase58()} (buy tx ${g.lastBuySig})`);
  console.log(`Resumed: ${await btl.resume()}`);
} else if (cmd === "void") {
  if (!g.paused) throw new Error("Game is not paused. Pause it first.");
  console.log(`Voiding round ${g.round}. Nobody is paid; the pot carries over.`);
  console.log(`Voided: ${await btl.voidRound()}`);
} else {
  console.log("Usage: npm run admin <pause|resume|void>");
  process.exit(1);
}

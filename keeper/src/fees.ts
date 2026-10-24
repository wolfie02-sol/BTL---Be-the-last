// Moves accumulated pump.fun creator fees into the pot.
//
// Setup (done once, see README): in pump.fun's fee sharing, make the BTL vault
// address the only shareholder at 100%, then revoke your fee-sharing admin so
// nobody can redirect the fees later. After that, distributing fees is a
// public action anyone can trigger, and the SOL can only land in the vault.
//
// IMPORTANT: verify this file on devnet before mainnet. Account layouts come
// from pump.fun's public IDLs, which they update from time to time; if a call
// starts failing, re-run `npm run fetch-idls` and check their docs. You can
// always distribute manually from pump.fun's UI as a fallback.
import { AnchorProvider, Idl, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { PUMP_PROGRAM_ID, WSOL_MINT } from "./config.js";
import { loadIdl } from "./pump.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

export class FeeCrank {
  private pump: Program<Idl>;
  private amm: Program<Idl>;

  constructor(conn: Connection, signer: Keypair, private mint: PublicKey, private vault: PublicKey) {
    const provider = new AnchorProvider(conn, new Wallet(signer), { commitment: "confirmed" });
    this.pump = new Program(loadIdl("pump"), provider);
    this.amm = new Program(loadIdl("pump_amm"), provider);
  }

  private bondingCurve(): PublicKey {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), this.mint.toBuffer()],
      PUMP_PROGRAM_ID,
    )[0];
  }

  /** Best effort; logs and returns on any failure (e.g. below minimum). */
  async run(log: (m: string) => void): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bc: any = await (this.pump.account as any).bondingCurve.fetch(this.bondingCurve());

    if (bc.complete) {
      // Graduated: creator fees from PumpSwap first need moving back into the
      // pump creator vault, where fee sharing distributes them.
      try {
        await this.amm.methods
          .transferCreatorFeesToPump()
          .accountsPartial({ wsolMint: WSOL_MINT, tokenProgram: TOKEN_PROGRAM_ID, coinCreator: bc.creator })
          .rpc();
        log("fees: moved PumpSwap creator fees to pump vault");
      } catch (e) {
        log(`fees: PumpSwap transfer skipped (${short(e)})`);
      }
    }

    try {
      await this.pump.methods
        .distributeCreatorFees()
        .accountsPartial({ mint: this.mint })
        .remainingAccounts([{ pubkey: this.vault, isWritable: true, isSigner: false }])
        .rpc();
      log("fees: distributed creator fees into the pot");
    } catch (e) {
      log(`fees: distribute skipped (${short(e)})`);
    }
  }
}

function short(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.split("\n")[0].slice(0, 160);
}

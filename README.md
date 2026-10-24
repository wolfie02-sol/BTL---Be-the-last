# BTL — Be The Last

A last-buyer-wins pot for a pump.fun coin. Every buy of **0.1 SOL or more**
resets a countdown. When the countdown hits zero, the wallet that made the last
qualifying buy receives **the entire pot** (all creator fees collected so far),
and a new round starts immediately.

## How the timer works

The timer length depends on how busy the market is, measured as a moving
average of the time between qualifying buys:

| Avg time between 0.1+ SOL buys | Roughly             | Timer   |
|--------------------------------|---------------------|---------|
| 3 s or less                    | 20+ buys / minute   | 30 s    |
| 10 s or less                   | 6+ buys / minute    | 1 min   |
| 30 s or less                   | 2+ buys / minute    | 2 min   |
| 90 s or less                   | ~1 buy / 1.5 min    | 5 min   |
| slower                         | very quiet          | 10 min  |

Each timer is about 10× the average gap at the edge of its tier, so at normal
activity the clock rarely runs out. The average reacts within a few buys, so
the timer tightens during a rush and relaxes when things calm down. The very
first buy starts on the 10-minute tier. Buys under 0.1 SOL and all sells are
ignored. A buy landing exactly on the deadline still counts.

## Pieces

```
programs/btl/        On-chain program (Anchor). Holds the pot, enforces the rules.
crates/btl-logic/    The timer/round rules, dependency-free, with unit tests.
keeper/              Service that watches pump.fun, reports buys, pays out rounds,
                     and sweeps creator fees into the pot.
```

**Money flow:** pump.fun creator fees → (fee sharing, 100%) → pot vault →
last buyer. The vault is owned by the program; the only instruction that moves
SOL out of it is `settle`, and only to the recorded last buyer.

## Trust model — what players should know

- **Nobody can withdraw the pot**, including you, as long as the program is
  made non-upgradeable (step 8). While it's upgradeable, whoever holds the
  upgrade key could deploy code that drains it.
- **The keeper reports buys.** pump.fun's programs can't call this one, so an
  off-chain service watches the chain and reports each qualifying buy. A
  dishonest or broken keeper could skip someone's buy. Every report is logged
  on-chain as a `BuyRecorded` event that includes the buy's transaction
  signature, so anyone can compare reports against pump.fun's public trade
  history.
- **If the keeper goes offline,** anyone can settle the round 24 hours after
  the deadline, so the pot can't be stuck forever.
- **Fees can't be redirected** once you revoke your fee-sharing admin rights on
  pump.fun (step 6).

## Setup

Do the whole thing on **devnet first**.

1. **Tools:** Rust, the Solana CLI, Anchor 0.31.1 (via `avm`), Node 20+.
2. **Build and deploy the program**
   ```bash
   anchor keys sync          # writes your program id into lib.rs and Anchor.toml
   anchor build
   anchor deploy --provider.cluster devnet
   cargo test -p btl-logic   # rules tests
   ```
3. **Create your coin on pump.fun** paired with **SOL** (pump.fun now supports
   other quote currencies; this only counts SOL buys).
4. **Set up the keeper**
   ```bash
   cd keeper
   cp .env.example .env               # fill in RPC_URL, MINT, BTL_PROGRAM_ID
   solana-keygen new -o keeper.json   # keeper hot wallet; fund with ~0.5 SOL
   npm install
   npm run fetch-idls                 # pump.fun's official IDLs
   npm test
   ```
5. **Create the game:** `npm run init-game`. It prints the **pot vault**
   address.
6. **Point fees at the pot:** in pump.fun's creator fee sharing, set the pot
   vault as the only shareholder at **100%**, then revoke your fee-sharing
   admin. pump.fun allows only one post-launch change to fee settings, so
   double-check the address before confirming.
7. **Run the keeper:** `npm start`. Keep it running on a server (pm2,
   systemd, or a small VPS). `npm run status` shows the round, pot and timer.
8. **Lock it down once you're happy:**
   - `npm run lock-config` freezes the min buy and timer tiers forever.
   - `solana program set-upgrade-authority <PROGRAM_ID> --final` makes the
     program immutable (or hand the upgrade key to a multisig).

## What was and wasn't tested

- **Tested:** the round/timer rules (`crates/btl-logic`, 9 tests) and the
  keeper's buy-ordering logic (`npm test`, 4 tests). The keeper's own code
  type-checks.
- **Not yet tested:** a full `anchor build`, and anything against a live
  cluster: decoding real pump.fun trades, and the fee-distribution calls in
  `keeper/src/fees.ts`. The fee calls are built from pump.fun's public IDLs and
  are the part most likely to need adjusting — run them on devnet and, if they
  fail, distribute fees from pump.fun's UI while you fix them.
- pump.fun updates its programs periodically. Re-run `npm run fetch-idls`
  when they announce changes.

## Things to expect

- **Bots will compete for the last second**, especially on the 30-second tier.
  The keeper uses each buy's on-chain time, so who's "last" is decided by the
  chain, not by who reaches the keeper first.
- **Someone can spam 0.1 SOL buys** to push the timer down to 30 seconds, then
  stop and hope nobody follows. That costs them real money and anyone can
  answer with one buy — it's part of the game, but worth knowing.
- **Legal:** a pot paid to the last participant can look like an unlicensed
  lottery in many places, including Canada. Get advice before launch.

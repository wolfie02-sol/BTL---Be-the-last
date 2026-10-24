//! Be The Last (BTL): a last-buyer-wins pot for a pump.fun coin.
//!
//! Money flow (no one, including the admin, can withdraw the pot):
//!   pump.fun creator fees --(fee sharing, 100% to `vault`)--> vault PDA
//!   vault PDA --(settle, when the timer hits zero)--> last qualifying buyer
//!
//! Buys happen on pump.fun's own programs, which can't call this program, so a
//! keeper service watches the chain and reports each qualifying buy here with
//! its signature, slot and block time. Every report is emitted as an event so
//! anyone can audit the keeper against the public transaction history.

use anchor_lang::prelude::*;
use btl_logic::{self as logic, TierConfig, TimerState};

// Replaced by `anchor keys sync` before your first build.
declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

pub const GAME_SEED: &[u8] = b"game";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod btl {
    use super::*;

    /// Creates the game and pot vault for one coin. Run once by the admin.
    pub fn initialize(ctx: Context<Initialize>, params: ConfigParams) -> Result<()> {
        params.validate()?;
        let g = &mut ctx.accounts.game;
        g.admin = ctx.accounts.admin.key();
        g.keeper = params.keeper;
        g.mint = ctx.accounts.mint.key();
        g.bump = ctx.bumps.game;
        g.vault_bump = ctx.bumps.vault;
        g.config_locked = false;
        g.apply_params(&params);
        g.save_state(&TimerState::default());
        g.total_paid_lamports = 0;
        Ok(())
    }

    /// Keeper reports one qualifying buy, in chain order.
    pub fn report_buy(
        ctx: Context<ReportBuy>,
        buyer: Pubkey,
        lamports: u64,
        block_time: i64,
        slot: u64,
        index_in_slot: u32,
        signature: [u8; 64],
    ) -> Result<()> {
        let g = &mut ctx.accounts.game;
        let mut s = g.load_state();
        let buy = logic::Buy {
            buyer: buyer.to_bytes(),
            lamports,
            block_time,
            slot,
            index: index_in_slot,
        };
        let out = logic::apply_buy(&mut s, &g.tiers(), g.min_buy_lamports, &buy)
            .map_err(BtlError::from)?;
        g.save_state(&s);

        emit!(BuyRecorded {
            mint: g.mint,
            round: s.round,
            buyer,
            lamports,
            block_time,
            slot,
            index_in_slot,
            signature,
            tier: out.tier,
            timer_seconds: out.timer_s,
            deadline: out.deadline,
        });
        Ok(())
    }

    /// Pays the whole pot to the last buyer once the timer has run out and
    /// starts the next round. The keeper may call it shortly after the
    /// deadline; anyone may call it after the public fallback delay.
    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let g = &mut ctx.accounts.game;
        let mut s = g.load_state();
        let now = Clock::get()?.unix_timestamp;
        let is_keeper = ctx.accounts.caller.key() == g.keeper;
        logic::check_settle(&s, now, is_keeper, g.keeper_grace_s, g.public_fallback_s)
            .map_err(BtlError::from)?;

        let vault = ctx.accounts.vault.to_account_info();
        let winner = ctx.accounts.winner.to_account_info();
        let keep = Rent::get()?.minimum_balance(vault.data_len());
        let pot = vault.lamports().saturating_sub(keep);

        // Winner must be able to hold lamports: a brand-new wallet needs at
        // least the rent-exempt minimum for a 0-byte account.
        let winner_min = Rent::get()?.minimum_balance(0);
        require!(
            winner.lamports().saturating_add(pot) >= winner_min || pot == 0,
            BtlError::WinnerBelowRent
        );

        if pot > 0 {
            **vault.try_borrow_mut_lamports()? -= pot;
            **winner.try_borrow_mut_lamports()? += pot;
        }

        let round = s.round;
        let ended_at = s.deadline;
        logic::finish_round(&mut s);
        g.save_state(&s);
        g.total_paid_lamports = g.total_paid_lamports.saturating_add(pot);

        emit!(RoundSettled {
            mint: g.mint,
            round,
            winner: winner.key(),
            amount_lamports: pot,
            deadline: ended_at,
            settled_by: ctx.accounts.caller.key(),
        });
        Ok(())
    }

    /// Admin can rotate the keeper (e.g. a leaked key). Allowed even after
    /// the config is locked, since the keeper can't touch funds.
    pub fn set_keeper(ctx: Context<AdminOnly>, keeper: Pubkey) -> Result<()> {
        ctx.accounts.game.keeper = keeper;
        Ok(())
    }

    /// Admin can tune tiers / minimum buy until the config is locked.
    pub fn update_config(ctx: Context<AdminOnly>, params: ConfigParams) -> Result<()> {
        let g = &mut ctx.accounts.game;
        require!(!g.config_locked, BtlError::ConfigLocked);
        params.validate()?;
        g.keeper = params.keeper;
        g.apply_params(&params);
        Ok(())
    }

    /// One-way switch: freezes min buy, tiers and timings forever.
    pub fn lock_config(ctx: Context<AdminOnly>) -> Result<()> {
        ctx.accounts.game.config_locked = true;
        Ok(())
    }
}

// ---------------------------------------------------------------- accounts

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub admin: Pubkey,
    pub keeper: Pubkey,
    pub mint: Pubkey,
    pub bump: u8,
    pub vault_bump: u8,
    pub config_locked: bool,

    // config
    pub min_buy_lamports: u64,
    pub gap_thresholds_ms: [u64; 4],
    pub durations_s: [i64; 5],
    pub keeper_grace_s: i64,
    pub public_fallback_s: i64,

    // round state (mirrors btl_logic::TimerState)
    pub round: u64,
    pub has_buyer: bool,
    pub last_buyer: Pubkey,
    pub last_buy_ts: i64,
    pub last_slot: u64,
    pub last_index: u32,
    pub started: bool,
    pub deadline: i64,
    pub ema_gap_ms: u64,
    pub has_ema: bool,
    pub tier: u8,

    pub total_paid_lamports: u64,
}

impl Game {
    fn tiers(&self) -> TierConfig {
        TierConfig {
            gap_thresholds_ms: self.gap_thresholds_ms,
            durations_s: self.durations_s,
        }
    }
    fn apply_params(&mut self, p: &ConfigParams) {
        self.min_buy_lamports = p.min_buy_lamports;
        self.gap_thresholds_ms = p.gap_thresholds_ms;
        self.durations_s = p.durations_s;
        self.keeper_grace_s = p.keeper_grace_s;
        self.public_fallback_s = p.public_fallback_s;
    }
    fn load_state(&self) -> TimerState {
        TimerState {
            round: self.round,
            has_buyer: self.has_buyer,
            last_buyer: self.last_buyer.to_bytes(),
            last_buy_ts: self.last_buy_ts,
            last_slot: self.last_slot,
            last_index: self.last_index,
            started: self.started,
            deadline: self.deadline,
            ema_gap_ms: self.ema_gap_ms,
            has_ema: self.has_ema,
            tier: self.tier,
        }
    }
    fn save_state(&mut self, s: &TimerState) {
        self.round = s.round;
        self.has_buyer = s.has_buyer;
        self.last_buyer = Pubkey::new_from_array(s.last_buyer);
        self.last_buy_ts = s.last_buy_ts;
        self.last_slot = s.last_slot;
        self.last_index = s.last_index;
        self.started = s.started;
        self.deadline = s.deadline;
        self.ema_gap_ms = s.ema_gap_ms;
        self.has_ema = s.has_ema;
        self.tier = s.tier;
    }
}

/// Holds the pot. Owned by this program, so only `settle` can move its SOL.
/// Set this address as the 100% shareholder in pump.fun's fee sharing.
#[account]
#[derive(InitSpace)]
pub struct Vault {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ConfigParams {
    pub keeper: Pubkey,
    pub min_buy_lamports: u64,
    pub gap_thresholds_ms: [u64; 4],
    pub durations_s: [i64; 5],
    pub keeper_grace_s: i64,
    pub public_fallback_s: i64,
}

impl ConfigParams {
    fn validate(&self) -> Result<()> {
        require!(self.min_buy_lamports > 0, BtlError::BadConfig);
        require!(
            (0..=600).contains(&self.keeper_grace_s),
            BtlError::BadConfig
        );
        require!(
            self.public_fallback_s >= 3_600 && self.public_fallback_s >= self.keeper_grace_s,
            BtlError::BadConfig
        );
        TierConfig {
            gap_thresholds_ms: self.gap_thresholds_ms,
            durations_s: self.durations_s,
        }
        .validate()
        .map_err(|_| error!(BtlError::BadConfig))
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: only its address is used, as the PDA seed and for the keeper.
    pub mint: UncheckedAccount<'info>,
    #[account(
        init, payer = admin, space = 8 + Game::INIT_SPACE,
        seeds = [GAME_SEED, mint.key().as_ref()], bump
    )]
    pub game: Account<'info, Game>,
    #[account(
        init, payer = admin, space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, mint.key().as_ref()], bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReportBuy<'info> {
    #[account(mut, seeds = [GAME_SEED, game.mint.as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(address = game.keeper @ BtlError::NotKeeper)]
    pub keeper: Signer<'info>,
}

#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(mut, seeds = [GAME_SEED, game.mint.as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    pub caller: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED, game.mint.as_ref()], bump = game.vault_bump)]
    pub vault: Account<'info, Vault>,
    /// CHECK: must be the recorded last buyer; only receives lamports.
    #[account(mut, address = game.last_buyer @ BtlError::WrongWinner)]
    pub winner: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [GAME_SEED, game.mint.as_ref()], bump = game.bump)]
    pub game: Account<'info, Game>,
    #[account(address = game.admin @ BtlError::NotAdmin)]
    pub admin: Signer<'info>,
}

// ------------------------------------------------------------------ events

#[event]
pub struct BuyRecorded {
    pub mint: Pubkey,
    pub round: u64,
    pub buyer: Pubkey,
    pub lamports: u64,
    pub block_time: i64,
    pub slot: u64,
    pub index_in_slot: u32,
    pub signature: [u8; 64],
    pub tier: u8,
    pub timer_seconds: i64,
    pub deadline: i64,
}

#[event]
pub struct RoundSettled {
    pub mint: Pubkey,
    pub round: u64,
    pub winner: Pubkey,
    pub amount_lamports: u64,
    pub deadline: i64,
    pub settled_by: Pubkey,
}

// ------------------------------------------------------------------ errors

#[error_code]
pub enum BtlError {
    #[msg("Buy is below the minimum")]
    BelowMinimum,
    #[msg("Buy is not after the last reported buy")]
    OutOfOrder,
    #[msg("Block time went backwards")]
    TimeWentBackwards,
    #[msg("Round already ended; settle it first")]
    RoundExpired,
    #[msg("No qualifying buy this round")]
    NoBuyer,
    #[msg("Timer has not run out yet")]
    TooEarly,
    #[msg("Winner account does not match the last buyer")]
    WrongWinner,
    #[msg("Winner would be below rent-exempt minimum")]
    WinnerBelowRent,
    #[msg("Only the keeper can do this")]
    NotKeeper,
    #[msg("Only the admin can do this")]
    NotAdmin,
    #[msg("Config is locked")]
    ConfigLocked,
    #[msg("Invalid config")]
    BadConfig,
}

impl From<logic::BuyError> for BtlError {
    fn from(e: logic::BuyError) -> Self {
        match e {
            logic::BuyError::BelowMinimum => BtlError::BelowMinimum,
            logic::BuyError::OutOfOrder => BtlError::OutOfOrder,
            logic::BuyError::TimeWentBackwards => BtlError::TimeWentBackwards,
            logic::BuyError::RoundExpired => BtlError::RoundExpired,
        }
    }
}

impl From<logic::SettleError> for BtlError {
    fn from(e: logic::SettleError) -> Self {
        match e {
            logic::SettleError::NoBuyer => BtlError::NoBuyer,
            logic::SettleError::TooEarly => BtlError::TooEarly,
        }
    }
}

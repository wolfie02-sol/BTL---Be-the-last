//! Round and timer rules for Be The Last (BTL).
//!
//! This crate has no dependencies so the rules can be unit-tested anywhere and
//! reused unchanged by the on-chain program.
//!
//! How a round works
//! - Every qualifying buy (>= `min_buy_lamports`) becomes the new "last buyer"
//!   and pushes the deadline out to `buy_time + timer_for_current_volume`.
//! - Volume is measured as an exponential moving average (EMA) of the gap
//!   between qualifying buys. Short gaps = busy market = short timer.
//! - When the deadline passes with no new qualifying buy, the last buyer wins
//!   the whole pot and a new round starts.

/// EMA smoothing: new = old + (sample - old) / EMA_DIVISOR. 4 reacts within a
/// handful of buys, so the timer tightens quickly when a rush starts and
/// relaxes quickly when it dies down.
pub const EMA_DIVISOR: u64 = 4;

/// Gaps longer than this are clamped so one dead night doesn't take dozens of
/// buys to recover from.
pub const MAX_GAP_SAMPLE_MS: u64 = 60 * 60 * 1000;

/// 0.1 SOL.
pub const DEFAULT_MIN_BUY_LAMPORTS: u64 = 100_000_000;

/// Five timer tiers, fastest first, picked by the average gap between buys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TierConfig {
    /// Upper bound (inclusive) of the average gap for tiers 0..=3, in ms.
    /// Anything slower than the last threshold lands in tier 4.
    pub gap_thresholds_ms: [u64; 4],
    /// Timer length for each tier, in seconds.
    pub durations_s: [i64; 5],
}

/// Default tiers:
///
/// | Avg gap between 0.1+ SOL buys | Roughly          | Timer |
/// |-------------------------------|------------------|-------|
/// | <= 3 s                        | 20+ buys / min   | 30 s  |
/// | <= 10 s                       | 6+ buys / min    | 1 min |
/// | <= 30 s                       | 2+ buys / min    | 2 min |
/// | <= 90 s                       | ~1 buy / 1.5 min | 5 min |
/// | slower                        | quiet            | 10 min|
///
/// Each timer is ~10x the average gap at the edge of its tier, so at normal
/// activity for that tier the clock is very unlikely to hit zero.
pub const DEFAULT_TIERS: TierConfig = TierConfig {
    gap_thresholds_ms: [3_000, 10_000, 30_000, 90_000],
    durations_s: [30, 60, 120, 300, 600],
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfigError {
    ThresholdsNotIncreasing,
    DurationsNotDecreasingSpeed,
    DurationOutOfRange,
}

impl TierConfig {
    pub fn validate(&self) -> Result<(), ConfigError> {
        for w in self.gap_thresholds_ms.windows(2) {
            if w[0] >= w[1] {
                return Err(ConfigError::ThresholdsNotIncreasing);
            }
        }
        for w in self.durations_s.windows(2) {
            if w[0] > w[1] {
                return Err(ConfigError::DurationsNotDecreasingSpeed);
            }
        }
        // 5 s .. 24 h keeps typos from creating an instantly-ending or
        // never-ending round.
        if self.durations_s.iter().any(|d| *d < 5 || *d > 86_400) {
            return Err(ConfigError::DurationOutOfRange);
        }
        Ok(())
    }

    /// Returns (tier index 0..=4, timer length in seconds).
    pub fn tier_for(&self, ema_gap_ms: Option<u64>) -> (u8, i64) {
        // No history yet (very first buy): start on the slowest, safest tier.
        let gap = match ema_gap_ms {
            Some(g) => g,
            None => return (4, self.durations_s[4]),
        };
        for (i, t) in self.gap_thresholds_ms.iter().enumerate() {
            if gap <= *t {
                return (i as u8, self.durations_s[i]);
            }
        }
        (4, self.durations_s[4])
    }
}

pub fn next_ema(prev: Option<u64>, gap_ms: u64) -> u64 {
    let sample = gap_ms.min(MAX_GAP_SAMPLE_MS);
    match prev {
        None => sample,
        Some(old) => {
            if sample >= old {
                old + (sample - old) / EMA_DIVISOR
            } else {
                old - (old - sample) / EMA_DIVISOR
            }
        }
    }
}

/// Everything the rules need to remember between buys.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct TimerState {
    pub round: u64,
    /// True once the current round has at least one qualifying buy.
    pub has_buyer: bool,
    pub last_buyer: [u8; 32],
    /// Block time (unix seconds) of the latest qualifying buy, across rounds.
    pub last_buy_ts: i64,
    /// Position of the latest reported buy, for strict ordering.
    pub last_slot: u64,
    pub last_index: u32,
    /// True once any buy has ever been reported (ordering/EMA are live).
    pub started: bool,
    pub deadline: i64,
    pub ema_gap_ms: u64,
    pub has_ema: bool,
    pub tier: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Buy {
    pub buyer: [u8; 32],
    pub lamports: u64,
    pub block_time: i64,
    pub slot: u64,
    /// Position within the slot (transaction position * 64 + event number).
    pub index: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuyError {
    BelowMinimum,
    /// (slot, index) not strictly after the last reported buy.
    OutOfOrder,
    /// Block time went backwards relative to the last reported buy.
    TimeWentBackwards,
    /// The current round ended before this buy; settle it first.
    RoundExpired,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuyOutcome {
    pub tier: u8,
    pub timer_s: i64,
    pub deadline: i64,
}

pub fn apply_buy(
    s: &mut TimerState,
    cfg: &TierConfig,
    min_buy_lamports: u64,
    b: &Buy,
) -> Result<BuyOutcome, BuyError> {
    if b.lamports < min_buy_lamports {
        return Err(BuyError::BelowMinimum);
    }
    if s.started {
        if (b.slot, b.index) <= (s.last_slot, s.last_index) {
            return Err(BuyError::OutOfOrder);
        }
        if b.block_time < s.last_buy_ts {
            return Err(BuyError::TimeWentBackwards);
        }
    }
    // A buy landing exactly on the deadline still counts.
    if s.has_buyer && b.block_time > s.deadline {
        return Err(BuyError::RoundExpired);
    }

    let ema = if s.started {
        let gap_ms = ((b.block_time - s.last_buy_ts) as u64).saturating_mul(1000);
        Some(next_ema(if s.has_ema { Some(s.ema_gap_ms) } else { None }, gap_ms))
    } else {
        None
    };
    if let Some(e) = ema {
        s.ema_gap_ms = e;
        s.has_ema = true;
    }

    let (tier, timer_s) = cfg.tier_for(if s.has_ema { Some(s.ema_gap_ms) } else { None });
    let deadline = b.block_time + timer_s;

    s.started = true;
    s.has_buyer = true;
    s.last_buyer = b.buyer;
    s.last_buy_ts = b.block_time;
    s.last_slot = b.slot;
    s.last_index = b.index;
    s.deadline = deadline;
    s.tier = tier;

    Ok(BuyOutcome { tier, timer_s, deadline })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettleError {
    NoBuyer,
    TooEarly,
}

/// Who may settle and when.
/// - The keeper may settle `keeper_grace_s` after the deadline (it only does
///   so once it has confirmed no earlier buy is still unreported).
/// - Anyone may settle `public_fallback_s` after the deadline, so the pot can
///   never be stuck forever if the keeper goes offline.
pub fn check_settle(
    s: &TimerState,
    now: i64,
    is_keeper: bool,
    keeper_grace_s: i64,
    public_fallback_s: i64,
) -> Result<(), SettleError> {
    if !s.has_buyer {
        return Err(SettleError::NoBuyer);
    }
    let wait = if is_keeper { keeper_grace_s } else { public_fallback_s };
    if now <= s.deadline + wait {
        return Err(SettleError::TooEarly);
    }
    Ok(())
}

/// Ends the round after a successful payout. EMA and ordering carry over so
/// the next round starts at the tier the market is actually at.
pub fn finish_round(s: &mut TimerState) {
    s.round += 1;
    s.has_buyer = false;
    s.last_buyer = [0; 32];
    s.deadline = 0;
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: u64 = DEFAULT_MIN_BUY_LAMPORTS;

    fn buy(who: u8, t: i64, slot: u64) -> Buy {
        Buy { buyer: [who; 32], lamports: MIN, block_time: t, slot, index: 0 }
    }

    #[test]
    fn default_tiers_are_valid() {
        assert_eq!(DEFAULT_TIERS.validate(), Ok(()));
    }

    #[test]
    fn tier_boundaries() {
        let c = DEFAULT_TIERS;
        assert_eq!(c.tier_for(None), (4, 600));
        assert_eq!(c.tier_for(Some(0)), (0, 30));
        assert_eq!(c.tier_for(Some(3_000)), (0, 30));
        assert_eq!(c.tier_for(Some(3_001)), (1, 60));
        assert_eq!(c.tier_for(Some(10_000)), (1, 60));
        assert_eq!(c.tier_for(Some(30_000)), (2, 120));
        assert_eq!(c.tier_for(Some(90_000)), (3, 300));
        assert_eq!(c.tier_for(Some(90_001)), (4, 600));
    }

    #[test]
    fn rejects_small_buys() {
        let mut s = TimerState::default();
        let mut b = buy(1, 1000, 1);
        b.lamports = MIN - 1;
        assert_eq!(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &b), Err(BuyError::BelowMinimum));
        assert!(!s.has_buyer);
    }

    #[test]
    fn first_buy_uses_slowest_tier() {
        let mut s = TimerState::default();
        let o = apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(1, 1000, 1)).unwrap();
        assert_eq!((o.tier, o.deadline), (4, 1600));
        assert_eq!(s.last_buyer, [1; 32]);
    }

    #[test]
    fn busy_market_tightens_to_30s_and_quiet_market_relaxes() {
        let mut s = TimerState::default();
        let mut t = 1000;
        let mut slot = 1;
        apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(1, t, slot)).unwrap();
        // A rush: a buy every 2 seconds.
        let mut last = None;
        for i in 0..10 {
            t += 2;
            slot += 5;
            last = Some(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(i, t, slot)).unwrap());
        }
        assert_eq!(last.unwrap().tier, 0);
        assert_eq!(last.unwrap().timer_s, 30);
        // Things slow to one buy every ~25 s (each well inside the timer).
        for i in 0..12 {
            t += 25;
            slot += 60;
            last = Some(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(i, t, slot)).unwrap());
        }
        assert_eq!(last.unwrap().tier, 2, "ema={}", s.ema_gap_ms);
    }

    #[test]
    fn ordering_is_strict() {
        let mut s = TimerState::default();
        apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(1, 1000, 10)).unwrap();
        assert_eq!(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(2, 1000, 10)), Err(BuyError::OutOfOrder));
        assert_eq!(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(2, 1000, 9)), Err(BuyError::OutOfOrder));
        let mut same_slot_later = buy(2, 1000, 10);
        same_slot_later.index = 1;
        assert!(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &same_slot_later).is_ok());
        assert_eq!(s.last_buyer, [2; 32]);
    }

    #[test]
    fn buy_on_deadline_counts_after_it_does_not() {
        let mut s = TimerState::default();
        apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(1, 1000, 1)).unwrap(); // deadline 1600
        assert!(apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(2, 1600, 2)).is_ok());
        let d = s.deadline;
        assert_eq!(
            apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(3, d + 1, 3)),
            Err(BuyError::RoundExpired)
        );
    }

    #[test]
    fn settle_rules_and_new_round() {
        let mut s = TimerState::default();
        apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(7, 1000, 1)).unwrap(); // deadline 1600
        assert_eq!(check_settle(&s, 1600, true, 2, 86_400), Err(SettleError::TooEarly));
        assert_eq!(check_settle(&s, 1602, true, 2, 86_400), Err(SettleError::TooEarly));
        assert_eq!(check_settle(&s, 1603, true, 2, 86_400), Ok(()));
        assert_eq!(check_settle(&s, 1603, false, 2, 86_400), Err(SettleError::TooEarly));
        assert_eq!(check_settle(&s, 1600 + 86_401, false, 2, 86_400), Ok(()));

        finish_round(&mut s);
        assert_eq!(s.round, 1);
        assert_eq!(check_settle(&s, 99_999, true, 2, 86_400), Err(SettleError::NoBuyer));
        // The buy that arrived after the old deadline now opens round 1.
        let o = apply_buy(&mut s, &DEFAULT_TIERS, MIN, &buy(8, 1700, 2)).unwrap();
        assert!(s.has_buyer && o.deadline > 1700);
    }

    #[test]
    fn bad_configs_rejected() {
        let mut c = DEFAULT_TIERS;
        c.gap_thresholds_ms = [10, 5, 20, 30];
        assert_eq!(c.validate(), Err(ConfigError::ThresholdsNotIncreasing));
        let mut c = DEFAULT_TIERS;
        c.durations_s = [60, 30, 120, 300, 600];
        assert_eq!(c.validate(), Err(ConfigError::DurationsNotDecreasingSpeed));
        let mut c = DEFAULT_TIERS;
        c.durations_s[0] = 1;
        assert_eq!(c.validate(), Err(ConfigError::DurationOutOfRange));
    }
}

use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;
use std::str::FromStr;

// Well-known Ed25519 verify program id (stable across clusters)
const ED25519_ID: &str = "Ed25519SigVerify111111111111111111111111111";

declare_id!("BtJDtqG3Zy25gZC43H7q1TXTqjoeSh4JBHVYiWzwd2cb");

// Hardcode your oracle pubkey (must match oracle service)
pub const ORACLE_PUBKEY: &str = "8yrUjTDd5pygozAQPob9nViMUUV1NT8in7BHCbe8HhGT";

#[program]
pub mod cavityproof {
    use super::*;

    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        let user_state = &mut ctx.accounts.user_state;
        user_state.owner = ctx.accounts.user.key();
        user_state.streak = 0;
        user_state.last_day_claimed = -1;
        user_state.total_claims = 0;
        Ok(())
    }

    pub fn claim_brush(
        ctx: Context<ClaimBrush>,
        day: i64,
        session_hash: [u8; 32],
        nonce: [u8; 16],
        expires_at: i64,
        sig: [u8; 64],
    ) -> Result<()> {
        let user_state = &mut ctx.accounts.user_state;

        require_keys_eq!(user_state.owner, ctx.accounts.user.key(), ErrorCode::BadOwner);

        // expiry check
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at >= now, ErrorCode::Expired);

        // replay protection: Claim PDA must be newly created this tx
        // (Anchor init already enforces "does not exist"; we store anyway for debugging/auditing)
        ctx.accounts.claim.user = ctx.accounts.user.key();
        ctx.accounts.claim.nonce = nonce;
        ctx.accounts.claim.day = day;

        // Require the ed25519 verify instruction in the same tx
        let payload_bytes =
            build_payload_bytes(ctx.accounts.user.key(), day, session_hash, nonce, expires_at);

        require_ed25519_ix(
            &ctx.accounts.ix_sysvar,
            &payload_bytes,
            &sig,
            ORACLE_PUBKEY.parse::<Pubkey>().unwrap(),
        )?;

        // streak rules
        require!(day != user_state.last_day_claimed, ErrorCode::AlreadyClaimedToday);

        if user_state.last_day_claimed == -1 {
            user_state.streak = 1;
        } else if day == user_state.last_day_claimed + 1 {
            user_state.streak = user_state.streak.saturating_add(1);
        } else if day > user_state.last_day_claimed + 1 {
            user_state.streak = 1;
        } else {
            return err!(ErrorCode::InvalidDay);
        }

        user_state.last_day_claimed = day;
        user_state.total_claims = user_state.total_claims.saturating_add(1);

        Ok(())
        }
        pub fn claim_brush_dev(
        ctx: Context<ClaimBrushDev>,
        day: i64,
        session_hash: [u8; 32],
        nonce: [u8; 16],
        expires_at: i64,
        sig: [u8; 64],
    ) -> Result<()> {
        // OPTIONAL: hard gate to your wallet so nobody abuses dev mode
        // const DEV_WALLET: &str = "YOUR_WALLET_PUBKEY";
        // require_keys_eq!(ctx.accounts.user.key(), Pubkey::from_str(DEV_WALLET).unwrap(), ErrorCode::DevOnly);

        let user_state = &mut ctx.accounts.user_state;

        require_keys_eq!(user_state.owner, ctx.accounts.user.key(), ErrorCode::BadOwner);

        // Keep expiry (or skip if you prefer)
        let now = Clock::get()?.unix_timestamp;
        require!(expires_at >= now, ErrorCode::Expired);

        // Replay protection: Claim PDA must be newly created this tx
        ctx.accounts.claim.user = ctx.accounts.user.key();
        ctx.accounts.claim.nonce = nonce;
        ctx.accounts.claim.day = day;

        // Require the ed25519 verify instruction in the same tx
        let payload_bytes =
            build_payload_bytes(ctx.accounts.user.key(), day, session_hash, nonce, expires_at);

        require_ed25519_ix(
            &ctx.accounts.ix_sysvar,
            &payload_bytes,
            &sig,
            ORACLE_PUBKEY.parse::<Pubkey>().unwrap(),
        )?;

        // DEV behavior: allow unlimited submissions.
        // Only increment total_claims (or even leave everything unchanged if you want)
        user_state.total_claims = user_state.total_claims.saturating_add(1);

        Ok(())
    }

}

fn build_payload_bytes(
    user: Pubkey,
    day: i64,
    session_hash: [u8; 32],
    nonce: [u8; 16],
    expires_at: i64,
) -> Vec<u8> {
    // "CPv1" + user(32) + day(i64 LE) + sessionHash(32) + nonce(16) + expiresAt(i64 LE)
    let mut out = Vec::with_capacity(4 + 32 + 8 + 32 + 16 + 8);
    out.extend_from_slice(b"CPv1");
    out.extend_from_slice(user.as_ref());
    out.extend_from_slice(&day.to_le_bytes());
    out.extend_from_slice(&session_hash);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&expires_at.to_le_bytes());
    out
}

/// Scan the instructions sysvar for an Ed25519 verify instruction that includes:
/// - oracle pubkey bytes
/// - signature bytes
/// - payload bytes
///
/// Hackathon version: "contains_subslice" checks.
/// (Production: parse the ed25519 instruction layout and verify exact offsets.)
fn require_ed25519_ix(
    ix_sysvar_account: &AccountInfo,
    payload: &[u8],
    sig: &[u8; 64],
    oracle_pubkey: Pubkey,
) -> Result<()> {
    let oracle_pk_bytes = oracle_pubkey.to_bytes();
    let ed25519_pid = Pubkey::from_str(ED25519_ID).unwrap();

    // Loop a reasonable max; break when sysvar says "no instruction at index"
    for i in 0..256usize {
        let ix = match ix_sysvar::load_instruction_at_checked(i, ix_sysvar_account) {
            Ok(ix) => ix,
            Err(_) => break,
        };

        // Must be the Ed25519 SigVerify program
        if ix.program_id != ed25519_pid {
            continue;
        }

        let data = ix.data;

        if contains_subslice(&data, &oracle_pk_bytes)
            && contains_subslice(&data, sig)
            && contains_subslice(&data, payload)
        {
            return Ok(());
        }
    }

    Err(error!(ErrorCode::MissingEd25519Ix))
}

fn contains_subslice(haystack: &[u8], needle: &[u8]) -> bool {
    if needle.is_empty() {
        return true;
    }
    if haystack.len() < needle.len() {
        return false;
    }
    haystack.windows(needle.len()).any(|w| w == needle)
}

#[derive(Accounts)]
pub struct InitUser<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        init,
        payer = user,
        space = 8 + UserState::SIZE,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(day: i64, session_hash: [u8; 32], nonce: [u8; 16], expires_at: i64, sig: [u8; 64])]
pub struct ClaimBrush<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    // Claim PDA for replay protection: ["claim", user, nonce]
    #[account(
        init,
        payer = user,
        space = 8 + Claim::SIZE,
        seeds = [b"claim", user.key().as_ref(), &nonce],
        bump
    )]
    pub claim: Account<'info, Claim>,

    /// CHECK: Instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(day: i64, session_hash: [u8; 32], nonce: [u8; 16], expires_at: i64, sig: [u8; 64])]
pub struct ClaimBrushDev<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [b"user", user.key().as_ref()],
        bump
    )]
    pub user_state: Account<'info, UserState>,

    #[account(
        init,
        payer = user,
        space = 8 + Claim::SIZE,
        seeds = [b"claim", user.key().as_ref(), &nonce],
        bump
    )]
    pub claim: Account<'info, Claim>,

    /// CHECK: Instructions sysvar
    #[account(address = ix_sysvar::ID)]
    pub ix_sysvar: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}


#[account]
pub struct UserState {
    pub owner: Pubkey,
    pub streak: u32,
    pub last_day_claimed: i64,
    pub total_claims: u32,
}
impl UserState {
    pub const SIZE: usize = 32 + 4 + 8 + 4; // 48 bytes (account size = 8 + 48 = 56)
}

#[account]
pub struct Claim {
    pub user: Pubkey,
    pub nonce: [u8; 16],
    pub day: i64,
}
impl Claim {
    pub const SIZE: usize = 32 + 16 + 8; // 56 bytes (account size = 8 + 56 = 64)
}

#[error_code]
pub enum ErrorCode {
    #[msg("Only the owner can claim.")]
    BadOwner,
    #[msg("Already claimed for this day.")]
    AlreadyClaimedToday,
    #[msg("Day is invalid (must be >= last claimed day).")]
    InvalidDay,
    #[msg("Oracle signature is expired.")]
    Expired,
    #[msg("Missing valid ed25519 verify instruction.")]
    MissingEd25519Ix,
}

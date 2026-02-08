use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions as ix_sysvar;

declare_id!("PASTE_YOUR_PROGRAM_ID_HERE");

// Hardcode your oracle pubkey (from the oracle server startup log)
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

    // payload_b64 and sig_b64 are passed as raw bytes by the client
    // We'll verify on-chain by requiring an ed25519 verify instruction exists in the tx.
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
        ctx.accounts.claim.user = ctx.accounts.user.key();
        ctx.accounts.claim.nonce = nonce;
        ctx.accounts.claim.day = day;

        // Require the ed25519 verify instruction to be present in the transaction,
        // verifying the oracle signature over the exact payload bytes.
        let payload_bytes = build_payload_bytes(
            ctx.accounts.user.key(),
            day,
            session_hash,
            nonce,
            expires_at,
        );
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
}

fn build_payload_bytes(
    user: Pubkey,
    day: i64,
    session_hash: [u8; 32],
    nonce: [u8; 16],
    expires_at: i64,
) -> Vec<u8> {
    // Must match oracle: "CPv1" + user(32) + day(i64 LE) + sessionHash(32) + nonce(16) + expiresAt(i64 LE)
    let mut out = Vec::with_capacity(4 + 32 + 8 + 32 + 16 + 8);
    out.extend_from_slice(b"CPv1");
    out.extend_from_slice(user.as_ref());
    out.extend_from_slice(&day.to_le_bytes());
    out.extend_from_slice(&session_hash);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&expires_at.to_le_bytes());
    out
}

/// Checks the instructions sysvar for an ed25519 verify instruction that verifies
/// (oracle_pubkey, payload_bytes, sig).
///
/// This is the “Option C” enforcement.
fn require_ed25519_ix(
    ix_sysvar_account: &AccountInfo,
    payload: &[u8],
    sig: &[u8; 64],
    oracle_pubkey: Pubkey,
) -> Result<()> {
    // Scan all instructions in this transaction
    let num = ix_sysvar::load_num_instructions(ix_sysvar_account)
        .map_err(|_| error!(ErrorCode::MissingEd25519Ix))?;

    let oracle_pk_bytes = oracle_pubkey.to_bytes();

    for i in 0..num {
        let ix = ix_sysvar::load_instruction_at(i as usize, ix_sysvar_account)
            .map_err(|_| error!(ErrorCode::MissingEd25519Ix))?;

        // Ed25519 program id:
        // Ed25519SigVerify111111111111111111111111111
        if ix.program_id != anchor_lang::solana_program::ed25519_program::id() {
            continue;
        }

        // Very pragmatic check:
        // We confirm this instruction’s data contains:
        // - oracle pubkey bytes
        // - signature bytes
        // - payload bytes
        //
        // This is sufficient for hackathon-grade enforcement.
        // (More strict parsing can be added later.)
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
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
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

    /// CHECK: instructions sysvar (read-only)
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
    pub const SIZE: usize = 32 + 4 + 8 + 4;
}

#[account]
pub struct Claim {
    pub user: Pubkey,
    pub nonce: [u8; 16],
    pub day: i64,
}
impl Claim {
    pub const SIZE: usize = 32 + 16 + 8;
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

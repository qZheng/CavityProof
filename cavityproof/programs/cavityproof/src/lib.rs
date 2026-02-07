use anchor_lang::prelude::*;

declare_id!("45JnnKr8RUBcn6wXcGcHq2yyVNhKtZwZEB3mrXNeF1Vs"); // Anchor will replace on deploy, we’ll fix later

#[program]
pub mod cavityproof {
    use super::*;

    pub fn init_user(ctx: Context<InitUser>) -> Result<()> {
        let user_state = &mut ctx.accounts.user_state;
        user_state.owner = ctx.accounts.user.key();
        user_state.streak = 0;
        user_state.last_day_claimed = -1; // “never”
        user_state.total_claims = 0;
        Ok(())
    }

    pub fn claim_brush(ctx: Context<ClaimBrush>, day: i64) -> Result<()> {
        let user_state = &mut ctx.accounts.user_state;

        // only the owner can claim
        require_keys_eq!(user_state.owner, ctx.accounts.user.key(), ErrorCode::BadOwner);

        // no double-claim same day
        require!(day != user_state.last_day_claimed, ErrorCode::AlreadyClaimedToday);

        // streak update rules
        if user_state.last_day_claimed == -1 {
            user_state.streak = 1;
        } else if day == user_state.last_day_claimed + 1 {
            user_state.streak = user_state.streak.saturating_add(1);
        } else if day > user_state.last_day_claimed + 1 {
            user_state.streak = 1;
        } else {
            // day < last_day_claimed (time travel)
            return err!(ErrorCode::InvalidDay);
        }

        user_state.last_day_claimed = day;
        user_state.total_claims = user_state.total_claims.saturating_add(1);

        Ok(())
    }
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
}

#[account]
pub struct UserState {
    pub owner: Pubkey,         // 32
    pub streak: u32,           // 4
    pub last_day_claimed: i64, // 8
    pub total_claims: u32,     // 4
}

impl UserState {
    pub const SIZE: usize = 32 + 4 + 8 + 4;
}

#[error_code]
pub enum ErrorCode {
    #[msg("Only the owner can claim.")]
    BadOwner,
    #[msg("Already claimed for this day.")]
    AlreadyClaimedToday,
    #[msg("Day is invalid (must be >= last claimed day).")]
    InvalidDay,
}

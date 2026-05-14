// ldgr-escrow — milestone escrow for The Bazaar.
//
// Lifecycle:
//   1) initialize: hirer locks total $LDGR into a PDA-owned vault.
//      Stores per-milestone amounts and three signer pubkeys
//      (hirer, worker, moderator).
//   2) release_milestone(idx): releases milestone[idx] to the worker.
//      Signer ruleset:
//        - moderator alone (Lila bot acts on a verified completion event), OR
//        - hirer + worker co-sign (no Lila needed).
//   3) refund: returns remaining vault balance to the hirer. Same signer rules.
//
// Devnet first. Mint authority lives outside this program (multisig over the
// SPL token). The vault token account is owned by the escrow PDA.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5U87rQ3wvccQ7yN5bsKQAYdnrYGXJMhS7uCBy7JKsXT6");

pub const ESCROW_SEED: &[u8] = b"escrow";
pub const MAX_MILESTONES: usize = 16;

#[program]
pub mod ldgr_escrow {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        gig_id: [u8; 32],
        milestone_amounts: Vec<u64>,
    ) -> Result<()> {
        require!(
            !milestone_amounts.is_empty() && milestone_amounts.len() <= MAX_MILESTONES,
            EscrowError::InvalidMilestoneCount
        );
        let total: u64 = milestone_amounts
            .iter()
            .try_fold(0u64, |acc, x| acc.checked_add(*x))
            .ok_or(EscrowError::AmountOverflow)?;
        require!(total > 0, EscrowError::ZeroAmount);

        let escrow = &mut ctx.accounts.escrow;
        escrow.gig_id = gig_id;
        escrow.hirer = ctx.accounts.hirer.key();
        escrow.worker = ctx.accounts.worker.key();
        escrow.moderator = ctx.accounts.moderator.key();
        escrow.mint = ctx.accounts.mint.key();
        escrow.vault = ctx.accounts.vault.key();
        escrow.milestone_amounts = milestone_amounts.clone();
        escrow.milestones_released = vec![false; milestone_amounts.len()];
        escrow.amount_total = total;
        escrow.amount_remaining = total;
        escrow.bump = ctx.bumps.escrow;

        // Hirer funds the vault up-front.
        let cpi = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.hirer_ata.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.hirer.to_account_info(),
            },
        );
        token::transfer(cpi, total)?;

        emit!(EscrowInitialized {
            gig_id,
            hirer: escrow.hirer,
            worker: escrow.worker,
            moderator: escrow.moderator,
            amount_total: total,
        });
        Ok(())
    }

    pub fn release_milestone(ctx: Context<ReleaseMilestone>, idx: u8) -> Result<()> {
        let idx_usize = idx as usize;
        let escrow = &mut ctx.accounts.escrow;
        require!(idx_usize < escrow.milestone_amounts.len(), EscrowError::IndexOutOfRange);
        require!(!escrow.milestones_released[idx_usize], EscrowError::AlreadyReleased);

        // Auth: either moderator alone OR both hirer and worker co-signed.
        let mod_signed = ctx.accounts.moderator.is_signer
            && ctx.accounts.moderator.key() == escrow.moderator;
        let hirer_signed = ctx.accounts.hirer.is_signer
            && ctx.accounts.hirer.key() == escrow.hirer;
        let worker_signed = ctx.accounts.worker.is_signer
            && ctx.accounts.worker.key() == escrow.worker;
        require!(
            mod_signed || (hirer_signed && worker_signed),
            EscrowError::Unauthorized
        );

        let amount = escrow.milestone_amounts[idx_usize];
        escrow.milestones_released[idx_usize] = true;
        escrow.amount_remaining = escrow
            .amount_remaining
            .checked_sub(amount)
            .ok_or(EscrowError::AmountOverflow)?;

        let gig_id = escrow.gig_id;
        let bump = escrow.bump;
        let seeds = &[ESCROW_SEED, gig_id.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.worker_ata.to_account_info(),
                authority: escrow.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi, amount)?;

        emit!(MilestoneReleased {
            gig_id,
            idx,
            amount,
            remaining: escrow.amount_remaining,
        });
        Ok(())
    }

    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let escrow = &ctx.accounts.escrow;
        let mod_signed = ctx.accounts.moderator.is_signer
            && ctx.accounts.moderator.key() == escrow.moderator;
        let hirer_signed = ctx.accounts.hirer.is_signer
            && ctx.accounts.hirer.key() == escrow.hirer;
        let worker_signed = ctx.accounts.worker.is_signer
            && ctx.accounts.worker.key() == escrow.worker;
        require!(
            mod_signed || (hirer_signed && worker_signed),
            EscrowError::Unauthorized
        );

        let amount = escrow.amount_remaining;
        require!(amount > 0, EscrowError::NothingToRefund);

        let gig_id = escrow.gig_id;
        let bump = escrow.bump;
        let seeds = &[ESCROW_SEED, gig_id.as_ref(), &[bump]];
        let signer_seeds = &[&seeds[..]];

        let cpi = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault.to_account_info(),
                to: ctx.accounts.hirer_ata.to_account_info(),
                authority: ctx.accounts.escrow.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(cpi, amount)?;

        let escrow = &mut ctx.accounts.escrow;
        escrow.amount_remaining = 0;
        emit!(EscrowRefunded { gig_id, amount });
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(gig_id: [u8; 32], milestone_amounts: Vec<u64>)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub hirer: Signer<'info>,
    /// CHECK: stored on escrow; not signed for at init.
    pub worker: UncheckedAccount<'info>,
    /// CHECK: stored on escrow; not signed for at init.
    pub moderator: UncheckedAccount<'info>,

    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = hirer,
        space = Escrow::space(milestone_amounts.len()),
        seeds = [ESCROW_SEED, gig_id.as_ref()],
        bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(
        init_if_needed,
        payer = hirer,
        associated_token::mint = mint,
        associated_token::authority = escrow,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = hirer_ata.mint == mint.key() && hirer_ata.owner == hirer.key())]
    pub hirer_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ReleaseMilestone<'info> {
    /// CHECK: signature checked in handler.
    pub hirer: Signer<'info>,
    /// CHECK: signature checked in handler.
    pub worker: Signer<'info>,
    /// CHECK: signature checked in handler.
    pub moderator: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.gig_id.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, address = escrow.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = worker_ata.mint == escrow.mint && worker_ata.owner == escrow.worker)]
    pub worker_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    pub hirer: Signer<'info>,
    pub worker: Signer<'info>,
    pub moderator: Signer<'info>,

    #[account(
        mut,
        seeds = [ESCROW_SEED, escrow.gig_id.as_ref()],
        bump = escrow.bump,
    )]
    pub escrow: Account<'info, Escrow>,

    #[account(mut, address = escrow.vault)]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut, constraint = hirer_ata.mint == escrow.mint && hirer_ata.owner == escrow.hirer)]
    pub hirer_ata: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[account]
pub struct Escrow {
    pub gig_id: [u8; 32],
    pub hirer: Pubkey,
    pub worker: Pubkey,
    pub moderator: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub milestone_amounts: Vec<u64>,
    pub milestones_released: Vec<bool>,
    pub amount_total: u64,
    pub amount_remaining: u64,
    pub bump: u8,
}

impl Escrow {
    /// 8 disc + 32 gig_id + 4 pubkeys*32 + 32 mint + 32 vault
    /// + vec<u64>: 4 + n*8
    /// + vec<bool>: 4 + n
    /// + u64*2 + u8
    pub fn space(n_milestones: usize) -> usize {
        8 + 32 + 32 * 5 + (4 + n_milestones * 8) + (4 + n_milestones) + 8 + 8 + 1
    }
}

#[event]
pub struct EscrowInitialized {
    pub gig_id: [u8; 32],
    pub hirer: Pubkey,
    pub worker: Pubkey,
    pub moderator: Pubkey,
    pub amount_total: u64,
}

#[event]
pub struct MilestoneReleased {
    pub gig_id: [u8; 32],
    pub idx: u8,
    pub amount: u64,
    pub remaining: u64,
}

#[event]
pub struct EscrowRefunded {
    pub gig_id: [u8; 32],
    pub amount: u64,
}

#[error_code]
pub enum EscrowError {
    #[msg("milestone count must be 1..=16")]
    InvalidMilestoneCount,
    #[msg("total milestone amount overflows u64")]
    AmountOverflow,
    #[msg("zero total amount")]
    ZeroAmount,
    #[msg("milestone index out of range")]
    IndexOutOfRange,
    #[msg("milestone already released")]
    AlreadyReleased,
    #[msg("signer set does not satisfy release rules")]
    Unauthorized,
    #[msg("nothing remaining to refund")]
    NothingToRefund,
}

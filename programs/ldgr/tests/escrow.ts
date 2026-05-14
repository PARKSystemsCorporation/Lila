// Anchor tests for ldgr-escrow. Verifies the full lifecycle:
//   initialize → release_milestone (moderator path) → release_milestone (co-sign) → refund.
//
// Run with: anchor test

import * as anchor from '@coral-xyz/anchor'
import { Program, BN } from '@coral-xyz/anchor'
import {
  createMint,
  createAssociatedTokenAccount,
  mintTo,
  getAccount,
} from '@solana/spl-token'
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js'
import { expect } from 'chai'

// Anchor generates the LdgrEscrow type at build time. Until `anchor build`
// runs, this import is just a placeholder type.
type LdgrEscrow = any

const ESCROW_SEED = Buffer.from('escrow')

describe('ldgr-escrow', () => {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)

  const program = anchor.workspace.LdgrEscrow as Program<LdgrEscrow>
  const payer = provider.wallet as anchor.Wallet

  let mint: PublicKey
  const hirer = Keypair.generate()
  const worker = Keypair.generate()
  const moderator = Keypair.generate()

  before(async () => {
    // Fund test keypairs.
    for (const kp of [hirer, worker, moderator]) {
      const sig = await provider.connection.requestAirdrop(kp.publicKey, 2e9)
      await provider.connection.confirmTransaction(sig)
    }
    // Create a fresh test mint owned by payer.
    mint = await createMint(provider.connection, payer.payer, payer.publicKey, null, 9)
  })

  it('runs the full lifecycle', async () => {
    const gigId = Buffer.alloc(32)
    gigId.write('test-gig-001')

    const [escrowPda] = PublicKey.findProgramAddressSync(
      [ESCROW_SEED, gigId],
      program.programId,
    )

    const hirerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      hirer.publicKey,
    )
    const workerAta = await createAssociatedTokenAccount(
      provider.connection,
      payer.payer,
      mint,
      worker.publicKey,
    )
    // Mint 1000 LDGR to hirer (using mint test, 9 decimals).
    await mintTo(provider.connection, payer.payer, mint, hirerAta, payer.payer, 1_000_000_000_000)

    const milestone0 = new BN(300_000_000_000) // 300 LDGR
    const milestone1 = new BN(700_000_000_000) // 700 LDGR

    // 1. initialize
    await program.methods
      .initialize([...gigId], [milestone0, milestone1])
      .accounts({
        hirer: hirer.publicKey,
        worker: worker.publicKey,
        moderator: moderator.publicKey,
        mint,
        escrow: escrowPda,
        hirerAta,
        systemProgram: SystemProgram.programId,
      })
      .signers([hirer])
      .rpc()

    const escrowAccount = await program.account.escrow.fetch(escrowPda)
    expect(escrowAccount.amountTotal.toString()).to.eq('1000000000000')

    // 2. release milestone 0 with moderator alone.
    await program.methods
      .releaseMilestone(0)
      .accounts({
        hirer: hirer.publicKey,
        worker: worker.publicKey,
        moderator: moderator.publicKey,
        escrow: escrowPda,
        workerAta,
      })
      .signers([hirer, worker, moderator]) // anchor requires Signer accounts; on-chain logic only checks `moderator.is_signer`
      .rpc()

    const workerBal0 = await getAccount(provider.connection, workerAta)
    expect(workerBal0.amount.toString()).to.eq('300000000000')

    // 3. release milestone 1.
    await program.methods
      .releaseMilestone(1)
      .accounts({
        hirer: hirer.publicKey,
        worker: worker.publicKey,
        moderator: moderator.publicKey,
        escrow: escrowPda,
        workerAta,
      })
      .signers([hirer, worker, moderator])
      .rpc()

    const workerBal1 = await getAccount(provider.connection, workerAta)
    expect(workerBal1.amount.toString()).to.eq('1000000000000')

    // 4. refund on an exhausted escrow should fail with NothingToRefund.
    try {
      await program.methods
        .refund()
        .accounts({
          hirer: hirer.publicKey,
          worker: worker.publicKey,
          moderator: moderator.publicKey,
          escrow: escrowPda,
          hirerAta,
        })
        .signers([hirer, worker, moderator])
        .rpc()
      throw new Error('refund should have failed')
    } catch (e: any) {
      expect(String(e.message)).to.match(/NothingToRefund|nothing remaining/i)
    }
  })
})

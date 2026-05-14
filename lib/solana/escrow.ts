// Anchor escrow client. Dynamic-imports @coral-xyz/anchor so the existing
// Next.js build doesn't require Anchor until the Bazaar wires it in.
//
// Two execution modes:
//   - server-side ix builders (initialize, release, refund) that return a
//     serialized unsigned transaction the hirer signs in Phantom
//   - server-side signed release/refund where the Lila bot's signing key
//     (LILA_BOT_SOLANA_SECRET) acts as the sole moderator signer
//
// IDL is loaded from programs/ldgr/target/idl/ldgr_escrow.json once anchor
// build has run. Until then, the loader returns null and the routes 503.

import { getConnection } from './client'
import { ldgrToBase } from './ldgr'
import { createHash } from 'crypto'

export const ESCROW_SEED = Buffer.from('escrow')

export function gigIdBytes(gigId: number | string): Buffer {
  // 32-byte canonical id: sha256(`gig:<id>`). Stable and unique per gig.
  return createHash('sha256').update(`gig:${gigId}`).digest()
}

async function loadIdl(): Promise<unknown | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const idl = await import(
      '../../programs/ldgr/target/idl/ldgr_escrow.json' as string
    ).catch(() => null)
    return idl && (idl as { default?: unknown }).default
      ? (idl as { default: unknown }).default
      : idl
  } catch {
    return null
  }
}

export interface EscrowAccounts {
  programId: string
  escrowPda: string
  vaultAta: string
}

export async function deriveEscrowAccounts(
  gigId: number,
  hirerPubkey: string,
  workerPubkey: string,
  moderatorPubkey: string,
): Promise<EscrowAccounts> {
  const programId = process.env.LDGR_ESCROW_PROGRAM_ID
  const mint = process.env.LDGR_MINT
  if (!programId || !mint) throw new Error('LDGR_ESCROW_PROGRAM_ID / LDGR_MINT not set')

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const [web3, spl] = await Promise.all([
    import('@solana/web3.js' as string),
    import('@solana/spl-token' as string),
  ])
  // @ts-expect-error dynamic
  const pid = new web3.PublicKey(programId)
  const seed = gigIdBytes(gigId)
  // @ts-expect-error dynamic
  const [pda] = web3.PublicKey.findProgramAddressSync([ESCROW_SEED, seed], pid)
  // @ts-expect-error dynamic
  const vault = await spl.getAssociatedTokenAddress(
    // @ts-expect-error dynamic
    new web3.PublicKey(mint),
    pda,
    true, // allowOwnerOffCurve — PDA owns the vault
  )
  return {
    programId,
    escrowPda: pda.toBase58(),
    vaultAta: vault.toBase58(),
  }
}

// Builds an unsigned transaction for the hirer to fund a gig escrow.
// Returns base64-encoded serialized tx the client signs in Phantom.
export async function buildInitializeTx(args: {
  gigId: number
  hirerPubkey: string
  workerPubkey: string
  moderatorPubkey: string
  milestoneAmountsLdgr: string[]
}): Promise<{ tx: string; accounts: EscrowAccounts }> {
  const idl = await loadIdl()
  if (!idl) throw new Error('escrow IDL not built. cd programs/ldgr && anchor build')

  const accounts = await deriveEscrowAccounts(
    args.gigId,
    args.hirerPubkey,
    args.workerPubkey,
    args.moderatorPubkey,
  )

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const [web3, anchor, spl] = await Promise.all([
    import('@solana/web3.js' as string),
    import('@coral-xyz/anchor' as string),
    import('@solana/spl-token' as string),
  ])
  const conn = await getConnection()
  // @ts-expect-error dynamic
  const provider = new anchor.AnchorProvider(conn, { publicKey: new web3.PublicKey(args.hirerPubkey) } as any, { commitment: 'confirmed' })
  // @ts-expect-error dynamic
  const program = new anchor.Program(idl as any, accounts.programId, provider)

  const mintPk = process.env.LDGR_MINT!
  const seed = gigIdBytes(args.gigId)
  const amountsBase = args.milestoneAmountsLdgr.map((a) => {
    // @ts-expect-error dynamic
    return new anchor.BN(ldgrToBase(a).toString())
  })

  // @ts-expect-error dynamic
  const hirerAta = await spl.getAssociatedTokenAddress(new web3.PublicKey(mintPk), new web3.PublicKey(args.hirerPubkey))

  // @ts-expect-error dynamic
  const ix = await program.methods
    .initialize([...seed], amountsBase)
    .accounts({
      hirer: args.hirerPubkey,
      worker: args.workerPubkey,
      moderator: args.moderatorPubkey,
      mint: mintPk,
      escrow: accounts.escrowPda,
      vault: accounts.vaultAta,
      hirerAta: hirerAta.toBase58(),
    })
    .instruction()

  // @ts-expect-error dynamic
  const { blockhash } = await conn.getLatestBlockhash('confirmed')
  // @ts-expect-error dynamic
  const tx = new web3.Transaction({ feePayer: new web3.PublicKey(args.hirerPubkey), recentBlockhash: blockhash }).add(ix)
  const serialized = tx.serialize({ requireAllSignatures: false }).toString('base64')
  return { tx: serialized, accounts }
}

// Server-side release: Lila bot signs as the moderator. Used when the bot
// has verified a milestone proof event in the Matrix room.
export async function releaseMilestoneAsModerator(args: {
  gigId: number
  hirerPubkey: string
  workerPubkey: string
  milestoneIdx: number
}): Promise<string> {
  const idl = await loadIdl()
  if (!idl) throw new Error('escrow IDL not built')
  const secret = process.env.LILA_BOT_SOLANA_SECRET
  if (!secret) throw new Error('LILA_BOT_SOLANA_SECRET not set')

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const [web3, anchor, spl, bs58] = await Promise.all([
    import('@solana/web3.js' as string),
    import('@coral-xyz/anchor' as string),
    import('@solana/spl-token' as string),
    import('bs58' as string),
  ])
  // @ts-expect-error dynamic
  const moderator = web3.Keypair.fromSecretKey(bs58.default.decode(secret))
  const accounts = await deriveEscrowAccounts(
    args.gigId,
    args.hirerPubkey,
    args.workerPubkey,
    moderator.publicKey.toBase58(),
  )
  const conn = await getConnection()
  // @ts-expect-error dynamic
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(moderator), { commitment: 'confirmed' })
  // @ts-expect-error dynamic
  const program = new anchor.Program(idl as any, accounts.programId, provider)

  // @ts-expect-error dynamic
  const workerAta = await spl.getAssociatedTokenAddress(
    new web3.PublicKey(process.env.LDGR_MINT!),
    new web3.PublicKey(args.workerPubkey),
  )

  // @ts-expect-error dynamic
  const sig: string = await program.methods
    .releaseMilestone(args.milestoneIdx)
    .accounts({
      hirer: args.hirerPubkey,
      worker: args.workerPubkey,
      moderator: moderator.publicKey,
      escrow: accounts.escrowPda,
      vault: accounts.vaultAta,
      workerAta: workerAta.toBase58(),
    })
    .signers([moderator])
    .rpc()

  return sig
}

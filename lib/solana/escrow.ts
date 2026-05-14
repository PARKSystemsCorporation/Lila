// Anchor escrow client. Solana deps are loaded through the webpack-opaque
// indirection in ./_dynamic so the Next.js build doesn't choke when the
// Bazaar deps aren't installed.
//
// Two execution modes:
//   - server-side ix builders (initialize, release, refund) that return a
//     serialized unsigned transaction the hirer signs in Phantom
//   - server-side signed release/refund where the Lila bot's signing key
//     (LILA_BOT_SOLANA_SECRET) acts as the sole moderator signer
//
// IDL is loaded from programs/ldgr/target/idl/ldgr_escrow.json once anchor
// build has run. Until then, the loader returns null and the routes 503.

import { createHash } from 'crypto'
import { getConnection } from './client'
import { requireOptional, loadOptional } from './_dynamic'
import { ldgrToBase } from './ldgr'

export const ESCROW_SEED = Buffer.from('escrow')

export function gigIdBytes(gigId: number | string): Buffer {
  // 32-byte canonical id: sha256(`gig:<id>`). Stable and unique per gig.
  return createHash('sha256').update(`gig:${gigId}`).digest()
}

async function loadIdl(): Promise<unknown | null> {
  // The IDL JSON file lives outside the Next.js source tree at
  // programs/ldgr/target/idl/ldgr_escrow.json. Load it through the same
  // webpack-opaque indirection so a missing IDL doesn't break the build.
  return await loadOptional('../../programs/ldgr/target/idl/ldgr_escrow.json')
}

export interface EscrowAccounts {
  programId: string
  escrowPda: string
  vaultAta: string
}

interface Web3Mod {
  PublicKey: { new (s: string): unknown; findProgramAddressSync: (seeds: Buffer[], pid: unknown) => [{ toBase58: () => string }, number] }
  Connection: new (url: string, c: string) => unknown
  Keypair: { fromSecretKey: (s: Uint8Array) => { publicKey: { toBase58: () => string } } }
  Transaction: new (opts: unknown) => { add: (ix: unknown) => { serialize: (o: unknown) => Buffer } }
}

interface SplMod {
  getAssociatedTokenAddress: (mint: unknown, owner: unknown, allowOwnerOffCurve?: boolean) => Promise<{ toBase58: () => string }>
}

interface AnchorMod {
  AnchorProvider: new (conn: unknown, wallet: unknown, opts: unknown) => unknown
  Program: new (idl: unknown, pid: string, provider: unknown) => unknown
  BN: new (n: string) => unknown
  Wallet: new (kp: unknown) => unknown
}

interface Bs58Mod { default: { decode: (s: string) => Uint8Array } }

export async function deriveEscrowAccounts(
  gigId: number,
  _hirerPubkey: string,
  _workerPubkey: string,
  _moderatorPubkey: string,
): Promise<EscrowAccounts> {
  const programId = process.env.LDGR_ESCROW_PROGRAM_ID
  const mint = process.env.LDGR_MINT
  if (!programId || !mint) throw new Error('LDGR_ESCROW_PROGRAM_ID / LDGR_MINT not set')

  const web3 = (await requireOptional('@solana/web3.js')) as unknown as Web3Mod
  const spl = (await requireOptional('@solana/spl-token')) as unknown as SplMod
  const pid = new web3.PublicKey(programId)
  const seed = gigIdBytes(gigId)
  const [pda] = web3.PublicKey.findProgramAddressSync([ESCROW_SEED, seed], pid)
  const vault = await spl.getAssociatedTokenAddress(
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

  const web3 = (await requireOptional('@solana/web3.js')) as unknown as Web3Mod
  const anchor = (await requireOptional('@coral-xyz/anchor')) as unknown as AnchorMod
  const spl = (await requireOptional('@solana/spl-token')) as unknown as SplMod
  const conn = await getConnection()
  const provider = new anchor.AnchorProvider(conn, { publicKey: new web3.PublicKey(args.hirerPubkey) }, { commitment: 'confirmed' })
  const program = new anchor.Program(idl, accounts.programId, provider) as unknown as {
    methods: {
      initialize: (seed: number[], amounts: unknown[]) => {
        accounts: (a: Record<string, string>) => { instruction: () => Promise<unknown> }
      }
    }
  }

  const mintPk = process.env.LDGR_MINT!
  const seed = gigIdBytes(args.gigId)
  const amountsBase = args.milestoneAmountsLdgr.map((a) => new anchor.BN(ldgrToBase(a).toString()))

  const hirerAta = await spl.getAssociatedTokenAddress(new web3.PublicKey(mintPk), new web3.PublicKey(args.hirerPubkey))

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

  const connTyped = conn as { getLatestBlockhash: (c: string) => Promise<{ blockhash: string }> }
  const { blockhash } = await connTyped.getLatestBlockhash('confirmed')
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

  const web3 = (await requireOptional('@solana/web3.js')) as unknown as Web3Mod
  const anchor = (await requireOptional('@coral-xyz/anchor')) as unknown as AnchorMod
  const spl = (await requireOptional('@solana/spl-token')) as unknown as SplMod
  const bs58 = (await requireOptional('bs58')) as unknown as Bs58Mod
  const moderator = web3.Keypair.fromSecretKey(bs58.default.decode(secret))
  const accounts = await deriveEscrowAccounts(
    args.gigId,
    args.hirerPubkey,
    args.workerPubkey,
    moderator.publicKey.toBase58(),
  )
  const conn = await getConnection()
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(moderator), { commitment: 'confirmed' })
  const program = new anchor.Program(idl, accounts.programId, provider) as unknown as {
    methods: {
      releaseMilestone: (idx: number) => {
        accounts: (a: Record<string, string>) => { signers: (s: unknown[]) => { rpc: () => Promise<string> } }
      }
    }
  }

  const workerAta = await spl.getAssociatedTokenAddress(
    new web3.PublicKey(process.env.LDGR_MINT!),
    new web3.PublicKey(args.workerPubkey),
  )

  const sig: string = await program.methods
    .releaseMilestone(args.milestoneIdx)
    .accounts({
      hirer: args.hirerPubkey,
      worker: args.workerPubkey,
      moderator: (moderator.publicKey as { toBase58: () => string }).toBase58(),
      escrow: accounts.escrowPda,
      vault: accounts.vaultAta,
      workerAta: workerAta.toBase58(),
    })
    .signers([moderator])
    .rpc()

  return sig
}

// $LDGR helpers — mint + balance + transfer. Wraps @solana/spl-token so the
// rest of the app deals in string-amounts. Solana deps are loaded through
// the webpack-opaque indirection in ./_dynamic so the Next.js build works
// even when the Bazaar deps haven't been installed.

import { getConnection } from './client'
import { requireOptional } from './_dynamic'

export const LDGR_DECIMALS = 9

function mintPubkeyOrThrow(): string {
  const mint = process.env.LDGR_MINT
  if (!mint) throw new Error('LDGR_MINT not set')
  return mint
}

const TEN = BigInt(10)

export function ldgrToBase(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.')
  const padded = (frac + '0'.repeat(LDGR_DECIMALS)).slice(0, LDGR_DECIMALS)
  return BigInt(whole) * TEN ** BigInt(LDGR_DECIMALS) + BigInt(padded || '0')
}

export function baseToLdgr(base: bigint | string | number): string {
  const b = typeof base === 'bigint' ? base : BigInt(base)
  const divisor = TEN ** BigInt(LDGR_DECIMALS)
  const whole = b / divisor
  const frac = (b % divisor).toString().padStart(LDGR_DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

interface Web3Mod {
  PublicKey: new (s: string) => unknown
  Connection: new (url: string, c: string) => unknown
  Keypair: { fromSecretKey: (s: Uint8Array) => { publicKey: unknown } }
}

interface SplMod {
  getOrCreateAssociatedTokenAccount: (...args: unknown[]) => Promise<{ address: unknown }>
  mintTo: (...args: unknown[]) => Promise<string>
  getAssociatedTokenAddress: (...args: unknown[]) => Promise<{ toBase58: () => string }>
}

interface Bs58Mod { default: { decode: (s: string) => Uint8Array } }

interface ParsedAccount {
  account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } }
}

export async function getLdgrBalance(walletPubkey: string): Promise<string> {
  const conn = (await getConnection()) as {
    getParsedTokenAccountsByOwner: (
      owner: unknown,
      filter: { mint: unknown },
    ) => Promise<{ value: ParsedAccount[] }>
  }
  const web3 = (await requireOptional('@solana/web3.js')) as unknown as Web3Mod
  const owner = new web3.PublicKey(walletPubkey)
  const mint = new web3.PublicKey(mintPubkeyOrThrow())
  const r = await conn.getParsedTokenAccountsByOwner(owner, { mint })
  let total = BigInt(0)
  for (const entry of r.value) {
    total += BigInt(entry.account.data.parsed.info.tokenAmount.amount)
  }
  return baseToLdgr(total)
}

// Mints $LDGR to `recipient`. Mint authority signer must be available as
// LDGR_MINT_AUTHORITY_SECRET env var (base58 secret key). Devnet only;
// mainnet must rotate to a multisig and remove this function.
export async function mintLdgrTo(
  recipientPubkey: string,
  amountLdgr: string,
): Promise<string> {
  const secret = process.env.LDGR_MINT_AUTHORITY_SECRET
  if (!secret) throw new Error('LDGR_MINT_AUTHORITY_SECRET not set (devnet-only operator)')

  const web3 = (await requireOptional('@solana/web3.js')) as unknown as Web3Mod
  const spl = (await requireOptional('@solana/spl-token')) as unknown as SplMod
  const bs58 = (await requireOptional('bs58')) as unknown as Bs58Mod

  const conn = new web3.Connection(
    process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
    'confirmed',
  )
  const authority = web3.Keypair.fromSecretKey(bs58.default.decode(secret))
  const mint = new web3.PublicKey(mintPubkeyOrThrow())
  const recipient = new web3.PublicKey(recipientPubkey)
  const ata = await spl.getOrCreateAssociatedTokenAccount(conn, authority, mint, recipient)

  const amt = ldgrToBase(amountLdgr)
  const sig = await spl.mintTo(conn, authority, mint, ata.address, authority, amt)
  return String(sig)
}

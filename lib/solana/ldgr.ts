// $LDGR helpers — mint + balance + transfer. Wraps @solana/spl-token so the
// rest of the app deals in string-amounts.

import { getConnection } from './client'

export const LDGR_DECIMALS = 9

function mintPubkeyOrThrow(): string {
  const mint = process.env.LDGR_MINT
  if (!mint) throw new Error('LDGR_MINT not set')
  return mint
}

export function ldgrToBase(amount: string): bigint {
  const [whole, frac = ''] = amount.split('.')
  const padded = (frac + '0'.repeat(LDGR_DECIMALS)).slice(0, LDGR_DECIMALS)
  return BigInt(whole) * 10n ** BigInt(LDGR_DECIMALS) + BigInt(padded || '0')
}

export function baseToLdgr(base: bigint | string | number): string {
  const b = typeof base === 'bigint' ? base : BigInt(base)
  const divisor = 10n ** BigInt(LDGR_DECIMALS)
  const whole = b / divisor
  const frac = (b % divisor).toString().padStart(LDGR_DECIMALS, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

export async function getLdgrBalance(walletPubkey: string): Promise<string> {
  const conn = (await getConnection()) as {
    getParsedTokenAccountsByOwner: (
      owner: unknown,
      filter: { mint: unknown },
    ) => Promise<{ value: Array<{ account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }> }>
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const web3 = await import('@solana/web3.js' as string)
  // @ts-expect-error dynamic
  const owner = new web3.PublicKey(walletPubkey)
  // @ts-expect-error dynamic
  const mint = new web3.PublicKey(mintPubkeyOrThrow())
  const r = await conn.getParsedTokenAccountsByOwner(owner, { mint })
  let total = 0n
  for (const entry of r.value) {
    total += BigInt(entry.account.data.parsed.info.tokenAmount.amount)
  }
  return baseToLdgr(total)
}

// Mints $LDGR to `recipient`. Mint authority signer must be available as
// the LDGR_MINT_AUTHORITY_SECRET env var (base58 secret key). Devnet only;
// mainnet must rotate to a multisig and remove this function.
export async function mintLdgrTo(
  recipientPubkey: string,
  amountLdgr: string,
): Promise<string> {
  const secret = process.env.LDGR_MINT_AUTHORITY_SECRET
  if (!secret) throw new Error('LDGR_MINT_AUTHORITY_SECRET not set (devnet-only operator)')

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const [web3, spl, bs58] = await Promise.all([
    import('@solana/web3.js' as string),
    import('@solana/spl-token' as string),
    import('bs58' as string),
  ])

  // @ts-expect-error dynamic
  const conn = new web3.Connection(
    process.env.SOLANA_RPC_URL ?? 'https://api.devnet.solana.com',
    'confirmed',
  )
  // @ts-expect-error dynamic
  const authority = web3.Keypair.fromSecretKey(bs58.default.decode(secret))
  // @ts-expect-error dynamic
  const mint = new web3.PublicKey(mintPubkeyOrThrow())
  // @ts-expect-error dynamic
  const recipient = new web3.PublicKey(recipientPubkey)
  // @ts-expect-error dynamic
  const ata = await spl.getOrCreateAssociatedTokenAccount(conn, authority, mint, recipient)

  const amt = ldgrToBase(amountLdgr)
  // @ts-expect-error dynamic
  const sig = await spl.mintTo(conn, authority, mint, ata.address, authority, amt)
  return String(sig)
}

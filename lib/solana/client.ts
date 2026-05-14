// Lazy Solana RPC client. We keep web3.js imports dynamic so the existing
// Next.js build doesn't require @solana/web3.js until the Bazaar wires it in.
//
// Env:
//   SOLANA_RPC_URL  — full RPC url (Helius, QuickNode, or public devnet)
//   HELIUS_API_KEY  — optional; appended as ?api-key=... when present
//   SOLANA_CLUSTER  — 'devnet' (default) or 'mainnet-beta'

export type Cluster = 'devnet' | 'mainnet-beta'

export function getCluster(): Cluster {
  const c = (process.env.SOLANA_CLUSTER ?? 'devnet').toLowerCase()
  return c === 'mainnet-beta' ? 'mainnet-beta' : 'devnet'
}

export function getRpcUrl(): string {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL
  const cluster = getCluster()
  const base =
    cluster === 'mainnet-beta'
      ? 'https://api.mainnet-beta.solana.com'
      : 'https://api.devnet.solana.com'
  if (process.env.HELIUS_API_KEY) {
    const heliusHost =
      cluster === 'mainnet-beta' ? 'mainnet.helius-rpc.com' : 'devnet.helius-rpc.com'
    return `https://${heliusHost}/?api-key=${process.env.HELIUS_API_KEY}`
  }
  return base
}

import { requireOptional } from './_dynamic'

// Returns an `@solana/web3.js` Connection. The dynamic import is hidden
// behind a webpack-opaque indirection (see lib/solana/_dynamic.ts) so the
// Next.js build doesn't try to bundle Solana deps when they aren't
// installed.
export async function getConnection(): Promise<unknown> {
  const web3 = await requireOptional('@solana/web3.js')
  const Connection = (web3 as { Connection: new (url: string, c: string) => unknown }).Connection
  return new Connection(getRpcUrl(), 'confirmed')
}

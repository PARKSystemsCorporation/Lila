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

// Returns an `@solana/web3.js` Connection. Dynamic import avoids a hard
// build-time dependency.
export async function getConnection(): Promise<unknown> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const web3 = await import('@solana/web3.js' as string).catch(() => null)
  if (!web3) {
    throw new Error(
      "@solana/web3.js not installed. Run: npm install @solana/web3.js @solana/spl-token @coral-xyz/anchor",
    )
  }
  // @ts-expect-error dynamic
  return new web3.Connection(getRpcUrl(), 'confirmed')
}

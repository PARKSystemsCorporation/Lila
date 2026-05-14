// One-shot devnet deployment helper.
//
// Usage (after `anchor build`):
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/devnet.json \
//   ts-node migrations/deploy.ts
//
// Prints the deployed program id and the LDGR mint pubkey. Save both into
// the Next.js .env as LDGR_ESCROW_PROGRAM_ID and LDGR_MINT.

import * as anchor from '@coral-xyz/anchor'
import { createMint } from '@solana/spl-token'

async function main() {
  const provider = anchor.AnchorProvider.env()
  anchor.setProvider(provider)

  const wallet = provider.wallet as anchor.Wallet

  // The Anchor program itself is deployed via `anchor deploy`; this script
  // just creates the LDGR SPL mint (9 decimals, mint authority = wallet for
  // devnet; rotate to a multisig before mainnet).
  const mint = await createMint(
    provider.connection,
    wallet.payer,
    wallet.publicKey, // mint authority — devnet only
    null, // freeze authority disabled
    9,
  )

  console.log('LDGR_MINT=' + mint.toBase58())
  console.log('ESCROW program id is taken from Anchor.toml [programs.devnet]')
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  },
)

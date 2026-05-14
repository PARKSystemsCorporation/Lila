# ldgr — Solana programs for The Bazaar

Two artifacts ship from here:

1. **`$LDGR` SPL mint** — standard SPL token, 9 decimals, freeze authority `None`.
   Created via `migrations/deploy.ts` using `@solana/spl-token`. Mint authority
   should be rotated to a 2-of-3 multisig before mainnet.

2. **`ldgr-escrow` Anchor program** — milestone-gated escrow. One PDA per gig
   (`[b"escrow", gig_id]`). Vault is an ATA owned by the PDA. Release rules:
   moderator alone OR hirer + worker co-sign. Refund follows the same rules.

## Build

```bash
cd programs/ldgr
anchor build
```

Build emits IDL at `target/idl/ldgr_escrow.json`. The Next.js TS client in
`lib/solana/escrow.ts` consumes this IDL.

## Test

```bash
anchor test
```

Spins up a local validator and runs `tests/escrow.ts` end-to-end (init,
two milestone releases, refund-after-exhaust failure).

## Deploy to devnet

```bash
solana-keygen new --outfile ~/.config/solana/devnet.json   # if needed
solana airdrop 5 -k ~/.config/solana/devnet.json --url devnet

anchor build
anchor deploy --provider.cluster devnet
# copy the program id into Anchor.toml [programs.devnet] and into the
# Next.js .env as LDGR_ESCROW_PROGRAM_ID.

ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/devnet.json \
ts-node migrations/deploy.ts
# prints LDGR_MINT=... — add to Next.js .env.
```

## Mainnet cutover (gated)

Pre-conditions before any mainnet deploy:

- Independent audit of `programs/ldgr-escrow/src/lib.rs` (e.g. Neodyme,
  OtterSec).
- Mint authority rotated from a hot wallet to a 2-of-3 multisig.
- Bot signing key custody documented; key rotation tested on devnet.
- Allowlist of approved agents non-empty.

Do not point `Anchor.toml [provider.cluster]` at mainnet-beta until all
four conditions are met.

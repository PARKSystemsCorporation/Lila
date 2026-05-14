// Webpack-opaque dynamic import. The Bazaar's Solana deps (@solana/web3.js,
// @solana/spl-token, @coral-xyz/anchor, tweetnacl, bs58) are NOT pinned in
// package.json — they're only needed when LDGR escrow is wired. Bundling
// them adds ~MB of code to every cold start for a feature most viewers
// never touch.
//
// `import('@solana/web3.js')` would let webpack try to bundle it at build
// time, which fails when the dep isn't installed. The `new Function`
// indirection makes the specifier non-static so webpack leaves it alone.
// At runtime, the host either has the module installed (Bazaar configured)
// or `loadOptional` returns `null` and the caller surfaces a 503.

type AnyMod = Record<string, unknown> & { default?: unknown }

const dynamicImport = new Function('m', 'return import(m)') as (m: string) => Promise<AnyMod>

export async function loadOptional(specifier: string): Promise<AnyMod | null> {
  try {
    return await dynamicImport(specifier)
  } catch {
    return null
  }
}

export async function requireOptional(specifier: string): Promise<AnyMod> {
  const mod = await loadOptional(specifier)
  if (!mod) {
    throw new Error(
      `Bazaar dep '${specifier}' not installed. Run: npm install @solana/web3.js @solana/spl-token @coral-xyz/anchor tweetnacl bs58`,
    )
  }
  return mod
}

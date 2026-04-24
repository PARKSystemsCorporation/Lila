// Operator-configurable affiliate map. Tools we'd plausibly mention in a
// research deep-dive get listed here; if an affiliate URL is set on Railway,
// the article generator turns mentions into markdown links. Empty url =
// plain-text mention only (no fabricated link).
//
// The free OSS tools (Slither, Echidna, Halmos, Foundry, Hardhat) don't
// have affiliate programs and shouldn't either — we list them so the LLM
// can mention them naturally without pretending we get paid for the click.

export interface Affiliate {
  name: string
  url: string | null
  note?: string
}

export function getAffiliates(): Affiliate[] {
  return [
    // Free OSS — mention plain
    { name: 'Slither',  url: null, note: 'Free static analyzer.' },
    { name: 'Echidna',  url: null, note: 'Free property fuzzer.' },
    { name: 'Halmos',   url: null, note: 'Free symbolic execution.' },
    { name: 'Foundry',  url: null, note: 'Free EVM toolkit.' },
    { name: 'Hardhat',  url: null, note: 'Free dev environment.' },

    // Programs the operator may have signed up for. Flip on by setting env.
    { name: 'Tenderly',     url: process.env.TENDERLY_AFF     ?? null },
    { name: 'Cantina',      url: process.env.CANTINA_AFF      ?? null },
    { name: 'Sherlock',     url: process.env.SHERLOCK_AFF     ?? null },
    { name: 'Code4rena',    url: process.env.CODE4RENA_AFF    ?? null },
    { name: 'Immunefi',     url: process.env.IMMUNEFI_AFF     ?? null },
    { name: 'GitHub Copilot', url: process.env.COPILOT_AFF    ?? null },
  ]
}

// Renders a small block for prompts: "Tool — affiliate URL (or '— plain
// text only')." So the LLM knows which to hyperlink.
export function affiliatePromptBlock(): string {
  const affs = getAffiliates()
  return affs.map(a =>
    a.url
      ? `- ${a.name} → ${a.url} (link as markdown when you mention it)`
      : `- ${a.name} → no affiliate URL; mention plain text only, do not invent a link`
  ).join('\n')
}

'use client'

import { useState } from 'react'

// Contract-address copy button. Clipboard API with a hidden-textarea
// fallback for older / locked-down browsers (same approach as the landing).

const LDGR_CONTRACT = '7VCPGGaKqeVjtLEe4o4gJUb8Je3ZZm8UA3aB9S3dpump'
const SOLSCAN = `https://solscan.io/token/${LDGR_CONTRACT}`

export function ContractCopy() {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(LDGR_CONTRACT)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = LDGR_CONTRACT
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      try { document.execCommand('copy') } catch { /* noop */ }
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-3 sm:gap-5 items-stretch">
      <button
        type="button"
        onClick={copy}
        aria-label="copy ldgr contract address"
        className="group flex flex-col items-start border-2 border-amber-500/40 hover:border-amber-300 bg-[#0a0c14]/60 hover:bg-[#0a0c14]/80 p-5 text-left transition-colors min-w-0"
      >
        <div className="flex w-full items-center justify-between gap-3">
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-400/90">
            $ldgr · contract · spl mint
          </span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300 group-hover:text-white transition-colors">
            {copied ? '✓ copied' : '⎘ click to copy'}
          </span>
        </div>
        <div className="mt-3 w-full font-mono text-xs sm:text-sm text-white break-all select-all">
          {LDGR_CONTRACT}
        </div>
        <div className="mt-3 font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500">
          solana · spl token
        </div>
      </button>

      <a
        href={SOLSCAN}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex flex-col justify-between border-2 border-amber-500/40 hover:border-amber-300 bg-[#0a0c14]/60 hover:bg-[#0a0c14]/80 px-5 py-5 transition-colors lg:min-w-[220px]"
      >
        <div className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-400/90">
          verify on
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-2xl font-black tracking-tight uppercase text-white">solscan</span>
          <span className="font-mono text-[10px] tracking-[0.32em] uppercase text-amber-300 group-hover:translate-x-0.5 transition-transform">↗</span>
        </div>
        <div className="mt-3 font-mono text-[10px] tracking-[0.32em] uppercase text-slate-500 truncate">
          on-chain · tamper-proof
        </div>
      </a>
    </div>
  )
}

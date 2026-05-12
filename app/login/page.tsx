'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

const LandingSculpture = dynamic(() => import('../_components/landing-sculpture'), {
  ssr: false,
  loading: () => null,
})

type Mode = 'operator' | 'viewer'

export default function Login() {
  // Front tab is the member (Gumroad key) sign-in. Operator is the back tab.
  const [mode, setMode] = useState<Mode>('viewer')
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const submit = async () => {
    if (!code.trim() || loading) return
    setLoading(true)
    setError(null)

    if (mode === 'operator') {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: code }),
      })
      if (res.ok) {
        router.replace('/thepark/operator')
      } else {
        setError('Wrong. Try again.')
        setCode('')
        setLoading(false)
      }
      return
    }

    const res = await fetch('/api/viewer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: code.trim() }),
    })
    if (res.ok) {
      router.replace('/local')
    } else {
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Could not verify the key.')
      setLoading(false)
    }
  }

  const switchMode = (m: Mode) => {
    if (loading) return
    setMode(m)
    setCode('')
    setError(null)
  }

  return (
    <main className="relative min-h-dvh w-full bg-[#0a0c14] text-slate-100 selection:bg-amber-500/30 selection:text-amber-100 overflow-x-hidden">
      {/* Brutalist grid wash */}
      <div
        className="pointer-events-none fixed inset-0 -z-20 opacity-30"
        style={{
          backgroundImage:
            'linear-gradient(rgba(245,158,11,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(245,158,11,0.06) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />

      {/* Three.js sculpture lives behind everything */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <LandingSculpture />
        <div
          className="absolute inset-0"
          style={{ background: 'radial-gradient(ellipse at center, transparent 30%, rgba(10,12,20,0.85) 85%)' }}
        />
      </div>

      {/* Header */}
      <header
        className="relative z-20 flex items-center justify-between px-5 sm:px-8 py-4 border-b-2 border-amber-500/15"
        style={{ paddingTop: 'max(16px, env(safe-area-inset-top))' }}
      >
        <div className="flex items-center gap-2.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shadow-[0_0_10px_rgba(245,158,11,0.9)]" />
          <span className="font-mono text-[10px] tracking-[0.32em] text-amber-500/80 uppercase">
            ▓ parksystems · corp
          </span>
        </div>
        <a
          href="/"
          className="font-mono text-[10px] tracking-[0.32em] uppercase border-2 border-amber-500/40 hover:border-amber-300 text-amber-300 hover:text-white px-3 py-2 transition-colors"
        >
          ← back
        </a>
      </header>

      {/* Sign-in card */}
      <section className="relative z-10 flex items-center justify-center px-5 sm:px-8 py-16 sm:py-24">
        <div className="w-full max-w-md border-2 border-amber-500/40 bg-slate-950/70 backdrop-blur-sm p-6 sm:p-8 motion-safe:animate-[slideup_0.5s_ease-out_both]">
          <p className="font-mono text-[10px] sm:text-[11px] tracking-[0.45em] text-amber-500/80 uppercase">
            ▌▌▌ sign in
          </p>
          <h1 className="mt-3 text-[clamp(2rem,7vw,3rem)] font-black tracking-tight leading-[0.95] uppercase">
            <span className="text-white">the</span>{' '}
            <span className="text-amber-400 [text-shadow:0_0_30px_rgba(245,158,11,0.5)]">park</span>
            <span className="text-slate-600">.world</span>
          </h1>
          <p className="mt-3 text-sm text-slate-400 leading-relaxed">
            {mode === 'viewer'
              ? 'Member · paste your Gumroad license key.'
              : 'Operator · access code.'}
          </p>

          {/* Mode switch */}
          <div className="mt-6 grid grid-cols-2 gap-2">
            <button
              onClick={() => switchMode('viewer')}
              className={`py-2.5 border-2 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors ${
                mode === 'viewer'
                  ? 'bg-amber-400 text-black border-amber-300'
                  : 'border-amber-500/40 text-amber-300 hover:border-amber-300 hover:text-white'
              }`}
            >
              member
            </button>
            <button
              onClick={() => switchMode('operator')}
              className={`py-2.5 border-2 font-mono text-[10px] tracking-[0.32em] uppercase transition-colors ${
                mode === 'operator'
                  ? 'bg-amber-400 text-black border-amber-300'
                  : 'border-amber-500/40 text-amber-300 hover:border-amber-300 hover:text-white'
              }`}
            >
              operator
            </button>
          </div>

          {/* Input */}
          <div className="mt-4 space-y-3">
            <input
              type={mode === 'operator' ? 'password' : 'text'}
              value={code}
              onChange={e => { setCode(e.target.value); setError(null) }}
              onKeyDown={e => e.key === 'Enter' && submit()}
              placeholder={mode === 'operator' ? 'access code' : 'gumroad license key'}
              autoFocus
              className={`w-full bg-slate-950/80 border-2 px-4 py-3.5 text-center text-base font-mono tracking-widest text-slate-100 placeholder:text-slate-700 focus:outline-none transition-colors ${
                error
                  ? 'border-red-500/60 focus:border-red-400'
                  : 'border-amber-500/40 focus:border-amber-300'
              }`}
            />

            {error && (
              <p className="font-mono text-[10px] tracking-[0.2em] uppercase text-red-400 text-center">
                {error}
              </p>
            )}

            <button
              onClick={submit}
              disabled={!code.trim() || loading}
              className="group w-full inline-flex items-center justify-center gap-3 bg-amber-400 hover:bg-amber-300 disabled:bg-slate-800 disabled:text-slate-600 disabled:border-slate-800 text-black border-2 border-amber-300 px-5 py-3.5 transition-colors"
            >
              <span className="font-mono text-[11px] tracking-[0.32em] uppercase">
                {loading ? 'verifying' : mode === 'operator' ? 'enter' : 'verify key'}
              </span>
              <span className="group-hover:translate-x-0.5 transition-transform">→</span>
            </button>
          </div>

          {mode === 'viewer' && (
            <p className="mt-6 font-mono text-[10px] tracking-[0.2em] uppercase text-slate-500 text-center leading-relaxed">
              no key?{' '}
              <a
                href={process.env.NEXT_PUBLIC_GUMROAD_URL ?? 'https://gumroad.com/l/bfmoe'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-amber-300 hover:text-amber-200 underline underline-offset-4 decoration-amber-500/40"
              >
                buy pass · $10/mo
              </a>
              <span className="block mt-1 text-slate-600 normal-case tracking-normal text-[11px]">
                Key arrives by email. 50 park gates included.
              </span>
            </p>
          )}
        </div>
      </section>

      <footer
        className="relative z-10 px-5 sm:px-8 py-6 flex items-center justify-between gap-2 font-mono text-[9px] sm:text-[10px] tracking-[0.32em] uppercase text-slate-700"
        style={{ paddingBottom: 'max(24px, env(safe-area-inset-bottom))' }}
      >
        <span className="flex items-center gap-2">
          <span className="w-1 h-1 rounded-full bg-amber-500 animate-pulse" />
          a parksystems corp. autonomous operation
        </span>
        <span>v1</span>
      </footer>

      <style jsx global>{`
        @keyframes slideup {
          0%   { opacity: 0; transform: translate3d(0, 18px, 0); }
          100% { opacity: 1; transform: translate3d(0, 0, 0); }
        }
      `}</style>
    </main>
  )
}

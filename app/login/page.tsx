'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

type Mode = 'operator' | 'viewer'

export default function Login() {
  const [mode, setMode] = useState<Mode>('operator')
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
        router.replace('/lila')
      } else {
        setError('Wrong. Try again.')
        setCode('')
        setLoading(false)
      }
      return
    }

    // Viewer: hit Gumroad license verify.
    const res = await fetch('/api/viewer/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ license_key: code.trim() }),
    })
    if (res.ok) {
      router.replace('/viewer')
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
    <div className="h-dvh bg-slate-950 flex flex-col items-center justify-center px-8 max-w-md mx-auto">
      <div className="w-full space-y-6">
        {/* Corporate mark */}
        <pre className="text-emerald-600/70 font-mono text-[10px] leading-tight text-center select-none whitespace-pre">
{`▓▒░ PARKSYSTEMS CORPORATION ░▒▓`}
        </pre>

        {/* Header */}
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-[10px] font-mono text-slate-500 tracking-widest uppercase">Lila Agent</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Identify yourself.</h1>
          <p className="text-xs font-mono text-slate-600">
            {mode === 'operator' ? 'Operator access.' : 'Viewer subscription.'}
          </p>
        </div>

        {/* Mode switch */}
        <div className="flex border border-slate-800 rounded-xl overflow-hidden">
          <button
            onClick={() => switchMode('operator')}
            className={`flex-1 py-2 text-[10px] font-mono tracking-widest uppercase transition-colors ${
              mode === 'operator'
                ? 'bg-emerald-950/40 text-emerald-300'
                : 'text-slate-500 active:bg-slate-900'
            }`}
          >
            Operator
          </button>
          <button
            onClick={() => switchMode('viewer')}
            className={`flex-1 py-2 text-[10px] font-mono tracking-widest uppercase transition-colors ${
              mode === 'viewer'
                ? 'bg-emerald-950/40 text-emerald-300'
                : 'text-slate-500 active:bg-slate-900'
            }`}
          >
            Viewer
          </button>
        </div>

        {/* Input */}
        <div className="space-y-3">
          <input
            type={mode === 'operator' ? 'password' : 'text'}
            value={code}
            onChange={e => { setCode(e.target.value); setError(null) }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder={mode === 'operator' ? 'Access code' : 'Gumroad license key'}
            autoFocus
            className={`w-full bg-slate-900 border rounded-xl px-4 py-3.5 text-center text-lg font-mono tracking-widest text-slate-100 placeholder:text-slate-700 focus:outline-none transition-colors ${
              error ? 'border-red-800 focus:border-red-700' : 'border-slate-800 focus:border-emerald-800'
            }`}
          />

          {error && (
            <p className="text-xs font-mono text-red-400 text-center">{error}</p>
          )}

          <button
            onClick={submit}
            disabled={!code.trim() || loading}
            className="w-full py-3.5 rounded-xl bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-mono text-sm tracking-widest uppercase transition-colors active:bg-emerald-700"
          >
            {loading ? 'Verifying...' : mode === 'operator' ? 'Enter' : 'Verify key'}
          </button>

          {mode === 'viewer' && (
            <p className="text-[10px] font-mono text-slate-600 text-center pt-2 leading-relaxed">
              Don&rsquo;t have a key? Subscribe at{' '}
              <a
                href={process.env.NEXT_PUBLIC_GUMROAD_URL ?? 'https://gumroad.com/'}
                target="_blank"
                rel="noopener noreferrer"
                className="text-emerald-400 underline"
              >
                gumroad
              </a>
              {' '}— Gumroad emails the key after checkout.
            </p>
          )}
        </div>

        {/* Footer mark */}
        <p className="text-[9px] font-mono text-slate-800 text-center tracking-widest pt-4">
          A PARKSYSTEMS CORP. AUTONOMOUS OPERATION
        </p>
      </div>
    </div>
  )
}

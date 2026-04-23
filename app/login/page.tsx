'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function Login() {
  const [code, setCode] = useState('')
  const [error, setError] = useState(false)
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const submit = async () => {
    if (!code.trim() || loading) return
    setLoading(true)
    setError(false)

    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: code }),
    })

    if (res.ok) {
      router.replace('/')
    } else {
      setError(true)
      setCode('')
      setLoading(false)
    }
  }

  return (
    <div className="h-dvh bg-slate-950 flex flex-col items-center justify-center px-8 max-w-md mx-auto">
      <div className="w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-1">
          <div className="flex items-center justify-center gap-2 mb-4">
            <span className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-[10px] font-mono text-slate-500 tracking-widest uppercase">Lila Agent</span>
          </div>
          <h1 className="text-2xl font-bold text-white">Identify yourself.</h1>
          <p className="text-xs font-mono text-slate-600">Access restricted.</p>
        </div>

        {/* Input */}
        <div className="space-y-3">
          <input
            type="password"
            value={code}
            onChange={e => { setCode(e.target.value); setError(false) }}
            onKeyDown={e => e.key === 'Enter' && submit()}
            placeholder="Access code"
            autoFocus
            className={`w-full bg-slate-900 border rounded-xl px-4 py-3.5 text-center text-lg font-mono tracking-widest text-slate-100 placeholder:text-slate-700 focus:outline-none transition-colors ${
              error ? 'border-red-800 focus:border-red-700' : 'border-slate-800 focus:border-emerald-800'
            }`}
          />

          {error && (
            <p className="text-xs font-mono text-red-400 text-center">Wrong. Try again.</p>
          )}

          <button
            onClick={submit}
            disabled={!code.trim() || loading}
            className="w-full py-3.5 rounded-xl bg-emerald-600 disabled:bg-slate-800 disabled:text-slate-600 text-white font-mono text-sm tracking-widest uppercase transition-colors active:bg-emerald-700"
          >
            {loading ? 'Verifying...' : 'Enter'}
          </button>
        </div>
      </div>
    </div>
  )
}

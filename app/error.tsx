'use client'

import { useEffect } from 'react'

// Per-segment error boundary. Catches render errors inside the auth'd app
// tree (e.g. a chart blowing up on malformed data) so one bad render
// doesn't white-screen the whole PWA.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Surface on the server console; operator can check Railway logs.
    console.error('[app/error] render error:', error)
  }, [error])

  return (
    <div className="h-dvh bg-slate-950 text-slate-100 font-mono antialiased flex items-center justify-center px-6">
      <div className="max-w-sm w-full space-y-5 text-center">
        <pre className="text-emerald-600/70 text-[10px] leading-tight select-none">
{`▓▒░ PARKSYSTEMS CORPORATION ░▒▓`}
        </pre>

        <div className="space-y-1">
          <p className="text-[10px] tracking-widest uppercase text-slate-500">Render error</p>
          <h1 className="text-xl font-bold text-white">Something broke on screen.</h1>
          <p className="text-xs text-slate-600 leading-relaxed">
            Lila herself is still running on the server. This is just the UI.
          </p>
        </div>

        {error?.message && (
          <pre className="text-[10px] text-left text-red-400 bg-slate-900 border border-slate-800 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap break-words">
            {error.message}
            {error.digest ? `\n(digest: ${error.digest})` : ''}
          </pre>
        )}

        <button
          onClick={reset}
          className="w-full py-3 rounded-xl bg-emerald-600 text-white font-mono text-sm tracking-widest uppercase active:bg-emerald-700"
        >
          Retry
        </button>
      </div>
    </div>
  )
}

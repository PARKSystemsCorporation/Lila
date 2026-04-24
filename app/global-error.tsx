'use client'

// Root-level error boundary — catches errors in app/layout.tsx itself. Must
// render its own <html> and <body> because it replaces RootLayout entirely.

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body
        style={{
          backgroundColor: '#020617',
          color: '#e2e8f0',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '24px',
        }}
      >
        <div style={{ maxWidth: 400, width: '100%', textAlign: 'center' }}>
          <pre
            style={{
              color: '#059669',
              fontSize: 10,
              opacity: 0.8,
              margin: '0 0 24px 0',
              userSelect: 'none',
            }}
          >
{`▓▒░ PARKSYSTEMS CORPORATION ░▒▓`}
          </pre>
          <p style={{ fontSize: 10, letterSpacing: 2, textTransform: 'uppercase', color: '#64748b', margin: '0 0 4px 0' }}>
            Root error
          </p>
          <h1 style={{ fontSize: 20, color: '#ffffff', margin: '0 0 8px 0' }}>
            The shell crashed.
          </h1>
          <p style={{ fontSize: 12, color: '#475569', margin: '0 0 20px 0', lineHeight: 1.5 }}>
            This is unusual — the layout itself threw. Check Railway logs for the stack.
          </p>
          {error?.message && (
            <pre
              style={{
                fontSize: 10,
                textAlign: 'left',
                color: '#f87171',
                background: '#0f172a',
                border: '1px solid #1e293b',
                borderRadius: 8,
                padding: 12,
                overflowX: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                margin: '0 0 20px 0',
              }}
            >
              {error.message}
              {error.digest ? `\n(digest: ${error.digest})` : ''}
            </pre>
          )}
          <button
            onClick={reset}
            style={{
              width: '100%',
              padding: '12px',
              borderRadius: 12,
              background: '#059669',
              color: '#ffffff',
              fontSize: 14,
              letterSpacing: 2,
              textTransform: 'uppercase',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Retry
          </button>
        </div>
      </body>
    </html>
  )
}

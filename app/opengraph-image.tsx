// Dynamic OpenGraph card. Rendered on the edge by next/og — Satori's
// font support is limited to system Latin, so no block glyphs (▓ ▌) here.

import { ImageResponse } from 'next/og'

export const runtime = 'edge'
export const alt = 'the park.world — autonomous edges across sports, commodities, and stocks'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: '#0a0c14',
          color: '#f1f5f9',
          padding: '60px 72px',
          position: 'relative',
          fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
        }}
      >
        {/* Top mark */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 20, letterSpacing: 8, color: '#f59e0b', textTransform: 'uppercase' }}>
          <span style={{ width: 12, height: 12, borderRadius: 9999, background: '#f59e0b' }} />
          <span>parksystems · corp</span>
        </div>

        {/* Kicker */}
        <div style={{ display: 'flex', marginTop: 60, fontSize: 28, letterSpacing: 14, color: 'rgba(245,158,11,0.85)', textTransform: 'uppercase' }}>
          welcome to
        </div>

        {/* Title */}
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 12, lineHeight: 0.92 }}>
          <span style={{ fontSize: 132, fontWeight: 900, letterSpacing: -3, color: '#ffffff' }}>the</span>
          <span style={{ display: 'flex', fontSize: 132, fontWeight: 900, letterSpacing: -3 }}>
            <span style={{ color: '#fbbf24' }}>park</span>
            <span style={{ color: '#475569' }}>.world</span>
          </span>
        </div>

        {/* Spacer pushes the bottom row down */}
        <div style={{ display: 'flex', flex: 1 }} />

        {/* Bottom row */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', fontSize: 22, letterSpacing: 5, textTransform: 'uppercase', color: 'rgba(241,245,249,0.65)' }}>
          <span>autonomous edges · sports · stocks · commodities</span>
          <span style={{ color: '#fbbf24' }}>$10/mo · 50 pg</span>
        </div>

        {/* Amber rule */}
        <div style={{ display: 'flex', position: 'absolute', left: 0, right: 0, bottom: 0, height: 8, background: '#f59e0b' }} />
      </div>
    ),
    { ...size },
  )
}

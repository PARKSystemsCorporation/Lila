import type { Metadata, Viewport } from 'next'
import './globals.css'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://thepark.world'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'The Park Casino — free-to-play sweepstakes',
    template: '%s · The Park Casino',
  },
  description:
    'Live multiplayer sweepstakes rooms, slots-style action, and real crypto prize redemptions — all free-to-play. No purchase necessary.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Park Casino',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'The Park Casino',
    title: 'The Park Casino — free-to-play sweepstakes',
    description:
      'Live multiplayer sweepstakes, slots-style action, real crypto prize redemptions — free-to-play. No purchase necessary.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'The Park Casino',
    description:
      'Free-to-play sweepstakes rooms with real crypto prize redemptions. No purchase necessary.',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
}

export const viewport: Viewport = {
  themeColor: '#f59e0b',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="apple-touch-icon" href="/icon-192.svg" />
      </head>
      <body className="bg-slate-950 text-slate-100 antialiased">
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `if('serviceWorker' in navigator){window.addEventListener('load',()=>navigator.serviceWorker.register('/sw.js'))}`,
          }}
        />
      </body>
    </html>
  )
}

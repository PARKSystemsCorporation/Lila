import type { Metadata, Viewport } from 'next'
import './globals.css'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://thepark.world'

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'the park.world — autonomous edges',
    template: '%s · the park.world',
  },
  description:
    'Autonomous markets desk. Live edges across NFL, NBA, MLB, NHL, commodities and stocks — running with or without you. $10/month, 50 Park Gates included.',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'park.world',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'the park.world',
    title: 'the park.world — autonomous edges',
    description:
      'Live signals across stocks, commodities, and sports. Markets never sleep. Neither does she.',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'the park.world',
    description:
      'Autonomous markets desk. Live edges across sports, commodities, and stocks.',
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

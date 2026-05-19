import type { MetadataRoute } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://thepark.world'

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: ['Googlebot', 'Bingbot'], allow: '/' },
      {
        userAgent: ['GPTBot', 'CCBot', 'ClaudeBot', 'anthropic-ai', 'PerplexityBot'],
        disallow: '/',
      },
      {
        userAgent: '*',
        disallow: ['/api/', '/login', '/viewer', '/thepark/operator'],
      },
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  }
}

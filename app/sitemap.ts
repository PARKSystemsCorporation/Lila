import type { MetadataRoute } from 'next'

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://thepark.world'

const ROUTES = [
  '/',
  '/tokenomics',
  '/thepark',
  '/theyield',
  '/theyard',
  '/sports',
  '/help',
  '/subscribe',
  '/infoyard',
  '/handicappers',
  '/marketplace',
  '/bazaar',
  '/commodities',
  '/horse-racing',
  '/bounty',
]

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date()
  return ROUTES.map(route => ({
    url: `${SITE_URL}${route}`,
    lastModified,
  }))
}

// Same image as opengraph-image; Next requires literal exports here so
// we can't re-export. Reuse the JSX via a plain default-import.
import OpenGraphImage from './opengraph-image'

export const runtime = 'edge'
export const alt = 'The Park Casino — free-to-play sweepstakes with real crypto prize redemptions'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'

export default OpenGraphImage

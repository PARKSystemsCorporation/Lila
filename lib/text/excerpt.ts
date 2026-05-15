// Pull a plain-text excerpt out of a markdown body. Headings, code
// blocks, and inline formatting are stripped; whitespace is collapsed.
// Truncates on a word boundary and appends an ellipsis when the source
// exceeds `max`.

export function excerptOf(content: string, max = 250): string {
  const stripped = content
    .replace(/^#.+$/gm, '')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[*_`>#-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (stripped.length <= max) return stripped
  return stripped.slice(0, max).replace(/\s+\S*$/, '') + '…'
}

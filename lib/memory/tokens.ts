// POS-tagged tokenization, ported from PARKSystemsCorporation/2dkira server.js.
// Same STOPS set, same Penn-Treebank → POS-family mapping, same min-length and
// stop-word filtering. Falls back to a regex tokenizer if wink-pos-tagger is
// unavailable so the rest of the memory layer keeps working.

export interface Token {
  word: string
  pos:  string   // raw Penn Treebank tag (e.g. "NN", "JJ", "VBZ"); "" in fallback
  spos: string   // simplified family: 'noun' | 'adj' | 'verb' | 'adv' | 'other'
  idx:  number
}

export const STOPS: ReadonlySet<string> = new Set([
  'a','an','the','i','me','my','we','you',
  'he','she','it','they','is','are','was','were','be','been',
  'have','has','had','do','does','did','will','would','can','could',
  'and','but','or','if','of','to','in','for','on','with','at','by',
  'from','so','as','that','this','what','which','who','how','when',
  'where','why','all','each','some','any','no','not','just','also',
  'very','too','really','thing','things','way','even','like','get',
  'got','ok','yeah','yes','hey','hi','hello',
])

// Penn Treebank → simplified POS family.
const POS_FAMILY: Record<string, string> = {
  NN: 'noun', NNS: 'noun', NNP: 'noun', NNPS: 'noun',
  JJ: 'adj', JJR: 'adj', JJS: 'adj',
  VB: 'verb', VBD: 'verb', VBG: 'verb', VBN: 'verb', VBP: 'verb', VBZ: 'verb',
  RB: 'adv', RBR: 'adv', RBS: 'adv',
}

// Lazy-load wink-pos-tagger so the module doesn't crash on import when the
// dep is missing (e.g. CI without devDeps installed).
type Tagger = { tagSentence: (s: string) => Array<{ value: string; tag: string }> }
let cachedTagger: Tagger | null | undefined  // undefined = not tried, null = tried & unavailable
let warnedNoTagger = false

function getTagger(): Tagger | null {
  if (cachedTagger !== undefined) return cachedTagger
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('wink-pos-tagger') as () => Tagger
    cachedTagger = mod()
  } catch {
    cachedTagger = null
  }
  if (cachedTagger === null && !warnedNoTagger) {
    warnedNoTagger = true
    // One-shot stderr note. Don't reach for lila_log here — that would couple
    // the tokenizer to a DB pool and pull on cold-start cycles.
    if (typeof console !== 'undefined') {
      console.warn('[memory.tokens] wink-pos-tagger unavailable; using suffix-heuristic POS fallback')
    }
  }
  return cachedTagger
}

// Cheap suffix rules so the fallback path still produces sensible POS
// families. Without this, every fallback token gets 'noun', killing the
// noun+noun=0.3 cat-bonus distinctions and the adj/verb tiers.
function suffixPos(w: string): string {
  if (/(ing|ed|ize|ise|ate)$/.test(w)) return 'verb'
  if (/ly$/.test(w)) return 'adv'
  if (/(ous|ful|less|ive|able|al|ic)$/.test(w)) return 'adj'
  return 'noun'
}

export function tokenize(text: string): Token[] {
  const clean = String(text ?? '')
    .toLowerCase()
    .replace(/[^\w\s'-]/g, ' ')
    .trim()
  if (!clean) return []

  const tagger = getTagger()
  if (tagger) {
    const tagged = tagger.tagSentence(clean) ?? []
    return tagged
      .filter(t => t.value && !STOPS.has(t.value) && t.value.length >= 3)
      .map((t, i) => ({
        word: t.value,
        pos:  t.tag,
        spos: POS_FAMILY[t.tag] ?? 'noun',
        idx:  i,
      }))
  }

  return clean
    .split(/\s+/)
    .filter(w => w && !STOPS.has(w) && w.length >= 3)
    .map((w, i) => ({ word: w, pos: '', spos: suffixPos(w), idx: i }))
}

// Sorted pair key — same convention as 2dkira `[a.word, b.word].sort().join('_')`.
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('_')
}

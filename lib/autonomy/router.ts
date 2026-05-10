import type OpenAI from 'openai'
import { llmCall, LLMBudgetExceeded } from '../llm'
import { TREE, resolveLeaf, type LeafNode, type TimeGate, type TreeNode } from './tree'

// Combined-path router: one LLM call returns the full leaf path. Cheaper
// than per-level routing (saves 2 round-trips, ~$0.001).
//
//   pickPath(ctxText)  →  ['DESK','HELP-REQUESTS']
//
// Also exports gateAllows(gate, now) so the loop can filter children that
// shouldn't be reachable in the current TIME window.

export interface PickPathResult {
  path: string[]
  reason: string
  leaf: LeafNode | null
}

const ROUTER_PROMPT = `You are Lila's autonomy router. Pick the single best leaf in the decision tree below for THIS tick. Use the live context block to decide.

Tree (id, label, description; only LEAFs are valid endpoints):

{TREE_DESC}

Live context:
{CONTEXT}

Routing principles:
- if there is an unanswered operator message → LILA/OPERATOR/MESSAGE.
- if the inbound desk has a pending request matching a category, prefer the matching DESK leaf (CODE-REQUESTS / HELP-REQUESTS / WEB-POSTS).
- if there are approved-but-unreported desk items → AUTONOMY/AUTONOMY-DESK.
- if a teammate hasn't moved in a long time and you have a clear hint → LILA/TEAM/UPDATE.
- otherwise pick something that produces visible progress: bluesky, notes, or a directed solo task.

Respond with ONLY valid JSON — no markdown fences, no preamble:
{ "path": ["<id>", "<id>", ...], "reason": "<one short sentence>" }

Constraints:
- "path" is the ordered list of branch ids leading to a LEAF. Do not include "ROOT".
- the final element MUST be a leaf id.
- "reason" ≤ 120 chars.
`

function describeTree(): string {
  const lines: string[] = []
  function walk(n: TreeNode, depth: number, prefix: string) {
    const indent = '  '.repeat(depth)
    const tag = n.type === 'leaf' ? 'LEAF' : 'BRANCH'
    const path = prefix ? `${prefix}/${n.id}` : n.id
    lines.push(`${indent}- [${tag}] ${path} — ${n.description}`)
    if (n.type === 'branch') for (const c of n.children) walk(c, depth + 1, path === 'ROOT' ? '' : path)
  }
  for (const c of TREE.children) walk(c, 0, '')
  return lines.join('\n')
}

export function gateAllows(gate: TimeGate | undefined, now: Date): boolean {
  if (!gate || gate.kind === 'always') return true
  if (gate.kind === 'weekday_hours') {
    const day = now.getUTCDay()
    if (day === 0 || day === 6) return false
    const h = now.getUTCHours()
    return h >= gate.startUtc && h < gate.endUtc
  }
  if (gate.kind === 'market_open') {
    const day = now.getUTCDay()
    if (day === 0 || day === 6) return false
    const minutes = now.getUTCHours() * 60 + now.getUTCMinutes()
    // NYSE 13:30–20:00 UTC (9:30–16:00 ET, std time approximation)
    return minutes >= 13 * 60 + 30 && minutes <= 20 * 60
  }
  return true
}

export async function pickPath(ai: OpenAI, contextText: string): Promise<PickPathResult> {
  const prompt = ROUTER_PROMPT
    .replace('{TREE_DESC}', describeTree())
    .replace('{CONTEXT}', contextText)
  let raw = ''
  try {
    const r = await llmCall({
      ai,
      module: 'autonomy.route',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 180,
      temperature: 0.3,
    })
    raw = r.content
  } catch (e) {
    if (e instanceof LLMBudgetExceeded) throw e
    return { path: [], reason: `router error: ${String(e).slice(0, 80)}`, leaf: null }
  }
  let parsed: { path?: unknown; reason?: unknown }
  try { parsed = JSON.parse(raw) } catch { return { path: [], reason: `router parse fail: ${raw.slice(0, 80)}`, leaf: null } }
  const path = Array.isArray(parsed.path) ? parsed.path.map(String) : []
  const reason = typeof parsed.reason === 'string' ? parsed.reason.slice(0, 240) : ''
  const leaf = resolveLeaf(path)
  if (!leaf) return { path, reason: reason || 'unresolved leaf', leaf: null }
  return { path, reason, leaf }
}

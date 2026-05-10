// Hierarchical decision tree Lila navigates each tick. Three top-level
// branches per the operator's diagram:
//
//   DESK     — service operator inbox (direction='to_lila' desk_items)
//   AUTONOMY — Lila's self-directed work (file desk items, post Bluesky,
//              SOLO tools: notes / web browse / new dir / json edit)
//   LILA     — operator/team coordination (TIME-gated; OPERATOR
//              request|message, TEAM update|announce)
//
// At each branch the router asks DeepSeek which child to pick. At a leaf
// Lila is shown the leaf's tool list and produces a 10-step plan that
// persists in lila_tasks. One step executes per tick.

export type ToolName =
  | 'desk.read_inbox'
  | 'desk.file_to_operator'
  | 'desk.file_to_self'
  | 'desk.mark_done'
  | 'desk.process_approvals'
  | 'web.fetch'
  | 'notes.read'
  | 'notes.write'
  | 'notes.mkdir'
  | 'notes.json_edit'
  | 'team.update'
  | 'team.announce'
  | 'bluesky.compose'
  | 'operator.reply'
  | 'operator.request'
  | 'code.read_file'
  | 'code.read_diff'
  | 'code.propose_edit'
  | 'code.run_tests'

// TimeGate is evaluated against the current UTC time + season helpers.
// 'always' is the default. 'market_open' uses lib/season.ts. 'weekday_hours'
// keeps a leaf reachable only inside an explicit UTC window M–F.
export type TimeGate =
  | { kind: 'always' }
  | { kind: 'market_open' }
  | { kind: 'weekday_hours'; startUtc: number; endUtc: number }

export interface BranchNode {
  type: 'branch'
  id: string
  label: string
  description: string
  gate?: TimeGate
  children: TreeNode[]
}

export interface LeafNode {
  type: 'leaf'
  id: string
  label: string
  description: string
  gate?: TimeGate
  tools: ToolName[]
  promptTemplate: string  // {CONTEXT} placeholder; tool list appended by router
}

export type TreeNode = BranchNode | LeafNode

// Shared template for plan-gen prompts. The router wraps each leaf's
// promptTemplate with this so the LLM always knows the exact JSON shape
// to return and the tool whitelist.
export const PLAN_FORMAT_INSTRUCTIONS = `
Respond with ONLY valid JSON — no preamble, no markdown fences:
{
  "plan": [
    { "step_no": 1, "description": "<imperative, <=80 chars>", "tool": "<exact tool name from the allowlist>", "args": { <tool-specific args> } },
    ... 10 steps total
  ]
}

Rules:
- exactly 10 steps.
- each step's "tool" MUST be one of the allowed tools listed for this leaf.
- "args" is an object; shape depends on the tool. Keep args concise.
- do NOT invent tools, file paths, URLs, or symbols. If the context doesn't
  give you a real value, leave the arg as a clear placeholder string the
  operator could fill in (e.g. "<paste url>").
- step descriptions in lowercase imperative voice — Lila's brutalist
  punctuation is fine here.
`.trim()

export const TREE: BranchNode = {
  type: 'branch',
  id: 'ROOT',
  label: 'ROOT',
  description: 'Lila picks one of three top-level intents this tick.',
  children: [
    {
      type: 'branch',
      id: 'DESK',
      label: 'DESK',
      description:
        'Service the operator inbox. Pick this when there are unserviced ' +
        'requests in direction=to_lila (code-request / help-request / web-post).',
      children: [
        {
          type: 'leaf',
          id: 'CODE-REQUESTS',
          label: 'CODE-REQUESTS',
          description: 'Operator filed a code request. Read repo, propose an edit, file the diff back.',
          tools: ['code.read_file', 'code.read_diff', 'code.propose_edit', 'code.run_tests', 'desk.mark_done'],
          promptTemplate:
            'You are Lila. The operator filed a CODE-REQUEST. Produce a 10-step plan to ' +
            'investigate, propose, and file an edit back to the operator desk. v1: do NOT ' +
            'mutate code in-process — propose_edit files the diff for operator review.\n\n' +
            'Context:\n{CONTEXT}',
        },
        {
          type: 'leaf',
          id: 'HELP-REQUESTS',
          label: 'HELP-REQUESTS',
          description: 'Operator asked a question. Search notes, fetch a URL if needed, draft a reply.',
          tools: ['notes.read', 'web.fetch', 'operator.reply', 'team.update', 'desk.mark_done'],
          promptTemplate:
            'You are Lila. The operator filed a HELP-REQUEST. Produce a 10-step plan that ' +
            'gathers context (notes, maybe one web fetch, maybe one teammate ping), then ' +
            'replies to the operator and marks the desk item serviced.\n\n' +
            'Context:\n{CONTEXT}',
        },
        {
          type: 'leaf',
          id: 'WEB-POSTS',
          label: 'WEB-POSTS',
          description: 'Operator filed a URL. Fetch, summarize, file a desk item with the read.',
          tools: ['web.fetch', 'notes.write', 'desk.file_to_self', 'desk.mark_done'],
          promptTemplate:
            'You are Lila. The operator filed a WEB-POST request (a URL to read). Produce a ' +
            '10-step plan to fetch the page, save a note, and file a desk item with the read ' +
            'so the operator can scan it later.\n\n' +
            'Context:\n{CONTEXT}',
        },
      ],
    },
    {
      type: 'branch',
      id: 'AUTONOMY',
      label: 'AUTONOMY',
      description:
        'Self-directed work. Pick this when the inbox is empty and there is ' +
        'something Lila should publish or organize on her own.',
      children: [
        {
          type: 'leaf',
          id: 'AUTONOMY-DESK',
          label: 'AUTONOMY/DESK',
          description: "Process Lila's outbound desk items (legacy approvals path) or file a new memo.",
          tools: ['desk.process_approvals', 'desk.file_to_operator', 'desk.mark_done'],
          promptTemplate:
            'You are Lila. AUTONOMY/DESK leaf. Produce a 10-step plan that drains approved ' +
            'desk items (Lila reads + reports) and/or files at most one new pitch/memo to ' +
            'the operator. Most steps will be desk.process_approvals; only one or two file ' +
            'new content.\n\n' +
            'Context:\n{CONTEXT}',
        },
        {
          type: 'leaf',
          id: 'BLUESKY',
          label: 'AUTONOMY/BLUESKY',
          description: 'Compose a Bluesky post with title/category/content. Title and category are operator-UI metadata; only content publishes.',
          tools: ['notes.read', 'bluesky.compose'],
          promptTemplate:
            'You are Lila. AUTONOMY/BLUESKY leaf. Produce a 10-step plan to compose ONE ' +
            'Bluesky post. The first 5-8 steps gather context (notes, recent activity) and ' +
            'the final 1-2 steps call bluesky.compose with {title, category, content}. ' +
            'content must be ≤260 chars.\n\n' +
            'Context:\n{CONTEXT}',
        },
        {
          type: 'branch',
          id: 'SOLO',
          label: 'AUTONOMY/SOLO',
          description: 'File-system-style chores: notes, web browse, new directory, JSON edit.',
          children: [
            {
              type: 'leaf',
              id: 'SOLO-NOTES',
              label: 'AUTONOMY/SOLO/NOTES',
              description: 'Read or write a markdown note in analyst_notes.',
              tools: ['notes.read', 'notes.write'],
              promptTemplate:
                'You are Lila. SOLO/NOTES leaf. Produce a 10-step plan that reads existing ' +
                'notes (paths under lila/...), updates one or two of them, and writes a new ' +
                'one. Keep paths tidy: lila/plans/, lila/observations/, lila/team/.\n\n' +
                'Context:\n{CONTEXT}',
            },
            {
              type: 'leaf',
              id: 'SOLO-WEB-BROWSE',
              label: 'AUTONOMY/SOLO/WEB-BROWSE',
              description: 'Fetch one or two pages from the allowlist, save extracts as notes.',
              tools: ['web.fetch', 'notes.write'],
              promptTemplate:
                'You are Lila. SOLO/WEB-BROWSE leaf. Produce a 10-step plan that fetches one ' +
                'or two URLs from the allowlist (github.com / news.ycombinator.com / arxiv.org / ' +
                'wikipedia / raw.githubusercontent.com) and stores extracts under ' +
                'lila/web/{slug}.md. No more than 2 web.fetch calls.\n\n' +
                'Context:\n{CONTEXT}',
            },
            {
              type: 'leaf',
              id: 'SOLO-NEW-DIR',
              label: 'AUTONOMY/SOLO/NEW-DIR',
              description: 'Create a new analyst_notes path prefix (mkdir).',
              tools: ['notes.mkdir', 'notes.write'],
              promptTemplate:
                'You are Lila. SOLO/NEW-DIR leaf. Produce a 10-step plan that creates one ' +
                'new path prefix under lila/ (notes.mkdir) and seeds it with an index note ' +
                "explaining what goes there. Don't create more than 2 prefixes.\n\n" +
                'Context:\n{CONTEXT}',
            },
            {
              type: 'leaf',
              id: 'SOLO-JSON-EDIT',
              label: 'AUTONOMY/SOLO/JSON-EDIT',
              description: 'Edit a JSON-shaped note via shallow merge.',
              tools: ['notes.read', 'notes.json_edit'],
              promptTemplate:
                'You are Lila. SOLO/JSON-EDIT leaf. Produce a 10-step plan that reads a JSON ' +
                'note (e.g. lila/state/dashboard.json), shallow-merges updates, and writes ' +
                'it back. Touch at most 2 JSON notes.\n\n' +
                'Context:\n{CONTEXT}',
            },
          ],
        },
      ],
    },
    {
      type: 'branch',
      id: 'LILA',
      label: 'LILA',
      description:
        'Operator + team coordination. TIME-gated. Pick this when the operator ' +
        'has an unanswered message, when a team agent should be redirected, ' +
        'or when the team needs a synchronous announcement.',
      children: [
        {
          type: 'branch',
          id: 'OPERATOR',
          label: 'LILA/OPERATOR',
          description: 'Direct interaction with the operator.',
          children: [
            {
              type: 'leaf',
              id: 'OPERATOR-MESSAGE',
              label: 'LILA/OPERATOR/MESSAGE',
              description: 'Reply to the operator in chat (the existing replyToOperator path).',
              tools: ['operator.reply', 'notes.read'],
              promptTemplate:
                'You are Lila. LILA/OPERATOR/MESSAGE leaf. Produce a 10-step plan that gathers ' +
                'one or two context snippets (recent notes, team status) and ends with a single ' +
                'operator.reply call. Most steps are short context-gathering; only step 9 or 10 ' +
                'is the reply itself.\n\n' +
                'Context:\n{CONTEXT}',
            },
            {
              type: 'leaf',
              id: 'OPERATOR-REQUEST',
              label: 'LILA/OPERATOR/REQUEST',
              description: 'File a desk item back to the operator (a question, a memo, a pitch).',
              tools: ['operator.request', 'notes.read'],
              promptTemplate:
                'You are Lila. LILA/OPERATOR/REQUEST leaf. Produce a 10-step plan that drafts ' +
                'and files ONE desk item back to the operator (direction=to_operator). The ' +
                'final step is the operator.request call with {title, body, category, payload}.\n\n' +
                'Context:\n{CONTEXT}',
            },
          ],
        },
        {
          type: 'branch',
          id: 'TEAM',
          label: 'LILA/TEAM',
          description: 'Coordinate with Vega / Cipher / Ceelo.',
          children: [
            {
              type: 'leaf',
              id: 'TEAM-UPDATE',
              label: 'LILA/TEAM/UPDATE',
              description: 'Set NEXT-LOOP-PRIMARY for one teammate (vega|cipher|ceelo).',
              tools: ['team.update', 'notes.read'],
              promptTemplate:
                'You are Lila. LILA/TEAM/UPDATE leaf. Produce a 10-step plan that picks ONE ' +
                "teammate (vega/cipher/ceelo) and sets their next-loop-primary goal — a single " +
                "{goal, hint?} blob the teammate's loop will read at the top of its next " +
                'iteration and clear. Final step is the team.update call.\n\n' +
                'Context:\n{CONTEXT}',
            },
            {
              type: 'leaf',
              id: 'TEAM-ANNOUNCEMENT',
              label: 'LILA/TEAM/ANNOUNCEMENT',
              description: 'Set NEXT-LOOP-PRIMARY for ALL teammates (broadcast).',
              tools: ['team.announce', 'notes.read'],
              promptTemplate:
                'You are Lila. LILA/TEAM/ANNOUNCEMENT leaf. Produce a 10-step plan that ends ' +
                'with one team.announce call setting next-loop-primary on every teammate. Use ' +
                'sparingly — this nudges Vega, Cipher and Ceelo all at once.\n\n' +
                'Context:\n{CONTEXT}',
            },
          ],
        },
      ],
    },
  ],
}

// Walk the tree and resolve a leaf path like ['DESK','HELP-REQUESTS'].
export function resolveLeaf(path: string[]): LeafNode | null {
  let node: TreeNode = TREE
  for (const id of path) {
    if (node.type !== 'branch') return null
    const next: TreeNode | undefined = node.children.find((c: TreeNode) => c.id === id)
    if (!next) return null
    node = next
  }
  return node.type === 'leaf' ? node : null
}

// Flatten every reachable leaf for debugging / list-rendering.
export function allLeafPaths(): string[][] {
  const out: string[][] = []
  const walk = (n: TreeNode, acc: string[]) => {
    if (n.type === 'leaf') { out.push(acc.concat(n.id)); return }
    for (const c of n.children) walk(c, acc.concat(n.id))
  }
  walk(TREE, [])
  return out.map(p => p.slice(1))  // drop ROOT
}

import type { PoolClient } from 'pg'

// ── GitHub PR submitter ──────────────────────────────────────────────────
//
// Picks one approved bounty_picks row per call and turns it into a real
// pull request on the issue's upstream repo, opened from the Parks
// GitHub account's fork.
//
// Gated on:
//   - GITHUB_TOKEN     PAT with 'repo' scope on the company account
//   - LILA_AUTO_SUBMIT 'true' to actually open PRs (default OFF)
//
// When GITHUB_TOKEN is set but LILA_AUTO_SUBMIT is not 'true', this file
// is a no-op — drafts stay in 'approved' state and Telegram alerts ping
// the operator to copy the draft manually. Flip the env to 'true' on
// Railway to go fully autonomous.
//
// Flow per row:
//   1. Resolve bot username from the token.
//   2. Fork upstream (idempotent — GitHub returns the fork if it exists).
//   3. Sync fork's default branch to upstream HEAD.
//   4. Create a fresh branch on the fork: lila-bounty-<external_id>.
//   5. Parse the unified diff Scout produced; apply hunks file-by-file
//      against upstream HEAD content via the Contents API.
//   6. Open the PR upstream from <bot>:<branch>.
//   7. Stamp bounty_picks: status='submitted', pr_url, pr_number.

const SUBMIT_TIMEOUT_MS = 30_000
const FORK_READY_TIMEOUT_MS = 30_000
const FORK_POLL_MS = 1_500

export interface SubmitResult {
  ran: boolean
  submitted: number
  failed: number
  logMessage: string
  logType: 'info' | 'success' | 'warn'
}

interface ApprovedRow {
  id: number
  source: string
  external_id: string
  url: string
  title: string
  repo_url: string
  issue_number: number | null
  draft_title: string
  draft_body: string
  draft_diff: string | null
  payout_usd: string | null
  payout_token: string | null
}

export function isAutoSubmitEnabled(): boolean {
  if (!process.env.GITHUB_TOKEN) return false
  const v = (process.env.LILA_AUTO_SUBMIT ?? '').toLowerCase().trim()
  return v === 'true' || v === '1' || v === 'yes'
}

export async function runSubmitter(db: PoolClient): Promise<SubmitResult | null> {
  if (!isAutoSubmitEnabled()) return null

  // One per tick: pick the oldest approved row that hasn't been submitted.
  const { rows } = await db.query(
    `SELECT id, source, external_id, url, title, repo_url, issue_number,
            draft_title, draft_body, draft_diff, payout_usd, payout_token
       FROM bounty_picks
      WHERE status='approved' AND pr_url IS NULL
      ORDER BY reviewed_at ASC NULLS FIRST
      LIMIT 1`
  )
  if (!rows.length) return null
  const row = rows[0] as ApprovedRow

  try {
    const result = await submitOne(row)
    await db.query(
      `UPDATE bounty_picks
         SET status='submitted', pr_url=$1, pr_number=$2, submitted_at=NOW(),
             submit_error=NULL, updated_at=NOW()
       WHERE id=$3`,
      [result.prUrl, result.prNumber, row.id]
    )
    return {
      ran: true, submitted: 1, failed: 0,
      logMessage: `Submitter: opened PR #${result.prNumber} for "${row.draft_title.slice(0, 60)}" → ${result.prUrl}`,
      logType: 'success',
    }
  } catch (e) {
    const errMsg = String((e as Error).message ?? e).slice(0, 500)
    await db.query(
      `UPDATE bounty_picks
         SET submit_error=$1, updated_at=NOW()
       WHERE id=$2`,
      [errMsg, row.id]
    )
    // Stays in 'approved' state — operator can decide to retry, edit, or
    // mark as 'rejected' from the UI. Repeated failures here suggest a
    // malformed diff or an upstream branch protection.
    return {
      ran: true, submitted: 0, failed: 1,
      logMessage: `Submitter failed for "${row.draft_title.slice(0, 60)}": ${errMsg.slice(0, 120)}`,
      logType: 'warn',
    }
  }
}

// ── one-shot submission ────────────────────────────────────────────────

interface SubmitOk { prUrl: string; prNumber: number }

async function submitOne(row: ApprovedRow): Promise<SubmitOk> {
  const { owner, repo } = parseRepo(row.repo_url)
  if (!owner || !repo) throw new Error('Could not parse owner/repo from repo_url')

  // 1. Resolve bot username.
  const me = await gh<{ login: string }>('GET', '/user')
  const botUser = me.login

  // 2. Resolve upstream default branch.
  const upstream = await gh<{ default_branch: string }>('GET', `/repos/${owner}/${repo}`)
  const baseBranch = upstream.default_branch

  // 3. Fork (idempotent). Wait until fork is queryable.
  await gh('POST', `/repos/${owner}/${repo}/forks`).catch(() => null)
  await waitForFork(botUser, repo)

  // 4. Sync fork to upstream HEAD (best-effort).
  await gh('POST', `/repos/${botUser}/${repo}/merge-upstream`, {
    body: { branch: baseBranch },
  }).catch(() => null)

  // 5. Get upstream HEAD SHA so we can branch at the same commit on the fork.
  const baseRef = await gh<{ object: { sha: string } }>(
    'GET', `/repos/${owner}/${repo}/git/refs/heads/${baseBranch}`
  )
  const baseSha = baseRef.object.sha

  // 6. Create the working branch on the fork (delete-and-recreate if it exists).
  const branch = `lila-bounty-${row.source}-${row.external_id}`.replace(/[^a-zA-Z0-9_\-./]/g, '-').slice(0, 80)
  await gh('DELETE', `/repos/${botUser}/${repo}/git/refs/heads/${branch}`).catch(() => null)
  await gh('POST', `/repos/${botUser}/${repo}/git/refs`, {
    body: { ref: `refs/heads/${branch}`, sha: baseSha },
  })

  // 7. Apply the diff: parse → for each file, fetch upstream content,
  //    apply hunks, PUT new content on the fork branch.
  if (!row.draft_diff || !row.draft_diff.trim()) {
    throw new Error('Approved draft has no diff to apply.')
  }
  const files = parseUnifiedDiff(row.draft_diff)
  if (files.length === 0) throw new Error('Diff parsed to zero files (malformed?).')

  let touched = 0
  for (const f of files) {
    const apply = await applyOneFile({
      upstream: { owner, repo },
      fork: { owner: botUser, repo },
      baseBranch,
      branch,
      file: f,
      commitMessage: `${row.draft_title.slice(0, 60)}\n\nLila autonomous submission for ${row.source} bounty #${row.external_id}.`,
    })
    if (apply.skipped) continue
    touched++
  }
  if (touched === 0) throw new Error('Diff applied to zero files — every patch failed.')

  // 8. Open the PR.
  const pr = await gh<{ number: number; html_url: string }>('POST', `/repos/${owner}/${repo}/pulls`, {
    body: {
      title: row.draft_title.slice(0, 200),
      head:  `${botUser}:${branch}`,
      base:  baseBranch,
      body:  buildPrBody(row),
      maintainer_can_modify: true,
      draft: false,
    },
  })

  return { prUrl: pr.html_url, prNumber: pr.number }
}

function buildPrBody(row: ApprovedRow): string {
  const parts: string[] = []
  parts.push(row.draft_body.trim())
  if (row.issue_number) {
    // Make sure the close-link is present even if Scout omitted it.
    if (!row.draft_body.toLowerCase().includes(`closes #${row.issue_number}`) &&
        !row.draft_body.toLowerCase().includes(`fixes #${row.issue_number}`)) {
      parts.push(`\nCloses #${row.issue_number}`)
    }
  }
  parts.push(`\n---\n*Submitted via Lila — ${row.source} bounty automation.*`)
  return parts.join('\n').slice(0, 60_000)
}

// ── fork readiness ─────────────────────────────────────────────────────

async function waitForFork(user: string, repo: string): Promise<void> {
  const deadline = Date.now() + FORK_READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await gh('GET', `/repos/${user}/${repo}`)
      return
    } catch { /* keep polling */ }
    await sleep(FORK_POLL_MS)
  }
  throw new Error(`Fork ${user}/${repo} did not become ready within ${FORK_READY_TIMEOUT_MS}ms`)
}

// ── apply one file ─────────────────────────────────────────────────────

interface ApplyOpts {
  upstream: { owner: string; repo: string }
  fork:     { owner: string; repo: string }
  baseBranch: string
  branch: string
  file: ParsedFile
  commitMessage: string
}

interface ApplyResult { skipped: boolean }

async function applyOneFile(opts: ApplyOpts): Promise<ApplyResult> {
  const { file } = opts
  if (file.binary) return { skipped: true }
  if (file.deleted) {
    // Deletion via Contents API requires the current sha + DELETE.
    const current = await getContent(opts.upstream.owner, opts.upstream.repo, file.path, opts.baseBranch).catch(() => null)
    if (!current) return { skipped: true }
    await gh('DELETE', `/repos/${opts.fork.owner}/${opts.fork.repo}/contents/${encodeURI(file.path)}`, {
      body: {
        message: opts.commitMessage,
        sha:     current.sha,
        branch:  opts.branch,
      },
    })
    return { skipped: false }
  }

  // New or modified file.
  let originalContent = ''
  let originalSha: string | null = null
  if (!file.isNew) {
    const current = await getContent(opts.upstream.owner, opts.upstream.repo, file.path, opts.baseBranch)
    originalContent = b64decode(current.content)
    originalSha = current.sha
  }

  const newContent = applyHunks(originalContent, file.hunks)
  await gh('PUT', `/repos/${opts.fork.owner}/${opts.fork.repo}/contents/${encodeURI(file.path)}`, {
    body: {
      message: opts.commitMessage,
      content: b64encode(newContent),
      branch:  opts.branch,
      ...(originalSha ? { sha: originalSha } : {}),
    },
  })
  return { skipped: false }
}

interface GhContent { sha: string; content: string; encoding: string }

async function getContent(owner: string, repo: string, path: string, ref: string): Promise<GhContent> {
  return gh<GhContent>('GET', `/repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`)
}

// ── unified diff parsing & application ────────────────────────────────

interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: { type: ' ' | '+' | '-'; text: string }[]
}
interface ParsedFile {
  path: string
  isNew: boolean
  deleted: boolean
  binary: boolean
  hunks: Hunk[]
}

export function parseUnifiedDiff(diff: string): ParsedFile[] {
  const files: ParsedFile[] = []
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  let cur: ParsedFile | null = null
  let curHunk: Hunk | null = null
  let oldPath = ''
  let newPath = ''

  const finalize = () => {
    if (cur) {
      if (curHunk) cur.hunks.push(curHunk)
      // Resolve path: prefer newPath unless deleted.
      cur.path = cur.deleted ? oldPath : (newPath || oldPath)
      if (cur.path) files.push(cur)
    }
    cur = null
    curHunk = null
    oldPath = ''
    newPath = ''
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('diff --git ')) {
      finalize()
      cur = { path: '', isNew: false, deleted: false, binary: false, hunks: [] }
      // diff --git a/path b/path — paths can have spaces; trust the --- / +++ lines below.
      continue
    }
    if (!cur) continue

    if (line.startsWith('Binary files')) { cur.binary = true; continue }
    if (line.startsWith('new file mode')) { cur.isNew = true; continue }
    if (line.startsWith('deleted file mode')) { cur.deleted = true; continue }
    if (line.startsWith('index ')) continue
    if (line.startsWith('--- ')) {
      const p = line.slice(4).trim()
      oldPath = p === '/dev/null' ? '' : stripPrefix(p, 'a/')
      if (!oldPath) cur.isNew = true
      continue
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      newPath = p === '/dev/null' ? '' : stripPrefix(p, 'b/')
      if (!newPath) cur.deleted = true
      continue
    }
    if (line.startsWith('@@')) {
      if (curHunk) cur.hunks.push(curHunk)
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!m) { curHunk = null; continue }
      curHunk = {
        oldStart: parseInt(m[1], 10),
        oldCount: m[2] ? parseInt(m[2], 10) : 1,
        newStart: parseInt(m[3], 10),
        newCount: m[4] ? parseInt(m[4], 10) : 1,
        lines: [],
      }
      continue
    }
    if (!curHunk) continue
    if (line.startsWith('\\ No newline at end of file')) continue

    const c = line.charAt(0)
    if (c === ' ' || c === '+' || c === '-') {
      curHunk.lines.push({ type: c as ' ' | '+' | '-', text: line.slice(1) })
    }
  }
  finalize()
  return files
}

function stripPrefix(s: string, p: string): string { return s.startsWith(p) ? s.slice(p.length) : s }

export function applyHunks(original: string, hunks: Hunk[]): string {
  if (hunks.length === 0) return original

  // Track \n vs \r\n / trailing-newline preservation.
  const hadTrailingNewline = original.endsWith('\n')
  const lines = original === '' ? [] : original.split('\n')
  if (hadTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  // Apply in reverse so earlier line numbers stay valid.
  const sorted = [...hunks].sort((a, b) => b.oldStart - a.oldStart)
  for (const h of sorted) {
    const oldLines = h.lines.filter(l => l.type !== '+').map(l => l.text)
    const newLines = h.lines.filter(l => l.type !== '-').map(l => l.text)

    if (h.oldStart === 0 && oldLines.length === 0) {
      // Patch against a new file — splice newLines at position 0.
      lines.splice(0, 0, ...newLines)
      continue
    }

    const startIdx = h.oldStart - 1
    const slice = lines.slice(startIdx, startIdx + oldLines.length)
    if (slice.join('\n') !== oldLines.join('\n')) {
      // Best-effort fallback: fuzzy-find the hunk's context within ±20 lines.
      const fuzzy = findContext(lines, oldLines, startIdx, 20)
      if (fuzzy === -1) {
        throw new Error(`Hunk failed to apply at line ${h.oldStart} (context mismatch)`)
      }
      lines.splice(fuzzy, oldLines.length, ...newLines)
      continue
    }
    lines.splice(startIdx, oldLines.length, ...newLines)
  }

  return lines.join('\n') + (hadTrailingNewline || lines.length > 0 ? '\n' : '')
}

function findContext(haystack: string[], needle: string[], around: number, radius: number): number {
  if (needle.length === 0) return -1
  for (let d = 0; d <= radius; d++) {
    for (const sign of d === 0 ? [0] : [-1, 1]) {
      const i = around + sign * d
      if (i < 0 || i + needle.length > haystack.length) continue
      let ok = true
      for (let k = 0; k < needle.length; k++) {
        if (haystack[i + k] !== needle[k]) { ok = false; break }
      }
      if (ok) return i
    }
  }
  return -1
}

// ── GitHub API client ─────────────────────────────────────────────────

interface GhOpts { body?: unknown }

async function gh<T = unknown>(method: string, path: string, opts: GhOpts = {}): Promise<T> {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('GITHUB_TOKEN not configured')
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'Lila/Scout (PR auto-submit)',
      ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(SUBMIT_TIMEOUT_MS),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// ── helpers ───────────────────────────────────────────────────────────

function parseRepo(url: string | null): { owner: string; repo: string } {
  if (!url) return { owner: '', repo: '' }
  const m = url.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/)
  if (!m) return { owner: '', repo: '' }
  return { owner: m[1], repo: m[2] }
}

function b64encode(s: string): string {
  return Buffer.from(s, 'utf-8').toString('base64')
}
function b64decode(s: string): string {
  return Buffer.from(s.replace(/\s/g, ''), 'base64').toString('utf-8')
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

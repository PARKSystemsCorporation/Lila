import type { PoolClient } from 'pg'
import type { ToolName } from './tree'
import * as desk from './tools/desk'
import * as web from './tools/web'
import * as notes from './tools/notes'
import * as team from './tools/team'
import * as bluesky from './tools/bluesky'
import * as operator from './tools/operator'
import * as code from './tools/code'

// Single dispatch surface. The AutonomyLoop calls dispatch(db, tool, args)
// for each step; the result's logMessage gets persisted on the lila_tasks
// row so the operator can scan what each step did.

export interface DispatchResult {
  ok: boolean
  logMessage: string
  data?: unknown
}

type Args = Record<string, unknown>

function s(a: Args, k: string): string { const v = a[k]; return typeof v === 'string' ? v : '' }
function n(a: Args, k: string): number | undefined { const v = a[k]; return typeof v === 'number' ? v : undefined }
function obj(a: Args, k: string): Record<string, unknown> { const v = a[k]; return (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {} }

export async function dispatch(db: PoolClient, tool: ToolName, args: Args): Promise<DispatchResult> {
  try {
    switch (tool) {
      case 'desk.read_inbox': {
        const r = await desk.readInbox(db, { category: s(args, 'category') || undefined, limit: n(args, 'limit') })
        return { ok: true, logMessage: r.logMessage, data: r.items }
      }
      case 'desk.file_to_operator': {
        const r = await desk.fileToOperator(db, {
          title: s(args, 'title'),
          body: s(args, 'body'),
          summary: s(args, 'summary') || undefined,
          category: s(args, 'category') || undefined,
          payload: args.payload,
        })
        return { ok: r.id != null, logMessage: r.logMessage, data: { id: r.id } }
      }
      case 'desk.file_to_self': {
        const target = s(args, 'to_agent').toLowerCase()
        const r = await desk.fileToSelf(db, {
          title: s(args, 'title'),
          body: s(args, 'body'),
          summary: s(args, 'summary') || undefined,
          category: s(args, 'category') || undefined,
          payload: args.payload,
          to_agent: (target === 'vega' || target === 'cipher' || target === 'scout' || target === 'ceelo') ? target : undefined,
        })
        return { ok: r.id != null, logMessage: r.logMessage, data: { id: r.id } }
      }
      case 'desk.mark_done': {
        const r = await desk.markDone(db, { id: Number(args.id) || 0, report: s(args, 'report') })
        return { ok: true, logMessage: r.logMessage }
      }
      case 'desk.process_approvals': {
        const r = await desk.processApprovals(db)
        return { ok: true, logMessage: r.logMessage }
      }

      case 'web.fetch': {
        const r = await web.fetchUrl({ url: s(args, 'url') })
        return { ok: r.ok, logMessage: r.logMessage, data: { url: r.url, title: r.title, text: r.text, status: r.status } }
      }

      case 'notes.read': {
        const r = await notes.read(db, { path: s(args, 'path') })
        return { ok: true, logMessage: r.logMessage, data: { path: r.path, content: r.content } }
      }
      case 'notes.write': {
        const r = await notes.write(db, { path: s(args, 'path'), content: s(args, 'content') })
        return { ok: true, logMessage: r.logMessage, data: { path: r.path } }
      }
      case 'notes.mkdir': {
        const r = await notes.mkdir(db, { prefix: s(args, 'prefix') })
        return { ok: true, logMessage: r.logMessage, data: { prefix: r.prefix } }
      }
      case 'notes.json_edit': {
        const r = await notes.jsonEdit(db, { path: s(args, 'path'), patch: obj(args, 'patch') })
        return { ok: true, logMessage: r.logMessage, data: { path: r.path } }
      }

      case 'team.update': {
        const r = await team.update(db, {
          target: s(args, 'target'),
          goal: s(args, 'goal'),
          hint: s(args, 'hint') || undefined,
          deadline_at: s(args, 'deadline_at') || undefined,
          note: s(args, 'note') || undefined,
        })
        return { ok: true, logMessage: r.logMessage }
      }
      case 'team.announce': {
        const r = await team.announce(db, {
          goal: s(args, 'goal'),
          hint: s(args, 'hint') || undefined,
          deadline_at: s(args, 'deadline_at') || undefined,
          note: s(args, 'note') || undefined,
        })
        return { ok: true, logMessage: r.logMessage }
      }

      case 'bluesky.compose': {
        const r = await bluesky.compose(db, {
          title: s(args, 'title') || undefined,
          category: s(args, 'category') || undefined,
          content: s(args, 'content'),
          scheduled_minutes: n(args, 'scheduled_minutes'),
        })
        return { ok: r.id != null, logMessage: r.logMessage, data: { id: r.id } }
      }

      case 'operator.reply': {
        const r = await operator.reply(db, { text: s(args, 'text') })
        return { ok: true, logMessage: r.logMessage }
      }
      case 'operator.request': {
        const r = await operator.request(db, {
          title: s(args, 'title'),
          body: s(args, 'body'),
          summary: s(args, 'summary') || undefined,
          category: s(args, 'category') || undefined,
          payload: args.payload,
        })
        return { ok: r.id != null, logMessage: r.logMessage, data: { id: r.id } }
      }

      case 'code.read_file': {
        const r = await code.readFile({ path: s(args, 'path') })
        return { ok: r.content != null, logMessage: r.logMessage, data: { path: r.path, content: r.content } }
      }
      case 'code.read_diff': {
        const r = await code.readDiff({ ref_a: s(args, 'ref_a') || undefined, ref_b: s(args, 'ref_b') || undefined, path: s(args, 'path') || undefined })
        return { ok: true, logMessage: r.logMessage, data: { diff: r.diff } }
      }
      case 'code.propose_edit': {
        // The LLM's plan typically follows propose_edit with desk.file_to_operator;
        // we materialize the proposal payload so the next step can pick it up
        // from the previous step's `data` (caller threads it). Returns a
        // ready-to-file desk payload so a single step can also be enough.
        const proposal = await code.proposeEdit({
          repo_path: s(args, 'repo_path'),
          rationale: s(args, 'rationale'),
          diff: s(args, 'diff') || undefined,
        })
        // Auto-file by default — the leaf prompt expects the proposal to
        // surface as a desk request so the operator sees it.
        const filed = await desk.fileToOperator(db, {
          title: proposal.title,
          body: proposal.body,
          category: proposal.category,
          payload: proposal.payload,
          kind: 'pitch',
        })
        return {
          ok: filed.id != null,
          logMessage: `${proposal.logMessage} → ${filed.logMessage}`,
          data: { desk_id: filed.id, proposal },
        }
      }
      case 'code.run_tests': {
        const r = await code.runTests({ scope: s(args, 'scope') || undefined })
        return { ok: r.ok, logMessage: r.logMessage, data: { stdout: r.stdout.slice(-1_000), stderr: r.stderr.slice(-500) } }
      }

      default: {
        const _exhaustive: never = tool
        return { ok: false, logMessage: `unknown tool: ${String(_exhaustive)}` }
      }
    }
  } catch (e) {
    return { ok: false, logMessage: `dispatch ${tool} error: ${String(e).slice(0, 160)}` }
  }
}

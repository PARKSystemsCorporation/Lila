import { spawn } from 'child_process'
import * as path from 'path'
import { cfg } from '../../config'

// Read-only-by-default code tools. v1: Lila does NOT mutate code in-process.
// 'propose_edit' files a desk item to the operator with the proposed diff
// in the body; 'run_tests' is gated behind LILA_RUN_TESTS=true.

const REPO_ROOT = process.cwd()

function inRepo(p: string): string | null {
  // Reject absolute paths and traversal outside REPO_ROOT.
  if (!p) return null
  if (p.startsWith('/')) return null
  const abs = path.resolve(REPO_ROOT, p)
  if (!abs.startsWith(REPO_ROOT + path.sep) && abs !== REPO_ROOT) return null
  return abs
}

function runGit(args: string[], timeoutMs = 5_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('git', args, { cwd: REPO_ROOT })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        resolve({ ok: false, stdout, stderr: stderr + '\n[timeout]' })
      }
    }, timeoutMs)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: code === 0, stdout, stderr })
      }
    })
    child.on('error', e => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve({ ok: false, stdout, stderr: stderr + '\n' + String(e) })
      }
    })
  })
}

export async function readFile(args: { path: string }): Promise<{ path: string; content: string | null; logMessage: string }> {
  const safe = inRepo(String(args.path ?? ''))
  if (!safe) return { path: String(args.path), content: null, logMessage: `code.read_file: invalid path "${args.path}"` }
  if (cfg.LILA_DRY_RUN) {
    return { path: safe, content: '[dry-run]', logMessage: `[dry-run] code.read_file ${args.path}` }
  }
  const r = await runGit(['show', `HEAD:${args.path}`])
  if (!r.ok) {
    return { path: safe, content: null, logMessage: `code.read_file ${args.path}: not in HEAD (${r.stderr.slice(0, 80)})` }
  }
  return { path: safe, content: r.stdout.slice(0, 16_000), logMessage: `code.read_file ${args.path} (${r.stdout.length}B)` }
}

export async function readDiff(args: { ref_a?: string; ref_b?: string; path?: string }): Promise<{ diff: string; logMessage: string }> {
  const a = String(args.ref_a ?? 'HEAD~1').slice(0, 100)
  const b = String(args.ref_b ?? 'HEAD').slice(0, 100)
  const gitArgs = ['diff', '--no-color', `${a}..${b}`]
  if (args.path) {
    const safe = inRepo(String(args.path))
    if (!safe) return { diff: '', logMessage: `code.read_diff: invalid path "${args.path}"` }
    gitArgs.push('--', args.path)
  }
  if (cfg.LILA_DRY_RUN) {
    return { diff: '[dry-run]', logMessage: `[dry-run] code.read_diff ${a}..${b}` }
  }
  const r = await runGit(gitArgs, 8_000)
  return { diff: r.stdout.slice(0, 16_000), logMessage: `code.read_diff ${a}..${b} (${r.stdout.length}B)` }
}

// v1: NEVER writes to disk. Returns the proposed body so the calling step
// can hand it to desk.file_to_operator. The branch_path payload should
// include {repo_path, instruction, diff} so the operator sees the full
// context.
export async function proposeEdit(args: { repo_path: string; rationale: string; diff?: string }): Promise<{
  title: string
  body: string
  category: string
  payload: { repo_path: string; rationale: string; diff?: string }
  logMessage: string
}> {
  const repo_path = String(args.repo_path ?? '').slice(0, 240)
  const rationale = String(args.rationale ?? '').slice(0, 4_000)
  const diff = args.diff ? String(args.diff).slice(0, 8_000) : undefined
  return {
    title: `Proposed edit: ${repo_path || '(no path)'}`,
    body: [
      `**Path:** \`${repo_path || '(missing)'}\``,
      ``,
      `**Rationale:**`,
      rationale || '(none provided)',
      diff ? `\n**Diff:**\n\`\`\`diff\n${diff}\n\`\`\`` : '',
    ].join('\n'),
    category: 'code-request',
    payload: { repo_path, rationale, ...(diff ? { diff } : {}) },
    logMessage: `code.propose_edit ${repo_path} (${rationale.length}B rationale)`,
  }
}

// Gated. By default returns a desk-request payload describing what would
// be run; only when LILA_RUN_TESTS=true do we actually shell out.
export async function runTests(args: { scope?: string }): Promise<{ ok: boolean; stdout: string; stderr: string; logMessage: string }> {
  const scope = String(args.scope ?? '').trim().slice(0, 120)
  if (!cfg.LILA_RUN_TESTS) {
    return {
      ok: false, stdout: '', stderr: '',
      logMessage: `code.run_tests skipped (LILA_RUN_TESTS=false) — would have run "${scope || 'default'}"`,
    }
  }
  if (cfg.LILA_DRY_RUN) {
    return { ok: true, stdout: '[dry-run]', stderr: '', logMessage: `[dry-run] code.run_tests ${scope}` }
  }
  // Intentionally limited surface: invoke `npm test` only. Operators can
  // narrow scope via env.
  const r = await runGit(['rev-parse', '--show-toplevel'], 2_000)
  if (!r.ok) return { ok: false, stdout: r.stdout, stderr: r.stderr, logMessage: 'code.run_tests: not a git repo?' }
  return await new Promise(resolve => {
    const child = spawn('npm', ['test', '--silent'], { cwd: REPO_ROOT })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* ignore */ } }, 120_000)
    child.stdout.on('data', d => { stdout += d.toString() })
    child.stderr.on('data', d => { stderr += d.toString() })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        stdout: stdout.slice(-4_000),
        stderr: stderr.slice(-2_000),
        logMessage: `code.run_tests exit=${code}`,
      })
    })
    child.on('error', e => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: stderr + '\n' + String(e), logMessage: `code.run_tests error: ${String(e).slice(0, 80)}` })
    })
  })
}

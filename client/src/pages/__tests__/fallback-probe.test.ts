import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { MODEL_TEST_GAP_MS, sleep, type ModelTestState } from '../../lib/model-test'

// Contract tests for the FallbackPage live probe (#1150). probeOne /
// handleTestAll are inline in the component (not exported), so this file
// mirrors their exact branching in a small harness AND pins the production
// source shape, so a regression in either place fails loudly:
//
//   FallbackPage.tsx lines referenced below: probeOne (result mapping +
//   AbortError branch), handleTestAll (visible+enabled + dedup + gap +
//   stop toggle), isTestingAny double-click guard.

const here = path.dirname(fileURLToPath(import.meta.url))
const page = readFileSync(path.join(here, '../FallbackPage.tsx'), 'utf8')

type Member = { modelDbId: number; enabled: boolean }
type Group = { key: string; members: Member[] }

// ── Mirror of FallbackPage.probeOne result mapping ──
function toStateFromResponse(res: any): ModelTestState {
  if (res && typeof res.ok === 'boolean') {
    if (res.ok) return { status: 'ok', latencyMs: res.latencyMs, replyPreview: res.replyPreview }
    return { status: 'error', error: res.error ?? 'empty_response', latencyMs: res.latencyMs, replyPreview: res.replyPreview }
  }
  return { status: 'ok', latencyMs: res?.latencyMs }
}

// ── Mirror of FallbackPage.probeOne (state transitions only) ──
async function probeOne(
  states: Map<number, ModelTestState>,
  modelDbId: number,
  fetcher: (id: number, signal?: AbortSignal) => Promise<any>,
  signal?: AbortSignal,
): Promise<void> {
  states.set(modelDbId, { status: 'testing' })
  try {
    const res = await fetcher(modelDbId, signal)
    states.set(modelDbId, toStateFromResponse(res))
  } catch (e: any) {
    if (e?.name === 'AbortError' || signal?.aborted) {
      if (states.get(modelDbId)?.status === 'testing') states.delete(modelDbId)
      return
    }
    states.set(modelDbId, { status: 'error', error: e?.message ?? 'failed' })
  }
}

// ── Mirror of FallbackPage.handleTestAll id selection ──
function selectTestAllIds(visibleGroups: Group[]): number[] {
  const ids = visibleGroups.flatMap(g => g.members.filter(m => m.enabled).map(m => m.modelDbId))
  return [...new Set(ids)]
}

// ── Mirror of the stop-toggle spinner clear in handleTestAll ──
function clearTestingSpinners(prev: Map<number, ModelTestState>): Map<number, ModelTestState> {
  const n = new Map(prev)
  for (const [k, v] of n) if (v.status === 'testing') n.delete(k)
  return n
}

function isTestingAny(states: Map<number, ModelTestState>): boolean {
  return [...states.values()].some(s => s.status === 'testing')
}

// Abortable gap with the same shape as the page loop (setTimeout + abort listener).
function gap(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>(resolve => {
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })
}

describe('probeOne result mapping (a)', () => {
  it('{ok:true} maps to ok state with latency + preview', async () => {
    const states = new Map<number, ModelTestState>()
    await probeOne(states, 7, async () => ({ ok: true, latencyMs: 123, replyPreview: 'ok' }))
    expect(states.get(7)).toEqual({ status: 'ok', latencyMs: 123, replyPreview: 'ok' })
  })

  it('{ok:false} maps to error state with error + latency + preview', async () => {
    const states = new Map<number, ModelTestState>()
    await probeOne(states, 7, async () => ({ ok: false, error: 'empty_response', latencyMs: 50, replyPreview: '' }))
    const st = states.get(7)
    expect(st?.status).toBe('error')
    expect(st?.error).toBe('empty_response')
    expect(st?.latencyMs).toBe(50)
  })

  it('defaults a missing error to empty_response', async () => {
    const states = new Map<number, ModelTestState>()
    await probeOne(states, 7, async () => ({ ok: false, latencyMs: 9 }))
    expect(states.get(7)).toMatchObject({ status: 'error', error: 'empty_response' })
  })

  it('a thrown error maps to error state with the message', async () => {
    const states = new Map<number, ModelTestState>()
    await probeOne(states, 7, async () => { throw new Error('boom') })
    expect(states.get(7)).toEqual({ status: 'error', error: 'boom' })
  })

  it('an abort removes the testing spinner instead of writing an error', async () => {
    const states = new Map<number, ModelTestState>()
    const ac = new AbortController()
    const err = new DOMException('aborted', 'AbortError')
    await probeOne(states, 7, async () => { throw err }, ac.signal)
    expect(states.has(7)).toBe(false)
  })

  it('a thrown 401 upstream_error ApiError maps to error state (session stays intact per api rules)', async () => {
    const states = new Map<number, ModelTestState>()
    const apiErr = Object.assign(new Error('provider key rejected'), { status: 401, code: 'upstream_error' })
    await probeOne(states, 7, async () => { throw apiErr })
    expect(states.get(7)).toEqual({ status: 'error', error: 'provider key rejected' })
  })

  it('pins the mapping branches in FallbackPage source', () => {
    expect(page).toContain("if (res.ok) setTestState(modelDbId, { status: 'ok'")
    expect(page).toContain("setTestState(modelDbId, { status: 'error', error: res.error ?? 'empty_response'")
    expect(page).toContain("e?.name === 'AbortError'")
  })
})

describe('Test-All iterates visible+enabled only, deduped (b)', () => {
  const groups: Group[] = [
    { key: 'a', members: [{ modelDbId: 1, enabled: true }, { modelDbId: 2, enabled: false }] },
    { key: 'b', members: [{ modelDbId: 3, enabled: true }, { modelDbId: 1, enabled: true }] },
  ]

  it('excludes disabled members', () => {
    expect(selectTestAllIds(groups)).not.toContain(2)
  })

  it('excludes filtered-out groups (not in visibleGroups)', () => {
    expect(selectTestAllIds([groups[0]])).toEqual([1])
  })

  it('dedupes ids shared by several groups', () => {
    expect(selectTestAllIds(groups)).toEqual([1, 3])
  })

  it('returns empty when nothing visible+enabled is left', () => {
    expect(selectTestAllIds([{ key: 'x', members: [{ modelDbId: 9, enabled: false }] }])).toEqual([])
  })

  it('pins selection + dedup in FallbackPage source', () => {
    expect(page).toContain('g.members.filter(m => m.enabled).map(m => m.modelDbId)')
    expect(page).toContain('[...new Set(ids)]')
  })
})

describe('Stop aborts mid-gap and preserves finished results (c)', () => {
  it('the gap is abortable: aborting resolves well before MODEL_TEST_GAP_MS', async () => {
    expect(MODEL_TEST_GAP_MS).toBe(900)
    const ac = new AbortController()
    const start = Date.now()
    const p = gap(MODEL_TEST_GAP_MS, ac.signal)
    setTimeout(() => ac.abort(), 20)
    await p
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('stop-clear deletes testing spinners but keeps ok/error results', () => {
    const prev = new Map<number, ModelTestState>([
      [1, { status: 'ok', latencyMs: 100 }],
      [2, { status: 'testing' }],
      [3, { status: 'error', error: 'bad key' }],
    ])
    const next = clearTestingSpinners(prev)
    expect(next.get(1)).toMatchObject({ status: 'ok' })
    expect(next.get(3)).toMatchObject({ status: 'error' })
    expect(next.has(2)).toBe(false)
  })

  it('an aborted run never probes ids past the stop point', async () => {
    const probed: number[] = []
    const ac = new AbortController()
    const ids = [11, 22, 33]
    for (let i = 0; i < ids.length; i++) {
      if (ac.signal.aborted) break
      probed.push(ids[i])
      if (i < ids.length - 1 && !ac.signal.aborted) {
        const g = gap(60, ac.signal)
        if (i === 0) ac.abort() // Stop pressed during the first gap
        await g
      }
    }
    expect(probed).toEqual([11])
  })

  it('pins stop-toggle + testing-only delete in FallbackPage source', () => {
    expect(page).toContain('bulkAbortRef.current.abort()')
    expect(page).toContain("if (n.get(modelDbId)?.status === 'testing') n.delete(modelDbId)")
    expect(page).toContain("if (v.status === 'testing') n.delete(k)")
  })
})

describe('double-click Test-All cannot start duplicate runs (d)', () => {
  it('isTestingAny is true while any probe is in flight', () => {
    expect(isTestingAny(new Map([[1, { status: 'testing' }]]))).toBe(true)
    expect(isTestingAny(new Map([[1, { status: 'ok', latencyMs: 5 }]]))).toBe(false)
    expect(isTestingAny(new Map())).toBe(false)
  })

  it('a guarded single-probe entry refuses to start while testing', async () => {
    let calls = 0
    const states = new Map<number, ModelTestState>([[1, { status: 'testing' }]])
    const guardedTestMember = async () => {
      if (isTestingAny(states)) return
      calls++
    }
    await guardedTestMember()
    expect(calls).toBe(0)
  })

  it('a second Test-All while bulkAbortRef is set acts as Stop, not a new run', async () => {
    let runs = 0
    let bulk: AbortController | null = new AbortController()
    const handleTestAll = async () => {
      if (bulk) { bulk.abort(); bulk = null; return 'stopped' }
      runs++
      return 'started'
    }
    expect(await handleTestAll()).toBe('stopped')
    expect(runs).toBe(0)
  })

  it('pins the guards in FallbackPage source', () => {
    expect(page).toContain('if (isTestingAny) return')
    expect(page).toContain('if (bulkAbortRef.current)')
  })
})

describe('gap constant', () => {
  it('spaces probes by 900ms', () => {
    expect(MODEL_TEST_GAP_MS).toBe(900)
  })

  it('sleep honours abort (unit proof the gap cannot hang Stop)', async () => {
    const ac = new AbortController()
    const start = Date.now()
    const p = sleep(5000, ac.signal)
    ac.abort()
    await p
    expect(Date.now() - start).toBeLessThan(500)
  })
})

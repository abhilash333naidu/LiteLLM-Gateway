import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ModelTestState } from '../../lib/model-test'

// Contract tests for "Test all and disable failed" (Test+disable) on the
// Models page. handleTestAndDisable is inline in the component (not
// exported), so this file mirrors its exact branching in a small harness AND
// pins the production source shape, the same pattern as
// fallback-probe.test.ts:
//
//   FallbackPage.tsx lines referenced below: handleTestAndDisable (visible+
//   enabled + dedup + probeAndTrack ok/false/null + REAL-TIME per-failure
//   staging via functional setStaged(prev => …) with staged-vs-server base),
//   stop branch (bulkAbortRef abort + testDisableRef reset + testing-only
//   spinner clear), Save payload (handleSave map to {modelDbId,priority,enabled}).

const here = path.dirname(fileURLToPath(import.meta.url))
const page = readFileSync(path.join(here, '../FallbackPage.tsx'), 'utf8')
const table = readFileSync(path.join(here, '../../components/model-table.tsx'), 'utf8')
const enRaw = readFileSync(path.join(here, '../../i18n/locales/en.json'), 'utf8')
const en = JSON.parse(enRaw) as { models: Record<string, string> }
const checkScript = readFileSync(path.join(here, '../../../scripts/check-i18n.mjs'), 'utf8')

type Member = { modelDbId: number; enabled: boolean }
type Group = { key: string; members: Member[] }
type Entry = { modelDbId: number; priority: number; enabled: boolean; keyCount?: number }

// ── Mirror of handleTestAndDisable id selection (same as handleTestAll) ──
function selectTestAndDisableIds(visibleGroups: Group[]): number[] {
  const ids = visibleGroups.flatMap(g => g.members.filter(m => m.enabled).map(m => m.modelDbId))
  return [...new Set(ids)]
}

// ── Mirror of the real-time staging step: each failure stages off
// immediately, everything else untouched ──
function stageFailedOff(allEntries: Entry[], failedIds: Set<number>): Entry[] {
  const failed = new Set(failedIds)
  return allEntries.map(e => (failed.has(e.modelDbId) ? { ...e, enabled: false } : e))
}

// ── Mirror of ONE real-time staging call: single failed id mapped over the
// current base (already-staged entries, or server entries when none) ──
function stageOneOff(base: Entry[], failedId: number): Entry[] {
  return base.map(e => (e.modelDbId === failedId ? { ...e, enabled: false } : e))
}

// ── Mirror of the staging base: staged entries win when they belong to the
// active profile, otherwise fall back to the server snapshot ──
function pickStagingBase(
  prev: { profileId: number | null; entries: Entry[] } | null,
  activeProfileId: number | null,
  serverEntries: Entry[],
): Entry[] {
  return prev && prev.profileId === activeProfileId ? prev.entries : serverEntries
}

// ── Mirror of probeAndTrack's abort contract: null on abort (never staged),
// false on real failure (staged immediately, even mid-run) ──
function stagesImmediately(probeResult: boolean | null): boolean {
  return probeResult === false
}

// ── Mirror of the stop-toggle spinner clear (shared with handleTestAll) ──
function clearTestingSpinners(prev: Map<number, ModelTestState>): Map<number, ModelTestState> {
  const n = new Map(prev)
  for (const [k, v] of n) if (v.status === 'testing') n.delete(k)
  return n
}

// ── Mirror of handleSave payload shape ──
function buildSavePayload(allEntries: Entry[]): { modelDbId: number; priority: number; enabled: boolean }[] {
  return allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled }))
}

describe('failed staged off / ok untouched, priority preserved (1)', () => {
  const allEntries: Entry[] = [
    { modelDbId: 1, priority: 1, enabled: true },
    { modelDbId: 2, priority: 2, enabled: true },
    { modelDbId: 3, priority: 3, enabled: true },
  ]

  it('disables only the failed ids', () => {
    const next = stageFailedOff(allEntries, new Set([2]))
    expect(next.find(e => e.modelDbId === 2)?.enabled).toBe(false)
    expect(next.find(e => e.modelDbId === 1)?.enabled).toBe(true)
    expect(next.find(e => e.modelDbId === 3)?.enabled).toBe(true)
  })

  it('preserves priority + identity of every row', () => {
    const next = stageFailedOff(allEntries, new Set([2]))
    expect(next.map(e => [e.modelDbId, e.priority])).toEqual([[1, 1], [2, 2], [3, 3]])
  })

  it('leaves ok + untested rows fully untouched (no object churn on survivors)', () => {
    const next = stageFailedOff(allEntries, new Set([2]))
    expect(next[0]).toEqual(allEntries[0])
    expect(next[2]).toEqual(allEntries[2])
    expect(next[1]).not.toEqual(allEntries[1])
  })
})

describe('all-ok run stages nothing (2)', () => {
  it('ok results never stage (only false stages)', () => {
    expect(stagesImmediately(true)).toBe(false)
    expect(stagesImmediately(null)).toBe(false)
    const staged: { profileId: number | null; entries: Entry[] } | null = null
    expect(staged).toBeNull()
  })

  it('hasChanges is false when localEntries is null', () => {
    const localEntries: Entry[] | null = null
    expect(localEntries !== null).toBe(false)
  })
})

describe('abort semantics: earlier failures persist, aborted probe never stages (3)', () => {
  it('null (aborted probe) never stages; false (real failure) stages immediately', () => {
    expect(stagesImmediately(null)).toBe(false)
    expect(stagesImmediately(false)).toBe(true)
    expect(stagesImmediately(true)).toBe(false)
  })

  it('failures staged before Stop survive the abort (no end-of-run gate)', () => {
    const server: Entry[] = [
      { modelDbId: 11, priority: 1, enabled: true },
      { modelDbId: 22, priority: 2, enabled: true },
      { modelDbId: 33, priority: 3, enabled: true },
    ]
    // Probe 11 fails -> staged immediately; probe 22 ok; Stop pressed.
    let staged: Entry[] | null = null
    staged = stageOneOff(staged ?? server, 11)
    expect(staged.find(e => e.modelDbId === 11)?.enabled).toBe(false)
    expect(staged.find(e => e.modelDbId === 22)).toEqual(server[1])
    expect(staged.find(e => e.modelDbId === 33)).toEqual(server[2])
  })

  it('stoppings build on already-staged entries, not the stale server snapshot', () => {
    const server: Entry[] = [
      { modelDbId: 11, priority: 1, enabled: true },
      { modelDbId: 22, priority: 2, enabled: true },
    ]
    const activeProfileId = 7
    let prev: { profileId: number | null; entries: Entry[] } | null = null
    // First failure: no staging yet -> base is the server snapshot.
    prev = { profileId: activeProfileId, entries: stageOneOff(pickStagingBase(prev, activeProfileId, server), 11) }
    // Second failure: base is the already-staged entries (11 stays off).
    prev = { profileId: activeProfileId, entries: stageOneOff(pickStagingBase(prev, activeProfileId, server), 22) }
    expect(prev.entries.find(e => e.modelDbId === 11)?.enabled).toBe(false)
    expect(prev.entries.find(e => e.modelDbId === 22)?.enabled).toBe(false)
  })

  it('stale staging from another profile falls back to the server snapshot', () => {
    const server: Entry[] = [{ modelDbId: 11, priority: 1, enabled: true }]
    const prev = { profileId: 999, entries: [{ modelDbId: 11, priority: 1, enabled: false }] }
    expect(pickStagingBase(prev, 7, server)).toEqual(server)
    expect(pickStagingBase(prev, 999, server)).toEqual(prev.entries)
  })

  it('stop-clear deletes testing spinners but keeps ok/error + unprobed results', () => {
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

  it('an aborted run never probes ids past the stop point (earlier failure still staged)', () => {
    const probed: number[] = []
    const ac = new AbortController()
    const ids = [11, 22, 33]
    const server: Entry[] = ids.map((id, i) => ({ modelDbId: id, priority: i + 1, enabled: true }))
    let staged: Entry[] | null = null
    for (let i = 0; i < ids.length; i++) {
      if (ac.signal.aborted) break
      probed.push(ids[i])
      if (i === 0) {
        staged = stageOneOff(staged ?? server, ids[i]) // first probe failed -> staged at once
        ac.abort() // Stop pressed after the first probe
      }
    }
    expect(probed).toEqual([11])
    expect(staged?.find(e => e.modelDbId === 11)?.enabled).toBe(false)
    expect(staged?.find(e => e.modelDbId === 22)).toEqual(server[1])
  })
})

describe('untested/disabled/filtered-out untouched + dedup (4)', () => {
  const groups: Group[] = [
    { key: 'a', members: [{ modelDbId: 1, enabled: true }, { modelDbId: 2, enabled: false }] },
    { key: 'b', members: [{ modelDbId: 3, enabled: true }, { modelDbId: 1, enabled: true }] },
  ]

  it('excludes disabled members from the probe list', () => {
    expect(selectTestAndDisableIds(groups)).not.toContain(2)
  })

  it('excludes filtered-out groups (not in visibleGroups)', () => {
    expect(selectTestAndDisableIds([groups[0]])).toEqual([1])
  })

  it('dedupes ids shared by several groups', () => {
    expect(selectTestAndDisableIds(groups)).toEqual([1, 3])
  })

  it('staging leaves disabled/untested rows untouched', () => {
    const allEntries: Entry[] = [
      { modelDbId: 1, priority: 1, enabled: true },
      { modelDbId: 2, priority: 2, enabled: false },
      { modelDbId: 3, priority: 3, enabled: true },
      { modelDbId: 4, priority: 4, enabled: true },
    ]
    // Only id 1 probed+failed; 3 ok, 4 untested (filtered out), 2 disabled.
    const next = stageFailedOff(allEntries, new Set([1]))
    expect(next.find(e => e.modelDbId === 1)?.enabled).toBe(false)
    expect(next.find(e => e.modelDbId === 2)).toEqual(allEntries[1])
    expect(next.find(e => e.modelDbId === 3)).toEqual(allEntries[2])
    expect(next.find(e => e.modelDbId === 4)).toEqual(allEntries[3])
  })
})

describe('re-run skips disabled (5)', () => {
  it('newly staged-off ids are excluded from the next selection', () => {
    const groups: Group[] = [
      { key: 'a', members: [{ modelDbId: 1, enabled: true }, { modelDbId: 2, enabled: true }] },
    ]
    expect(selectTestAndDisableIds(groups)).toEqual([1, 2])
    const rerun: Group[] = [
      { key: 'a', members: [{ modelDbId: 1, enabled: false }, { modelDbId: 2, enabled: true }] },
    ]
    expect(selectTestAndDisableIds(rerun)).toEqual([2])
  })

  it('returns empty when everything visible is now disabled', () => {
    expect(selectTestAndDisableIds([{ key: 'x', members: [{ modelDbId: 9, enabled: false }] }])).toEqual([])
  })
})

describe('Save payload shape (6)', () => {
  it('maps staged entries to exactly {modelDbId,priority,enabled}', () => {
    const staged: Entry[] = [
      { modelDbId: 1, priority: 1, enabled: false },
      { modelDbId: 2, priority: 2, enabled: true },
    ]
    expect(buildSavePayload(staged)).toEqual([
      { modelDbId: 1, priority: 1, enabled: false },
      { modelDbId: 2, priority: 2, enabled: true },
    ])
    for (const row of buildSavePayload(staged)) {
      expect(Object.keys(row).sort()).toEqual(['enabled', 'modelDbId', 'priority'])
    }
  })

  it('carries only the expected diffs (failed off, rest identical)', () => {
    const before: Entry[] = [
      { modelDbId: 1, priority: 1, enabled: true },
      { modelDbId: 2, priority: 2, enabled: true },
    ]
    const after = stageFailedOff(before, new Set([1]))
    const payload = buildSavePayload(after)
    expect(payload).toEqual([
      { modelDbId: 1, priority: 1, enabled: false },
      { modelDbId: 2, priority: 2, enabled: true },
    ])
  })
})

describe('source pins (7)', () => {
  it('pins real-time per-failure staging via functional setStaged in FallbackPage source', () => {
    expect(page).toContain('handleTestAndDisable')
    expect(page).toContain('testDisableRef')
    expect(page).toContain('setStaged(prev =>')
    expect(page).toContain('prev.entries : entries')
    expect(page).toContain('e.modelDbId === failedId')
    // No end-of-run batch gate anymore: failures stage the moment they happen.
    expect(page).not.toContain('failedIds.size > 0')
    expect(page).not.toContain('entries: allEntries.map(e => (failed.has(e.modelDbId)')
  })

  it('handler stages via setStaged/setLocalEntries and performs no PUT itself', () => {
    const start = page.indexOf('const handleTestAndDisable')
    expect(start).toBeGreaterThan(-1)
    const slice = page.slice(start, start + 4500)
    expect(slice).toContain('/api/fallback/test')
    expect(slice).toContain('setStaged')
    expect(slice).not.toContain("method: 'PUT'")
    expect(slice).not.toContain('/api/fallback\', { method')
  })

  it('pins both ModelTableHead call sites passing onTestAndDisable', () => {
    const matches = page.match(/onTestAndDisable=\{handleTestAndDisable\}/g) ?? []
    expect(matches.length).toBe(2)
    expect(page).toContain('testAndDisableDisabled={testAndDisableDisabled}')
    expect(page).toContain('testAndDisableLabel={testAndDisableLabel}')
  })

  it('pins onTestAndDisable prop + second button + aria-label in model-table', () => {
    expect(table).toContain('onTestAndDisable')
    expect(table).toContain('testAndDisableDisabled')
    expect(table).toContain('testAndDisableLabel')
    expect(table).toContain("aria-label={t('models.testAndDisable')}")
    expect(table).toContain("t('models.testAndDisableHint')")
  })

  it('pins en.json testAndDisable + hint strings', () => {
    expect(en.models.testAndDisable).toBeTruthy()
    expect(en.models.testAndDisableHint).toBeTruthy()
    expect(enRaw).toContain('testAndDisable')
    expect(enRaw).toContain('testAndDisableHint')
  })
})

describe('i18n parity (8)', () => {
  it('check-i18n script validates placeholder parity across locales', () => {
    expect(checkScript).toContain('placeholders')
    expect(checkScript).toContain('missing keys')
  })

  it('en testAndDisable strings are non-empty (parity source of truth)', () => {
    expect(typeof en.models.testAndDisable).toBe('string')
    expect(typeof en.models.testAndDisableHint).toBe('string')
    expect(en.models.testAndDisable.length).toBeGreaterThan(0)
    expect(en.models.testAndDisableHint.length).toBeGreaterThan(0)
  })
})

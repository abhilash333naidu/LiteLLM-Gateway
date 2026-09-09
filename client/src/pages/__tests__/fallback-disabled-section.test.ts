import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Contract tests for the disabled-section (SLICE 1, display-only) on the
// Models page. The partition is inline in the component (not exported), so
// this file mirrors its exact branching in a small harness AND pins the
// production source shape, the same pattern as
// fallback-disable-failed.test.ts:
//
//   FallbackPage.tsx lines referenced below: enabledGroups/disabledGroups
//   memos from visibleGroups (any member on stays top, incl. half-off mixed),
//   renderedGroups budget split (enabled first, then disabled with remainder,
//   single sentinel/hasMoreRows over the concatenated list), divider
//   <tr><td colSpan={10}> with models.disabledSectionTitle/Hint, rank stays
//   rankByKey.get (full-chain position), dimming (opacity-50) kept.

const here = path.dirname(fileURLToPath(import.meta.url))
const page = readFileSync(path.join(here, '../FallbackPage.tsx'), 'utf8')
const enRaw = readFileSync(path.join(here, '../../i18n/locales/en.json'), 'utf8')
const en = JSON.parse(enRaw) as { models: Record<string, string> }
const localeDir = path.join(here, '../../i18n/locales')
const locales = readdirSync(localeDir)
  .filter(name => name.endsWith('.json'))
  .map(name => name.slice(0, -5))

type Member = { modelDbId: number; enabled: boolean }
type Group = { key: string; members: Member[] }

// ── Mirror of the partition (enabled = any member on, incl. mixed) ──
function partitionGroups(visibleGroups: Group[]): { enabledGroups: Group[]; disabledGroups: Group[] } {
  const enabledGroups = visibleGroups.filter(g => g.members.some(m => m.enabled))
  const disabledGroups = visibleGroups.filter(g => !g.members.some(m => m.enabled))
  return { enabledGroups, disabledGroups }
}

// ── Mirror of the render-budget split (enabled first, then disabled) ──
const RENDER_CHUNK = 50
function splitRenderBudget(enabledGroups: Group[], disabledGroups: Group[], renderLimit: number): Group[] {
  const renderedEnabled = enabledGroups.slice(0, renderLimit)
  const renderedDisabled = disabledGroups.slice(0, Math.max(0, renderLimit - renderedEnabled.length))
  return [...renderedEnabled, ...renderedDisabled]
}

// ── Mirror of the divider visibility (no divider when none disabled) ──
function showsDivider(renderedDisabledCount: number): boolean {
  return renderedDisabledCount > 0
}

// ── Mirror of rank (full-chain position on orderedGroups, untouched) ──
function rankByKey(orderedGroups: Group[]): Map<string, number> {
  return new Map(orderedGroups.map((g, i) => [g.key, i + 1]))
}

describe('partition: all-off groups sink (1)', () => {
  it('sends a fully-off group to disabledGroups', () => {
    const visible: Group[] = [
      { key: 'on', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'off', members: [{ modelDbId: 2, enabled: false }] },
    ]
    const { enabledGroups, disabledGroups } = partitionGroups(visible)
    expect(enabledGroups.map(g => g.key)).toEqual(['on'])
    expect(disabledGroups.map(g => g.key)).toEqual(['off'])
  })

  it('keeps true chain order inside each section', () => {
    const visible: Group[] = [
      { key: 'a', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'b', members: [{ modelDbId: 2, enabled: false }] },
      { key: 'c', members: [{ modelDbId: 3, enabled: true }] },
      { key: 'd', members: [{ modelDbId: 4, enabled: false }] },
    ]
    const { enabledGroups, disabledGroups } = partitionGroups(visible)
    expect(enabledGroups.map(g => g.key)).toEqual(['a', 'c'])
    expect(disabledGroups.map(g => g.key)).toEqual(['b', 'd'])
  })
})

describe('partition: mixed stays top (2)', () => {
  it('a half-off group (1 of N on) stays in enabledGroups', () => {
    const visible: Group[] = [
      { key: 'mixed', members: [{ modelDbId: 1, enabled: true }, { modelDbId: 2, enabled: false }] },
      { key: 'off', members: [{ modelDbId: 3, enabled: false }] },
    ]
    const { enabledGroups, disabledGroups } = partitionGroups(visible)
    expect(enabledGroups.map(g => g.key)).toEqual(['mixed'])
    expect(disabledGroups.map(g => g.key)).toEqual(['off'])
  })
})

describe('partition: all-on stays top (3)', () => {
  it('leaves disabledGroups empty when everything is on', () => {
    const visible: Group[] = [
      { key: 'a', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'b', members: [{ modelDbId: 2, enabled: true }, { modelDbId: 3, enabled: true }] },
    ]
    const { enabledGroups, disabledGroups } = partitionGroups(visible)
    expect(enabledGroups.map(g => g.key)).toEqual(['a', 'b'])
    expect(disabledGroups).toEqual([])
  })
})

describe('empty disabled section renders no divider (4)', () => {
  it('hides the divider when no disabled rows are rendered', () => {
    expect(showsDivider(0)).toBe(false)
  })

  it('shows the divider as soon as one disabled row is rendered', () => {
    expect(showsDivider(1)).toBe(true)
  })
})

describe('rank keeps full-chain position (5)', () => {
  it('rankByKey is built from orderedGroups, not the partitioned lists', () => {
    const ordered: Group[] = [
      { key: 'a', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'b', members: [{ modelDbId: 2, enabled: false }] },
      { key: 'c', members: [{ modelDbId: 3, enabled: true }] },
    ]
    const rank = rankByKey(ordered)
    expect(rank.get('a')).toBe(1)
    expect(rank.get('b')).toBe(2)
    expect(rank.get('c')).toBe(3)
  })
})

describe('partition applies BEFORE the 50-row render slice (6)', () => {
  it('fills enabled first, then disabled with the remaining budget', () => {
    const enabled: Group[] = Array.from({ length: 40 }, (_, i) => ({
      key: `e${i}`,
      members: [{ modelDbId: i + 1, enabled: true }],
    }))
    const disabled: Group[] = Array.from({ length: 40 }, (_, i) => ({
      key: `d${i}`,
      members: [{ modelDbId: 1000 + i, enabled: false }],
    }))
    const rendered = splitRenderBudget(enabled, disabled, RENDER_CHUNK)
    expect(rendered.length).toBe(50)
    expect(rendered.slice(0, 40).map(g => g.key)).toEqual(enabled.map(g => g.key))
    expect(rendered.slice(40).map(g => g.key)).toEqual(disabled.slice(0, 10).map(g => g.key))
  })

  it('renders only enabled when they already fill the budget', () => {
    const enabled: Group[] = Array.from({ length: 60 }, (_, i) => ({
      key: `e${i}`,
      members: [{ modelDbId: i + 1, enabled: true }],
    }))
    const disabled: Group[] = [{ key: 'd0', members: [{ modelDbId: 9999, enabled: false }] }]
    const rendered = splitRenderBudget(enabled, disabled, RENDER_CHUNK)
    expect(rendered.length).toBe(50)
    expect(rendered.every(g => g.key.startsWith('e'))).toBe(true)
  })
})

describe('source pins (7)', () => {
  it('derives enabledGroups/disabledGroups memos from visibleGroups', () => {
    expect(page).toContain('const enabledGroups')
    expect(page).toContain('const disabledGroups')
    expect(page).toContain('visibleGroups.filter(g => g.members.some(m => m.enabled))')
    expect(page).toContain('visibleGroups.filter(g => !g.members.some(m => m.enabled))')
  })

  it('splits the render budget (enabled first, then disabled with remainder)', () => {
    expect(page).toContain('enabledGroups.slice(0, renderLimit)')
    expect(page).toContain('disabledGroups.slice(0')
    expect(page).toContain('renderLimit - ')
    // Partitioned lists feed the slice now, not the raw visible list.
    expect(page).not.toContain('const renderedGroups = visibleGroups.slice(0, renderLimit)')
  })

  it('keeps single sentinel/hasMoreRows semantics over the concatenated list', () => {
    expect(page).toContain('const hasMoreRows = visibleGroups.length > renderLimit')
  })

  it('keeps rank on the full chain (rankByKey over orderedGroups)', () => {
    expect(page).toContain('new Map(orderedGroups.map((g, i) => [g.key, i + 1]))')
    expect(page).toContain('rank={rankByKey.get(g.key)')
  })

  it('renders a divider row spanning all 10 columns in both table branches', () => {
    const dividers = page.match(/colSpan=\{10\}/g) ?? []
    expect(dividers.length).toBeGreaterThanOrEqual(2)
    expect(page).toContain("t('models.disabledSectionTitle'")
    expect(page).toContain("t('models.disabledSectionHint')")
  })

  it('keeps dimming on fully-off rows', () => {
    expect(page).toContain('opacity-50')
  })

  it('does not move Test+disable scope, bulk toggle, save, or drag (slice 2 owns drag)', () => {
    // Probe/bulk scope still reads visibleGroups, not the partitioned lists.
    expect(page).toContain('visibleGroups.flatMap(g => g.members.filter(m => m.enabled).map(m => m.modelDbId))')
    expect(page).toContain('const visibleMemberIds = visibleGroups.flatMap(g => g.members.map(m => m.modelDbId))')
    expect(page).toContain('function handleSave()')
    expect(page).toContain('function handleGroupedDragEnd')
  })
})

describe('i18n (8)', () => {
  it('en.json has the disabled-section keys (title carries {count})', () => {
    expect(typeof en.models.disabledSectionTitle).toBe('string')
    expect(typeof en.models.disabledSectionHint).toBe('string')
    expect(en.models.disabledSectionTitle.length).toBeGreaterThan(0)
    expect(en.models.disabledSectionHint.length).toBeGreaterThan(0)
    expect(en.models.disabledSectionTitle).toContain('{count}')
    expect(enRaw).toContain('disabledSectionTitle')
    expect(enRaw).toContain('disabledSectionHint')
  })

  it('every locale has the disabled-section keys', () => {
    expect(locales.length).toBe(60)
    for (const name of locales) {
      const dictionary = JSON.parse(readFileSync(path.join(localeDir, `${name}.json`), 'utf8'))
      expect(typeof dictionary.models.disabledSectionTitle, `${name} is missing models.disabledSectionTitle`)
        .toBe('string')
      expect(typeof dictionary.models.disabledSectionHint, `${name} is missing models.disabledSectionHint`)
        .toBe('string')
    }
  })
})

// ── SLICE 2 (drag guards): mirrors of the enabled-scoped remap ──
// handleGroupedDragEnd resolves indices within the ENABLED ordered list,
// then reconstructs FULL order = reordered enabled + disabled in original
// relative order, before persistGroupOrder flattens to priority = index+1.
function arrayMoveMirror<T>(arr: T[], from: number, to: number): T[] {
  const next = [...arr]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

function persistPriorities(fullOrder: Group[]): Map<number, number> {
  const order: number[] = []
  for (const g of fullOrder) for (const m of g.members) order.push(m.modelDbId)
  return new Map(order.map((id, i) => [id, i + 1]))
}

// New path: enabled-scoped drag + disabled tail preservation.
function dragEnabledScoped(ordered: Group[], activeKey: string, overKey: string): Group[] | null {
  const enabledOrdered = ordered.filter(g => g.members.some(m => m.enabled))
  const oldI = enabledOrdered.findIndex(g => `grp:${g.key}` === activeKey)
  const newI = enabledOrdered.findIndex(g => `grp:${g.key}` === overKey)
  if (oldI < 0 || newI < 0) return null
  const reorderedEnabled = arrayMoveMirror(enabledOrdered, oldI, newI)
  const disabledOrdered = ordered.filter(g => !g.members.some(m => m.enabled))
  return [...reorderedEnabled, ...disabledOrdered]
}

// Old path (slice-1 bug): indices resolved in the full orderedGroups, so a
// sunk display drag serializes shifted positions and can promote a disabled
// group.
function dragOldPath(ordered: Group[], activeKey: string, overKey: string): Group[] | null {
  const oldI = ordered.findIndex(g => `grp:${g.key}` === activeKey)
  const newI = ordered.findIndex(g => `grp:${g.key}` === overKey)
  if (oldI < 0 || newI < 0) return null
  return arrayMoveMirror(ordered, oldI, newI)
}

describe('drag within enabled preserves disabled tail (9)', () => {
  // True chain is interleaved; display sinks d1 to the bottom. Dragging e1
  // after e2 must keep d1 in its tail slot.
  const ordered: Group[] = [
    { key: 'e1', members: [{ modelDbId: 1, enabled: true }] },
    { key: 'd1', members: [{ modelDbId: 2, enabled: false }] },
    { key: 'e2', members: [{ modelDbId: 3, enabled: true }] },
  ]

  it('reorders enabled and keeps disabled in tail slots with priority = index+1', () => {
    const full = dragEnabledScoped(ordered, 'grp:e1', 'grp:e2')
    expect(full!.map(g => g.key)).toEqual(['e2', 'e1', 'd1'])
    const prio = persistPriorities(full!)
    expect(prio.get(3)).toBe(1)
    expect(prio.get(1)).toBe(2)
    expect(prio.get(2)).toBe(3)
  })

  it('disabled tail keeps original relative order after a drag', () => {
    const chain: Group[] = [
      { key: 'e1', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'd1', members: [{ modelDbId: 2, enabled: false }] },
      { key: 'e2', members: [{ modelDbId: 3, enabled: true }] },
      { key: 'd2', members: [{ modelDbId: 4, enabled: false }] },
    ]
    const full = dragEnabledScoped(chain, 'grp:e2', 'grp:e1')
    expect(full!.map(g => g.key)).toEqual(['e2', 'e1', 'd1', 'd2'])
  })

  it('old path would promote the disabled group (guards the regression)', () => {
    const buggy = dragOldPath(ordered, 'grp:e1', 'grp:e2')
    // arrayMove(ordered, 0, 2) pulls d1 to the front — the silent rewrite.
    expect(buggy!.map(g => g.key)).toEqual(['d1', 'e2', 'e1'])
    const fixed = dragEnabledScoped(ordered, 'grp:e1', 'grp:e2')
    expect(fixed!.map(g => g.key)).not.toEqual(buggy!.map(g => g.key))
  })

  it('mixed (half-off) groups live in enabled and drag normally', () => {
    const chain: Group[] = [
      { key: 'e1', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'mixed', members: [{ modelDbId: 2, enabled: true }, { modelDbId: 3, enabled: false }] },
      { key: 'd1', members: [{ modelDbId: 4, enabled: false }] },
    ]
    const full = dragEnabledScoped(chain, 'grp:mixed', 'grp:e1')
    expect(full!.map(g => g.key)).toEqual(['mixed', 'e1', 'd1'])
  })
})

describe('drag with empty disabled is identity with old path (10)', () => {
  it('matches arrayMove on the full list when nothing is disabled', () => {
    const ordered: Group[] = [
      { key: 'a', members: [{ modelDbId: 1, enabled: true }] },
      { key: 'b', members: [{ modelDbId: 2, enabled: true }] },
      { key: 'c', members: [{ modelDbId: 3, enabled: true }] },
    ]
    const fixed = dragEnabledScoped(ordered, 'grp:c', 'grp:a')
    const old = dragOldPath(ordered, 'grp:c', 'grp:a')
    expect(fixed!.map(g => g.key)).toEqual(['c', 'a', 'b'])
    expect(fixed!.map(g => g.key)).toEqual(old!.map(g => g.key))
  })
})

describe('disabled rows are not draggable (11)', () => {
  const ordered: Group[] = [
    { key: 'e1', members: [{ modelDbId: 1, enabled: true }] },
    { key: 'e2', members: [{ modelDbId: 2, enabled: true }] },
    { key: 'd1', members: [{ modelDbId: 3, enabled: false }] },
  ]

  it('dropping onto a disabled row is a no-op', () => {
    expect(dragEnabledScoped(ordered, 'grp:e1', 'grp:d1')).toBeNull()
  })

  it('dragging a disabled row itself is a no-op', () => {
    expect(dragEnabledScoped(ordered, 'grp:d1', 'grp:e1')).toBeNull()
  })

  it('SortableContext items cover the enabled decorated groups only', () => {
    expect(page).toContain('decoratedEnabledGroups.map(g => `grp:${g.key}`)')
    expect(page).not.toContain('items={decoratedGroups.map(g => `grp:${g.key}`)}')
  })

  it('draggable branch renders a single SortableGroupRow (enabled) + plain disabled rows', () => {
    expect(page.match(/<SortableGroupRow/g)?.length).toBe(1)
    expect(page.match(/<GroupHeaderCells/g)?.length).toBeGreaterThanOrEqual(3)
  })
})

describe('source pins for the remap (12)', () => {
  it('resolves drag indices within the enabled ordered list', () => {
    expect(page).toContain('const enabledOrdered = orderedGroups.filter(g => g.members.some(m => m.enabled))')
  })

  it('reconstructs full order (reordered enabled + disabled tail) before persist', () => {
    expect(page).toContain('const disabledOrdered = orderedGroups.filter(g => !g.members.some(m => m.enabled))')
    expect(page).toContain('persistGroupOrder([...reorderedEnabled, ...disabledOrdered])')
  })

  it('no longer persists arrayMove over the raw orderedGroups', () => {
    expect(page).not.toContain('persistGroupOrder(arrayMove(orderedGroups')
  })
})

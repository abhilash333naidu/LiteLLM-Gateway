import type { ModelListRow } from '@freellmapi/shared/types.js';
import { getDb } from '../db/index.js';
import { isUnifyEnabled, getModelGroups } from './model-groups.js';
import { getActiveProfileId } from './profile-models.js';

// Shared catalog-listing logic behind both the OpenAI `GET /v1/models` and the
// Anthropic `GET /v1/models` endpoints, so the two wire formats list the exact
// same models (only the envelope differs). Extracted verbatim from the OpenAI
// proxy route to keep a single source of truth.

export interface NormalizedModel {
  id: string;
  name: string;
  ownedBy: string;
  available: number;
  enabled: number;
  contextWindow: number | null;
  intel: number;
  // Platforms that can serve this entry (group members under unify, a single
  // platform otherwise) + tool capability — feeds /v1/models
  // `supported_parameters` so agents can pick knobs per model.
  platforms: string[];
  supportsTools: boolean;
}

export interface ModelListing {
  // Full catalog, sorted usable-first; callers apply their own `available` filter.
  models: NormalizedModel[];
  // Honest ceiling for the virtual "auto" model: the largest context window
  // among models that can serve a request right now (null when nothing is
  // connected). Computed over available models regardless of any caller filter.
  autoContextWindow: number | null;
}

export function buildModelListing(): ModelListing {
  const availableExpr = `
    (CASE WHEN m.enabled = 1 AND EXISTS (
        SELECT 1 FROM api_keys k
        WHERE k.platform = m.platform
          AND k.enabled = 1
          AND (m.key_id IS NULL OR k.id = m.key_id)
      ) THEN 1 ELSE 0 END)`;
  const db = getDb();
  const activeProfileId = getActiveProfileId(db);

  let allListed: NormalizedModel[];

  if (isUnifyEnabled()) {
    // Unify ON: one entry per logical model group. Pull per-row availability +
    // context keyed by db id, then aggregate over each group's members.
    // When a chain is active, gate visibility by that chain: a model removed
    // from the chain (profile_models.enabled = 0 or no row) is excluded from
    // /v1/models entirely, so harnesses see the operator's 28 not the full
    // catalog. Further restrict to models that can actually serve (available=1)
    // so the default listing is the usable chain slice.
    type AvailRow = { id: number; platform: string; intelligence_rank: number; context_window: number | null; enabled: number; available: number; supports_tools: number };
    const rows = activeProfileId != null
      ? db.prepare(`
        SELECT m.id, m.platform, m.intelligence_rank, m.context_window, m.supports_tools,
               m.enabled AS enabled, ${availableExpr} AS available
        FROM models m
        JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id AND pm.enabled = 1
        WHERE m.enabled = 1 AND ${availableExpr} = 1
      `).all(activeProfileId) as AvailRow[]
      : db.prepare(`
        SELECT m.id, m.platform, m.intelligence_rank, m.context_window, m.supports_tools,
               m.enabled AS enabled, ${availableExpr} AS available
        FROM models m
      `).all() as AvailRow[];
    const byId = new Map(rows.map(r => [r.id, r]));
    const groups = getModelGroups();
    allListed = (activeProfileId != null
      ? groups.filter(g => g.members.some(m => byId.has(m.model_db_id)))
      : groups
    ).map(g => {
      const infos = g.members.map(m => byId.get(m.model_db_id)).filter(Boolean) as AvailRow[];
      // For an active chain with no surviving members, infos is empty — but
      // that group was already filtered out above, so this branch is coherent.
      if (infos.length === 0) {
        return {
          id: g.canonicalId,
          name: g.groupLabel,
          ownedBy: 'freellmapi',
          available: 0,
          enabled: 0,
          contextWindow: null,
          intel: Number.MAX_SAFE_INTEGER,
          platforms: [],
          supportsTools: false,
        };
      }
      const ctxs = infos.map(i => i.context_window).filter((c): c is number => c != null);
      return {
        id: g.canonicalId,
        name: g.groupLabel,
        ownedBy: 'freellmapi',
        available: infos.some(i => i.available === 1) ? 1 : 0,
        enabled: infos.some(i => i.enabled === 1) ? 1 : 0,
        contextWindow: ctxs.length ? Math.max(...ctxs) : null,
        intel: infos.length ? Math.min(...infos.map(i => i.intelligence_rank)) : Number.MAX_SAFE_INTEGER,
        platforms: [...new Set(infos.map(i => i.platform))],
        supportsTools: infos.some(i => i.supports_tools === 1),
      };
    }).filter(g => activeProfileId == null || g.platforms.length > 0);
  } else {
    // Unify OFF: one entry per model_id (dedup picks the available, smartest
    // representative row). With an active chain, only chain-enabled + available
    // rows are considered, mirroring the unify path.
    const models = activeProfileId != null
      ? db.prepare(`
        SELECT platform, model_id, display_name, context_window, enabled, available, intelligence_rank, id, supports_tools
        FROM (
          SELECT m.platform, m.model_id, m.display_name, m.context_window, m.intelligence_rank, m.id, m.supports_tools,
                 m.enabled AS enabled,
                 ${availableExpr} AS available,
                 ROW_NUMBER() OVER (
                   PARTITION BY m.model_id
                   ORDER BY ${availableExpr} DESC, m.intelligence_rank ASC, m.id ASC
                 ) AS rn
          FROM models m
          JOIN profile_models pm ON pm.profile_id = ? AND pm.model_db_id = m.id AND pm.enabled = 1
          WHERE m.enabled = 1 AND ${availableExpr} = 1
        )
        WHERE rn = 1
      `).all(activeProfileId) as (ModelListRow & { intelligence_rank: number; id: number; supports_tools: number })[]
      : db.prepare(`
        SELECT platform, model_id, display_name, context_window, enabled, available, intelligence_rank, id, supports_tools
        FROM (
          SELECT m.platform, m.model_id, m.display_name, m.context_window, m.intelligence_rank, m.id, m.supports_tools,
                 m.enabled AS enabled,
                 ${availableExpr} AS available,
                 ROW_NUMBER() OVER (
                   PARTITION BY m.model_id
                   ORDER BY ${availableExpr} DESC, m.intelligence_rank ASC, m.id ASC
                 ) AS rn
          FROM models m
        )
        WHERE rn = 1
      `).all() as (ModelListRow & { intelligence_rank: number; id: number; supports_tools: number })[];
    allListed = models.map(m => ({
      id: m.model_id, name: m.display_name, ownedBy: m.platform,
      available: m.available, enabled: m.enabled, contextWindow: m.context_window,
      intel: m.intelligence_rank,
      platforms: [m.platform],
      supportsTools: m.supports_tools === 1,
    }));
  }

  // Stable order: usable first, then enabled, then smartest, then name.
  allListed.sort((a, b) =>
    (b.available - a.available) || (b.enabled - a.enabled) || (a.intel - b.intel) || a.name.localeCompare(b.name));

  const availableContextWindows = allListed
    .filter(m => m.available === 1 && m.contextWindow != null)
    .map(m => m.contextWindow as number);
  const autoContextWindow = availableContextWindows.length > 0
    ? Math.max(...availableContextWindows)
    : null;

  return { models: allListed, autoContextWindow };
}

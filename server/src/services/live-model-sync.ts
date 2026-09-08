import { createHash } from 'node:crypto';
import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import type { Scheduler } from '../lib/scheduler.js';
import { MAX_DISCOVERED_MODELS, readCappedBody } from './model-discovery.js';
import { customModelSeed } from './custom-model-seed.js';
import { ensureModelInProfiles } from './profile-models.js';
import {
  clearCatalogModelTombstone,
  getCatalogModelTombstone,
  getModelOverrides,
  isCatalogModelTombstoned,
  recordCatalogModelTombstone,
} from './model-state.js';
import { getProvider, hasProvider } from '../providers/index.js';
import { BaseProvider } from '../providers/base.js';
import { decrypt } from '../lib/crypto.js';
import { decryptProxyUrl } from '../lib/key-proxy.js';
import { withKeyProxy } from '../lib/proxy.js';
import type { Platform } from '@freellmapi/shared/types.js';

// ── Scheduled live-model discovery ───────────────────────────────────────────
//
// Reconciles the local `models` table with providers' CURRENT model rosters:
// whatever free models OpenRouter / OpenCode Zen / Groq actually serve today.
// This never touches the paid/subscription catalog system — it only ever
// creates, disables or reinstates rows with source='live'.

export interface LiveDiscoveryCounts {
  added: number;
  reinstated: number;
  deprecated: number;
  skipped: number;
  paidSkipped: number;
  tombstoned: number;
}

/** Per-platform outcome of one sync run — what the operator actually needs to
 *  answer "did it pull anything?". `pulled` is the reconciled roster size
 *  (post free-filter, or full roster on manual admit-all); `addedIds` names
 *  newly inserted models (capped) so "0 added" reads as "all N already known"
 *  instead of "nothing happened". */
export interface LivePlatformDetail {
  platform: string;
  status: 'ok' | 'skipped' | 'failed';
  pulled: number;
  added: number;
  reinstated: number;
  deprecated: number;
  skipped: number;
  paidSkipped: number;
  tombstoned: number;
  addedIds: string[];
  error?: string;
  skipReason?: string;
}

export interface LiveDiscoveryResult {
  ok: boolean;
  platforms: string[];
  counts: LiveDiscoveryCounts;
  failures: Array<{ platform: string; error: string }>;
  fingerprint: string;
  durationMs: number;
  /** One entry per attempted platform, in run order. Additive — older clients ignore it. */
  details: LivePlatformDetail[];
}

export interface LiveDiscoveryState {
  enabled: boolean;
  lastRunMs: number | null;
  lastError: string | null;
  lastResult: LiveDiscoveryResult | null;
}

/** One provider roster entry that survived free/modality filtering. Capability
 *  fields are evidence-only: undefined means "the upstream said nothing". */
export interface CollectedLiveModel {
  id: string;
  tools: boolean | undefined;
  vision: boolean | undefined;
  contextWindow: number | undefined;
}

/** Default: twice a day. The bundled free roster drifts fast; daily is stale. */
const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;

/** Keyless OpenRouter plus the keyed free-tier gateways, in fetch order. */
const DEFAULT_PLATFORMS = [
  'openrouter',
  'opencode', 'groq',
  'routeway', 'unorouter', 'orcarouter', 'bazaarlink',
  'kilo', 'pollinations',
  'reka', 'nara', 'agnes',
  'sealion', 'llm7', 'navy', 'cerebras', 'github', 'nvidia',
  'mistral', 'ovh', 'aion', 'ainative', 'anyapi',
  'google', 'cohere', 'aihorde', 'cloudflare',
];

const SETTING_LAST_RUN_MS = 'live_discovery_last_run_ms';
const SETTING_LAST_ERROR = 'live_discovery_last_error';
const SETTING_LAST_RESULT_JSON = 'live_discovery_last_result_json';

/** Interval in ms from `LIVE_MODEL_SYNC_INTERVAL_MS`; 0 disables the pass,
 *  anything unset or malformed falls back to the 12h default. */
export function liveDiscoveryIntervalMs(): number {
  const raw = process.env.LIVE_MODEL_SYNC_INTERVAL_MS;
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_MS;
  const ms = Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_INTERVAL_MS;
}

/** Comma-separated platform list from `LIVE_MODEL_SYNC_PLATFORMS`. */
function liveDiscoveryPlatforms(): string[] {
  const raw = process.env.LIVE_MODEL_SYNC_PLATFORMS;
  if (raw === undefined || raw.trim() === '') return [...DEFAULT_PLATFORMS];
  const list = raw.split(',').map(p => p.trim().toLowerCase()).filter(p => p.length > 0);
  return list.length > 0 ? [...new Set(list)] : [...DEFAULT_PLATFORMS];
}

let lastRunMs: number | null = null;
let lastError: string | null = null;
let lastResult: LiveDiscoveryResult | null = null;

function readSetting(key: string): string | undefined {
  try {
    return getSetting(key);
  } catch {
    return undefined;
  }
}

export function getLiveDiscoveryState(): LiveDiscoveryState {
  if (lastRunMs === null) {
    const raw = readSetting(SETTING_LAST_RUN_MS);
    const ms = raw === undefined ? NaN : Number(raw);
    if (Number.isFinite(ms)) lastRunMs = ms;
  }
  if (lastError === null) {
    const raw = readSetting(SETTING_LAST_ERROR);
    if (raw !== undefined && raw !== '') lastError = raw;
  }
  if (lastResult === null) {
    const raw = readSetting(SETTING_LAST_RESULT_JSON);
    if (raw !== undefined) {
      try {
        lastResult = JSON.parse(raw) as LiveDiscoveryResult;
      } catch {
        lastResult = null;
      }
    }
  }
  return { enabled: liveDiscoveryIntervalMs() > 0, lastRunMs, lastError, lastResult };
}

/** Keyless OpenRouter roster: free, text-only models with capability evidence.
 *  parseModelCatalog cannot serve here — it drops the tools signal — so this
 *  is a DEDICATED row mapper over the raw OpenRouter envelope. */
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const OPENROUTER_TIMEOUT_MS = 15_000;

/** Ids longer than this are certainly not model ids; skip rather than store. */
const MAX_MODEL_ID_LENGTH = 256;

interface CollectorOutput {
  models: CollectedLiveModel[];
  /** Entries filtered as non-free / non-text / unverifiable. */
  paidSkipped: number;
  /** True when the platform was not attempted at all (no compatible provider
   *  or no usable key) — the run skips it without recording a failure. */
  notAttempted?: boolean;
  /** Machine-readable skip cause for the per-platform detail row. */
  skipReason?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asLowerStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(v => typeof v === 'string').map(v => (v as string).toLowerCase());
}

function isZeroNumber(raw: unknown): boolean {
  if (typeof raw === 'number') return Number.isFinite(raw) && raw === 0;
  if (typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isFinite(n) && n === 0;
  }
  return false;
}

/** One OpenRouter catalog entry mapped to a free text model, or null when it
 *  is paid, non-text, or carries no verifiable free/text evidence. The `:free`
 *  suffix stays verbatim — it is part of the routable id. */
function mapOpenRouterEntry(entry: unknown): CollectedLiveModel | null {
  const record = asRecord(entry);
  if (!record) return null;
  const rawId = record.id;
  const id = typeof rawId === 'string' ? rawId.trim() : '';
  if (!id || id.length > MAX_MODEL_ID_LENGTH) return null;

  // Free means prompt AND completion are both zero. A missing pricing block
  // is not evidence — it is skipped, never assumed free.
  const pricing = asRecord(record.pricing);
  if (!pricing || !isZeroNumber(pricing.prompt) || !isZeroNumber(pricing.completion)) return null;

  // Text-only: input must carry text (image input marks vision), output must
  // be text and nothing else — lyria-style audio/image output rows are out.
  const architecture = asRecord(record.architecture);
  const modalitySides = typeof architecture?.modality === 'string'
    ? String(architecture.modality).toLowerCase().split('->')
    : [];
  const input = architecture ? asLowerStrings(architecture.input_modalities) : undefined;
  const output = architecture ? asLowerStrings(architecture.output_modalities) : undefined;
  const inputModalities = input
    ?? modalitySides[0]?.split('+').map(s => s.trim()).filter(Boolean)
    ?? [];
  const outputModalities = output
    ?? (modalitySides[1] !== undefined ? modalitySides[1].split('+').map(s => s.trim()).filter(Boolean) : []);
  if (!inputModalities.includes('text')) return null;
  if (outputModalities.length === 0 || !outputModalities.every(m => m === 'text')) return null;

  // Tools: an advertised parameter list without 'tools' is evidence of
  // ABSENCE (writes 0); no list at all is unknown (defaults to 1 on insert).
  const params = asLowerStrings(record.supported_parameters)
    ?? (architecture ? asLowerStrings(architecture.supported_parameters) : undefined);
  const tools = params === undefined ? undefined : params.includes('tools');

  const contextRaw = record.context_length;
  const contextWindow = typeof contextRaw === 'number' && Number.isFinite(contextRaw) && contextRaw > 0
    ? Math.floor(contextRaw)
    : undefined;

  return { id, tools, vision: inputModalities.includes('image'), contextWindow };
}

async function fetchOpenRouterModels(): Promise<CollectorOutput> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS) });
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error('OpenRouter /models unreachable: ' + reason);
  }
  const bodyText = await readCappedBody(res);
  if (!res.ok) throw new Error('OpenRouter /models returned HTTP ' + res.status);
  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    throw new Error('OpenRouter /models did not return JSON');
  }
  const record = asRecord(payload);
  const entries = record && (Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models) ? record.models : null);
  if (!entries) throw new Error('OpenRouter /models did not return a model list');

  const models: CollectedLiveModel[] = [];
  const seenIds = new Set<string>();
  let paidSkipped = 0;
  for (const entry of entries) {
    const mapped = mapOpenRouterEntry(entry);
    if (!mapped) {
      paidSkipped += 1;
      continue;
    }
    if (seenIds.has(mapped.id)) continue;
    seenIds.add(mapped.id);
    models.push(mapped);
    if (models.length >= MAX_DISCOVERED_MODELS) break;
  }
  return { models, paidSkipped };
}

/** Free-tier probe rules: platform → id patterns that count as free.
 *  `'*'` matches any run of chars (incl. empty), so `'*'` alone admits all
 *  served ids. A platform with NO entry here is never probed — unknown env
 *  names skip silently, and the EXCLUDED set below stays out on purpose. */
interface LiveProbeRule {
  patterns: string[];
  /** Keyless probes call listChatModels(null) with NO key lookup. */
  keyless?: boolean;
}

const LIVE_PROBE_RULES: Record<string, LiveProbeRule> = {
  // OpenCode Zen free promo pool: `-free` suffixed ids plus the free flagship.
  opencode: { patterns: ['*-free', 'big-pickle'] },
  // Groq: everything servable on the key is free-tier.
  groq: { patterns: ['*'] },
  // Routeway / UnoRouter aggregators: free pool carries the `:free` suffix.
  routeway: { patterns: ['*:free'] },
  unorouter: { patterns: ['*:free'] },
  // OrcaRouter: recurring rate-limited free aliases, never paid fallback.
  orcarouter: { patterns: ['*-free', 'orcarouter/free'] },
  // BazaarLink: only the `auto:free` route is $0; direct ids are paid.
  bazaarlink: { patterns: ['auto:free'] },
  // Kilo: its /v1/models 405s; the list URL is wired separately — this code
  // just calls listChatModels and treats throw/empty as inconclusive.
  kilo: { patterns: ['*:free'], keyless: true },
  // Pollinations: public /v1/models, no key needed.
  pollinations: { patterns: ['*'], keyless: true },
  // Reka: exactly the two /v1/models entries (recurring monthly credit grant).
  reka: { patterns: ['reka-flash-3', 'reka-edge-2603'] },
  // NaraRouter: the three free-plan routes.
  nara: { patterns: ['mistral-large', 'mistral-medium-3-5', 'tencent-hy3'] },
  // Agnes AI: no agnes rows exist in the legacy baseline seed, so there are no
  // exact ids to derive — match the proprietary `agnes-` prefix instead (only
  // evidenced id so far: agnes-2.0-flash, $0/token live-probed).
  agnes: { patterns: ['agnes-*'] },
  // First-party free tiers / free allowances already treated as free by the
  // shipped catalog: admit everything served.
  sealion: { patterns: ['*'] },
  llm7: { patterns: ['*'] },
  navy: { patterns: ['*'] },
  cerebras: { patterns: ['*'] },
  github: { patterns: ['*'] },
  nvidia: { patterns: ['*'] },
  mistral: { patterns: ['*'] },
  ovh: { patterns: ['*'] },
  aion: { patterns: ['*'] },
  ainative: { patterns: ['*'] },
  anyapi: { patterns: ['*'] },
  // Adapters land in parallel; the listChatModels guard skips these until
  // their provider exposes the method.
  google: { patterns: ['*'] },
  cohere: { patterns: ['*'] },
  aihorde: { patterns: ['*'] },
  cloudflare: { patterns: ['*'] },
};
// Explicitly EXCLUDED (no rule above), each for a wallet-safety reason:
// - huggingface: hundreds of paid models, $0.10 shared credit, no free signal.
// - modelscope: public list, retired-model 429 poison.
// - zhipu, requesty, siliconflow, xkiro: free only distinguishable by probing.
// - qianfan, volcengine, longcat, xfyun: real-name-gated, no operator keys.

/** One provider roster entry from the listChatModels contract (parallel-agent
 *  surface: BaseProvider default throws; OpenAICompatProvider + google/cohere/
 *  aihorde/cloudflare overrides serve it). Fields are validated defensively —
 *  anything unparseable is skipped, never stored. */
interface ListedChatModel {
  id: string;
  tools?: boolean | undefined;
  vision?: boolean | undefined;
  contextWindow?: number | undefined;
}

type ListChatModelsFn = (apiKey: string | null) => Promise<ListedChatModel[]>;

interface KeyRow {
  encrypted_key: string;
  iv: string;
  auth_tag: string;
  proxy_encrypted?: string | null;
  proxy_iv?: string | null;
  proxy_auth_tag?: string | null;
  [column: string]: unknown;
}

function listUsableKeyRows(db: Db, platform: string): KeyRow[] {
  return db.prepare(
    "SELECT * FROM api_keys WHERE platform = ? AND enabled = 1 AND status IN ('healthy','unknown') ORDER BY id ASC",
  ).all(platform) as KeyRow[];
}

/** listChatModels collector. Keyless rules probe with a null key and NO key
 *  lookup; keyed rules try each usable credential in id order and stop at the
 *  first roster that parses — one key failing (401/transport/empty) falls
 *  through to the next key, so a single bad key never blocks the platform.
 *  A throw or an empty/unparseable roster from EVERY key is inconclusive —
 *  the caller records a failure and never disables rows. */
async function fetchViaListChatModels(
  db: Db,
  platform: string,
  rule: LiveProbeRule,
  provider: object,
  listChatModels: ListChatModelsFn,
  admitAll = false,
): Promise<CollectorOutput> {
  const notAttempted: CollectorOutput = { models: [], paidSkipped: 0, notAttempted: true };
  if (rule.keyless) {
    return fetchWithKey(db, platform, rule, provider, listChatModels, null, undefined, admitAll);
  }
  const keyRows = listUsableKeyRows(db, platform);
  if (keyRows.length === 0) return notAttempted;
  let lastError: unknown = null;
  for (const keyRow of keyRows) {
    let apiKey: string;
    try {
      apiKey = decrypt(keyRow.encrypted_key, keyRow.iv, keyRow.auth_tag);
    } catch {
      lastError = new Error(platform + ' stored key could not be decrypted');
      continue;
    }
    // Mirror health.ts: probe through the key's own proxy exit.
    const proxyRow = {
      proxy_encrypted: (keyRow.proxy_encrypted as string | null) ?? null,
      proxy_iv: (keyRow.proxy_iv as string | null) ?? null,
      proxy_auth_tag: (keyRow.proxy_auth_tag as string | null) ?? null,
    };
    try {
      return await fetchWithKey(db, platform, rule, provider, listChatModels, apiKey, proxyRow, admitAll);
    } catch (err: unknown) {
      lastError = err;
      continue;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(platform + ' listChatModels unreachable');
}

async function fetchWithKey(
  _db: Db,
  platform: string,
  _rule: LiveProbeRule,
  provider: object,
  listChatModels: ListChatModelsFn,
  apiKey: string | null,
  proxyRow: { proxy_encrypted: string | null; proxy_iv: string | null; proxy_auth_tag: string | null } | undefined,
  admitAll = false,
): Promise<CollectorOutput> {
  let discovered: unknown;
  try {
    discovered = await withKeyProxy(
      proxyRow ? decryptProxyUrl(proxyRow) : undefined,
      () => listChatModels.call(provider, apiKey),
    );
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(platform + ' listChatModels unreachable: ' + reason);
  }
  if (!Array.isArray(discovered)) throw new Error(platform + ' listChatModels did not return a model list');
  const entries: ListedChatModel[] = [];
  for (const item of discovered) {
    const record = asRecord(item);
    const id = record && typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || id.length > MAX_MODEL_ID_LENGTH) continue;
    // Preserve only well-formed capability evidence; anything else stays
    // unknown so the insert-time defaults apply.
    const entry: ListedChatModel = { id };
    if (typeof record?.tools === 'boolean') entry.tools = record.tools;
    if (typeof record?.vision === 'boolean') entry.vision = record.vision;
    const contextWindow = record?.contextWindow;
    if (typeof contextWindow === 'number' && Number.isFinite(contextWindow) && contextWindow > 0) {
      entry.contextWindow = Math.floor(contextWindow);
    }
    entries.push(entry);
  }
  if (entries.length === 0) throw new Error(platform + ' returned an empty model list');

  return filterFreeModels(platform, entries, admitAll);
}

/** Apply the platform's LIVE_PROBE_RULES patterns; non-matching ids are
 *  presumably paid and counted, never stored. Manual per-provider sync sets
 *  `admitAll` — the operator explicitly asked "what does this key serve", so
 *  every listed id is reconciled instead of only the free subset. */
function filterFreeModels(platform: string, entries: ListedChatModel[], admitAll = false): CollectorOutput {
  const models: CollectedLiveModel[] = [];
  let paidSkipped = 0;
  for (const entry of entries) {
    if (!admitAll && !liveFreePass(platform, entry.id)) {
      paidSkipped += 1;
      continue;
    }
    models.push({ id: entry.id, tools: undefined, vision: entry.vision, contextWindow: entry.contextWindow });
  }
  return { models, paidSkipped };
}

/** Keyed provider roster. Scheduled sync requires a LIVE_PROBE_RULES entry
 *  (deliberately excluded wallets skip silently — not a failure); manual
 *  per-provider sync sets `admitAll` and probes ANY registered provider, since
 *  the operator explicitly asked what that key serves. Probing goes through
 *  the provider's listChatModels override only: the typeof guard plus the
 *  BaseProvider-default check skip providers whose adapter has not landed yet.
 *  One platform's failure is isolated and never disables rows. */
async function fetchKeyedPlatformModels(db: Db, platform: string, admitAll = false): Promise<CollectorOutput> {
  const skip = (reason: string): CollectorOutput => ({ models: [], paidSkipped: 0, notAttempted: true, skipReason: reason });
  const rule = LIVE_PROBE_RULES[platform];
  if (!rule && !admitAll) return skip('excluded-by-free-filter');
  const effectiveRule = rule ?? { patterns: ['*'] };
  let provider: unknown;
  try {
    provider = getProvider(platform as Platform);
  } catch {
    return skip('no-provider');
  }
  const listChatModels = (provider as { listChatModels?: unknown }).listChatModels;
  // The typeof guard alone is not enough: BaseProvider ships a default
  // listChatModels that always throws ("model listing not supported"), so a
  // provider that merely inherits it counts as ABSENT. Only a subclass
  // override (or a test double's own function) takes the listing path.
  const hasListing = typeof listChatModels === 'function'
    && listChatModels !== BaseProvider.prototype.listChatModels;
  if (!hasListing) return skip('no-listing');
  if (!effectiveRule.keyless && listUsableKeyRows(db, platform).length === 0) return skip('no-usable-key');
  return fetchViaListChatModels(db, platform, effectiveRule, provider as object, listChatModels as ListChatModelsFn, admitAll);
}

/** Whether a roster id counts as free on this platform. Unknown platforms
 *  (no rule) never pass — but they never reach here either, the collector
 *  skips them before probing. */
function liveFreePass(platform: string, id: string): boolean {
  const rule = LIVE_PROBE_RULES[platform];
  if (!rule) return false;
  return rule.patterns.some(pattern => livePatternMatches(pattern, id));
}

/** Glob match where `*` matches any run of chars (incl. empty). */
function livePatternMatches(pattern: string, id: string): boolean {
  const escaped = pattern.split('*').map(seg => seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('^' + escaped.join('.*') + '$').test(id);
}

/** Insert one live row plus its fallback chain and profile entries, mirroring
 *  the custom-model-register write path (seeded ranks, rpm/rpd limits). */
function insertLiveModelRow(db: Db, platform: string, model: CollectedLiveModel): void {
  const seed = customModelSeed(db);
  const info = db.prepare(`
    INSERT INTO models
      (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
       rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
       enabled, key_id, supports_tools, supports_vision, source, endpoint_scope)
    VALUES (?, ?, ?, ?, ?, ?, 20, 50, NULL, NULL, '', ?, 1, NULL, ?, ?, 'live', '')
  `).run(
    platform,
    model.id,
    model.id,
    seed.intelligenceRank,
    seed.speedRank,
    seed.sizeLabel,
    model.contextWindow ?? null,
    model.tools === undefined ? 1 : (model.tools ? 1 : 0),
    model.vision ? 1 : 0,
  );
  const modelDbId = Number(info.lastInsertRowid);
  const max = db.prepare('SELECT COALESCE(MAX(priority), 0) AS m FROM fallback_config').get() as { m: number };
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(modelDbId, max.m + 1);
  ensureModelInProfiles(db, modelDbId);
}

interface ExistingRow {
  id: number;
  model_id: string;
  source: string;
  enabled: number;
}

/** Re-listed after a live-sync deprecation: lift the tombstone and re-enable
 *  the row, its fallback chain entry and its profile entries — unless a stored
 *  override pins enabled off, or the tombstone is not ours (410-retirements
 *  from model-retirement.ts carry different reason text and are never
 *  touched). Only live-sync tombstones (`live-sync:` reason prefix) qualify. */
function maybeReinstateLiveModel(
  db: Db,
  platform: string,
  modelId: string,
  row: ExistingRow,
  counts: LiveDiscoveryCounts,
): boolean {
  if (row.source !== 'live' || row.enabled === 1) return false;
  const tomb = getCatalogModelTombstone(db, 'chat', platform, modelId);
  if (!tomb || tomb.source !== 'upstream_eol') return false;
  if (!tomb.reason || !tomb.reason.startsWith('live-sync:')) return false;
  if (getModelOverrides(db, platform, modelId).enabled === false) return false;
  clearCatalogModelTombstone(db, 'chat', platform, modelId);
  db.prepare('UPDATE models SET enabled = 1 WHERE id = ?').run(row.id);
  db.prepare('UPDATE fallback_config SET enabled = 1 WHERE model_db_id = ?').run(row.id);
  db.prepare('UPDATE profile_models SET enabled = 1 WHERE model_db_id = ?').run(row.id);
  counts.reinstated += 1;
  return true;
}

/** Apply one platform roster: add unseen ids, reinstate re-listed live-sync
 *  deprecations, never touch existing rows' metadata otherwise, and never
 *  re-add a user-tombstoned model. One transaction. */
function applyPlatformModels(db: Db, platform: string, models: CollectedLiveModel[], counts: LiveDiscoveryCounts): void {
  db.transaction(() => {
    const existing = db.prepare('SELECT id, model_id, source, enabled FROM models WHERE platform = ?').all(platform) as ExistingRow[];
    const byId = new Map(existing.map(row => [row.model_id, row]));
    for (const model of models) {
      const row = byId.get(model.id);
      if (row) {
        // Present already — a local disable, a catalog row, a user row: all
        // win, except a live-sync deprecation the provider just undid.
        if (!maybeReinstateLiveModel(db, platform, model.id, row, counts)) counts.skipped += 1;
        continue;
      }
      if (isCatalogModelTombstoned(db, 'chat', platform, model.id)) {
        counts.tombstoned += 1;
        continue;
      }
      insertLiveModelRow(db, platform, model);
      byId.set(model.id, { id: -1, model_id: model.id, source: 'live', enabled: 1 });
      counts.added += 1;
    }
  })();
}

/** Deprecate live rows a successful non-empty provider fetch omits: disable
 *  the row plus its fallback/profile entries and record an upstream_eol
 *  tombstone. Only rows this service created (source='live'), only rows with
 *  no tombstone at all — 410-retirements and user deletions are never
 *  touched, and tombstones are never written for models we did not create. */
function deprecateMissingLiveModels(db: Db, platform: string, seenIds: Set<string>, counts: LiveDiscoveryCounts): void {
  db.transaction(() => {
    const rows = db.prepare(
      "SELECT id, model_id FROM models WHERE platform = ? AND source = 'live' AND enabled = 1",
    ).all(platform) as Array<{ id: number; model_id: string }>;
    for (const row of rows) {
      if (seenIds.has(row.model_id)) continue;
      if (getCatalogModelTombstone(db, 'chat', platform, row.model_id)) continue;
      const reason = 'live-sync: absent from provider list as of ' + new Date().toISOString();
      recordCatalogModelTombstone(db, 'chat', platform, row.model_id, { source: 'upstream_eol', reason });
      db.prepare('UPDATE models SET enabled = 0 WHERE id = ?').run(row.id);
      db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(row.id);
      db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(row.id);
      counts.deprecated += 1;
    }
  })();
}

/** sha256 over canonical sorted JSON of {platform → sorted model ids} seen. */
function fingerprintSeen(seen: Record<string, string[]>): string {
  const canonical: Record<string, string[]> = {};
  for (const platform of Object.keys(seen).sort()) {
    canonical[platform] = [...seen[platform]!].sort();
  }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function persistSettings(runMs: number, result: LiveDiscoveryResult, error: string | null): void {
  setSetting(SETTING_LAST_RUN_MS, String(runMs));
  setSetting(SETTING_LAST_RESULT_JSON, JSON.stringify(result));
  if (error === null) {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETTING_LAST_ERROR);
  } else {
    setSetting(SETTING_LAST_ERROR, error);
  }
}

/** Platforms eligible for live discovery: the scheduled default set. Exported
 *  so the manual per-provider route can validate a single name against the
 *  same list (plus openrouter, which has its own keyless collector). */
export function liveSyncPlatforms(): string[] {
  return liveDiscoveryPlatforms();
}

/** Single-platform live sync, independent of the signed catalog: hits the
 *  provider's real `/models` roster with the stored key(s) and reconciles only
 *  that platform's `source='live'` rows. Used by the Keys-page "Sync live
 *  models" button. Admits the full roster (not just the free subset) — the
 *  operator explicitly asked what that key serves. Throws 400 on
 *  unknown/custom platforms, 502 when no usable key or no listing exists. */
export async function runLiveModelSyncForPlatform(db: Db, platformRaw: string): Promise<LiveDiscoveryResult> {
  const platform = platformRaw.trim().toLowerCase();
  if (!platform) {
    throw Object.assign(new Error('platform is required'), { status: 400, code: 'bad_request' });
  }
  if (platform === 'custom') {
    throw Object.assign(
      new Error('custom endpoints sync per-endpoint via Fetch models on the Keys page, not via live discovery'),
      { status: 400, code: 'custom_use_discover' },
    );
  }
  if (!hasProvider(platform as Platform)) {
    throw Object.assign(new Error(`unknown live-sync platform '${platformRaw}'`), { status: 400, code: 'unknown_platform' });
  }
  if (platform !== 'openrouter') {
    const provider = getProvider(platform as Platform);
    const listChatModels = (provider as { listChatModels?: unknown }).listChatModels;
    const hasListing = typeof listChatModels === 'function'
      && listChatModels !== BaseProvider.prototype.listChatModels;
    if (!hasListing) {
      throw Object.assign(
        new Error(`'${platformRaw}' does not expose a live model list`),
        { status: 400, code: 'no_listing' },
      );
    }
    const keys = listUsableKeyRows(db, platform);
    if (keys.length === 0) {
      throw Object.assign(
        new Error(`No usable key for '${platformRaw}' — add and validate a key first`),
        { status: 502, code: 'no_usable_key' },
      );
    }
  }
  const result = await syncPlatforms(db, [platform], { admitAll: true });
  if (!result.ok && result.platforms.length === 0) {
    const first = result.failures[0];
    throw Object.assign(
      new Error(first ? `${platformRaw}: ${first.error}` : `live sync produced no models for '${platformRaw}'`),
      { status: 502, code: 'upstream_error' },
    );
  }
  return result;
}

/** Reconcile the `models` table with providers' current rosters. One
 *  platform's failure is recorded and never disables existing rows: an empty
 *  or failed fetch is inconclusive, never evidence of removal. */
export async function runLiveModelSync(db: Db): Promise<LiveDiscoveryResult> {
  return syncPlatforms(db, liveDiscoveryPlatforms());
}

/** Shared core: reconcile exactly the given platforms. No catalog fetch, no
 *  license check — pure provider-roster truth. `admitAll` (manual single
 *  sync) reconciles the full roster instead of only the free subset. */
/** Cap on named ids per platform detail — bounds the persisted settings JSON. */
const MAX_ADDED_IDS = 25;

async function syncPlatforms(db: Db, platforms: string[], opts: { admitAll?: boolean } = {}): Promise<LiveDiscoveryResult> {
  const startedAt = Date.now();
  const counts: LiveDiscoveryCounts = { added: 0, reinstated: 0, deprecated: 0, skipped: 0, paidSkipped: 0, tombstoned: 0 };
  const failures: Array<{ platform: string; error: string }> = [];
  const seen: Record<string, string[]> = {};
  const details: LivePlatformDetail[] = [];

  const snapshot = (): LiveDiscoveryCounts => ({ ...counts });
  const delta = (before: LiveDiscoveryCounts): LiveDiscoveryCounts => ({
    added: counts.added - before.added,
    reinstated: counts.reinstated - before.reinstated,
    deprecated: counts.deprecated - before.deprecated,
    skipped: counts.skipped - before.skipped,
    paidSkipped: counts.paidSkipped - before.paidSkipped,
    tombstoned: counts.tombstoned - before.tombstoned,
  });

  try {
    for (const platform of platforms) {
      try {
        const out = platform === 'openrouter'
          ? await fetchOpenRouterModels()
          : await fetchKeyedPlatformModels(db, platform, opts.admitAll === true);
        counts.paidSkipped += out.paidSkipped;
        if (out.notAttempted) {
          details.push({
            platform, status: 'skipped', pulled: 0,
            added: 0, reinstated: 0, deprecated: 0, skipped: 0,
            paidSkipped: out.paidSkipped, tombstoned: 0, addedIds: [],
            skipReason: out.skipReason ?? 'not-attempted',
          });
          continue;
        }
        // An empty list is inconclusive, never evidence of removal.
        if (out.models.length === 0) throw new Error(platform + ' returned an empty model list');
        // Ids not already present become the visible "added" proof.
        const knownIds = new Set(
          (db.prepare('SELECT model_id FROM models WHERE platform = ?').all(platform) as Array<{ model_id: string }>)
            .map(r => r.model_id),
        );
        const addedIds = out.models.map(m => m.id).filter(id => !knownIds.has(id)).slice(0, MAX_ADDED_IDS);
        const before = snapshot();
        seen[platform] = out.models.map(m => m.id);
        applyPlatformModels(db, platform, out.models, counts);
        deprecateMissingLiveModels(db, platform, new Set(seen[platform]), counts);
        const d = delta(before);
        details.push({
          platform, status: 'ok', pulled: out.models.length,
          added: d.added, reinstated: d.reinstated, deprecated: d.deprecated,
          skipped: d.skipped, paidSkipped: out.paidSkipped, tombstoned: d.tombstoned,
          addedIds,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ platform, error: message });
        details.push({
          platform, status: 'failed', pulled: 0,
          added: 0, reinstated: 0, deprecated: 0, skipped: 0,
          paidSkipped: 0, tombstoned: 0, addedIds: [], error: message,
        });
        console.error(`[live-model-sync] ${platform}: ${message}`);
      }
    }

    const ok = Object.keys(seen).length > 0;
    const error = ok ? null : failures.map(f => `${f.platform}: ${f.error}`).join('; ') || 'no platforms produced a model list';
    const result: LiveDiscoveryResult = {
      ok,
      platforms: Object.keys(seen).sort(),
      counts,
      failures,
      fingerprint: fingerprintSeen(seen),
      durationMs: Date.now() - startedAt,
      details,
    };

    lastRunMs = startedAt;
    lastError = error;
    lastResult = result;
    persistSettings(startedAt, result, error);
    const pulled = details.reduce((n, d) => n + d.pulled, 0);
    console.log(
      `[live-model-sync] ok=${ok} pulled=${pulled} added=${counts.added} reinstated=${counts.reinstated} ` +
      `deprecated=${counts.deprecated} skipped=${counts.skipped} paidSkipped=${counts.paidSkipped} ` +
      `tombstoned=${counts.tombstoned} failures=${failures.length}`,
    );
    return result;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    const result: LiveDiscoveryResult = {
      ok: false,
      platforms: [],
      counts,
      failures: [...failures, { platform: '*', error: message }],
      fingerprint: fingerprintSeen(seen),
      durationMs: Date.now() - startedAt,
      details,
    };
    lastRunMs = startedAt;
    lastError = message;
    lastResult = result;
    try {
      persistSettings(startedAt, result, message);
    } catch {
      // Persistence must never turn a result into a throw.
    }
    console.log(`[live-model-sync] ok=false error=${message}`);
    return result;
  }
}

/** Register the scheduled pass. Returns null when the interval is 0
 *  (disabled); otherwise one delayed run plus the interval pass. */
export function startLiveModelSync(db: Db, scheduler: Scheduler): (() => void) | null {
  const intervalMs = liveDiscoveryIntervalMs();
  if (intervalMs <= 0) return null;
  const run = (): void => {
    void runLiveModelSync(db);
  };
  const cancelOnce = scheduler.after(30_000, run);
  const cancelEvery = scheduler.every(intervalMs, run, { name: 'live-model-sync' });
  return () => {
    cancelOnce();
    cancelEvery();
  };
}

import { getDb } from '../db/index.js';
import { getProvider, hasProvider } from '../providers/index.js';
import { routeRequest, RouteError, type ChainRow } from './router.js';
import { contentToString } from '../lib/content.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import type { Platform } from '@freellmapi/shared/types.js';

export const MODEL_TEST_TIMEOUT_MS = 15_000;
// 16 output tokens starve reasoning models: they spend the whole budget on the
// hidden trace (finish_reason length, empty content) while answering fine in
// chat. 256 leaves room for think + the one-word answer.
export const MODEL_TEST_MAX_TOKENS = 256;

export interface ModelTestResult {
  modelDbId: number;
  modelId: string;
  platform: string;
  ok: boolean;
  latencyMs: number;
  error?: string;
  replyPreview?: string;
}

/**
 * Live probe for a single enabled provider row (one `models` row).
 * Sends a minimal chat completion ("Reply with just: ok") through the
 * provider and reports whether any non-empty reply text came back.
 *
 * Uses a single-entry `prefetchedChain` so `routeRequest` pins the dispatch
 * to exactly this `modelDbId` — no fallback to the next chain entry.
 * Spacing of bulk probes (gap between calls) is the caller's job; here we
 * just bound the per-model wall time.
 */
export async function testSingleModel(
  modelDbId: number,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ModelTestResult> {
  const timeoutMs = opts.timeoutMs ?? MODEL_TEST_TIMEOUT_MS;
  const db = getDb();
  const modelRow = db.prepare('SELECT id, platform, model_id, enabled FROM models WHERE id = ?').get(modelDbId) as
    | { id: number; platform: string; model_id: string; enabled: number }
    | undefined;

  if (!modelRow) {
    throw Object.assign(new Error(`model ${modelDbId} not found`), { status: 404, code: 'not_found' });
  }
  if (!modelRow.enabled) {
    throw Object.assign(new Error(`model ${modelDbId} is disabled`), { status: 400, code: 'model_disabled' });
  }
  if (!hasProvider(modelRow.platform as Platform)) {
    throw Object.assign(new Error(`no provider for ${modelRow.platform}`), { status: 503, code: 'no_provider' });
  }

  // Build a single-row chain entry mirroring what getActiveChain returns.
  // Only fields `routeRequest`/`selectKeyForModel` read are required.
  const full = db.prepare(`
    SELECT m.id AS model_db_id, 1 AS priority, 1 AS enabled,
           m.platform, m.model_id, m.display_name, m.intelligence_rank,
           m.size_label, m.monthly_token_budget,
           m.rpm_limit, m.rpd_limit, m.tpm_limit, m.tpd_limit,
           m.supports_vision, m.supports_tools, m.context_window,
           m.key_id, COALESCE(m.endpoint_scope, '') AS endpoint_scope
    FROM models m WHERE m.id = ?
  `).get(modelDbId) as ChainRow | undefined;

  if (!full) {
    throw Object.assign(new Error(`model ${modelDbId} not found`), { status: 404, code: 'not_found' });
  }

  // Use routeRequest with a single-entry chain so only this model is eligible.
  // estimatedTokens 20 is enough for the tiny probe; 0 reserve keeps the check lenient.
  // NOTE: routeRequest THROWS RouteError on exhaustion (never returns null).
  let route: Awaited<ReturnType<typeof routeRequest>>;
  try {
    route = routeRequest(
      20, // estimatedTokens
      undefined, // skipKeys
      undefined, // preferredModelDbId — not used when chain is single-entry
      false, // requireVision
      false, // requireTools
      undefined, // skipModels
      [full], // prefetchedChain — pin to this one row
      false, // requireStructured
      undefined, // skipPlatforms
      0, // exactOutputReserve
    );
  } catch (err: any) {
    if (err instanceof RouteError) {
      throw Object.assign(
        new Error(`no usable key for this model (${(err.diagnostics ?? []).join('; ') || err.message})`),
        { status: 503, code: 'no_usable_key' },
      );
    }
    throw err;
  }

  const provider = getProvider(route.platform as Platform) ?? route.provider;

  // Compose a per-call abort signal with a wall timeout + optional caller signal.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeoutSignal, opts.signal]) : timeoutSignal;

  const messages: Array<{ role: 'user'; content: string }> = [{ role: 'user', content: 'Reply with just: ok' }];
  const t0 = Date.now();
  try {
    const res = await provider.chatCompletion(
      route.apiKey,
      messages as any,
      route.modelId,
      {
        max_tokens: MODEL_TEST_MAX_TOKENS,
        temperature: 0,
        timeoutMs,
        signal,
      } as any,
      undefined,
    );
    const latencyMs = Date.now() - t0;
    const msgOut = (res as any)?.choices?.[0]?.message ?? {};
    const raw = msgOut?.content ?? (res as any)?.choices?.[0]?.text ?? '';
    const text = contentToString(raw).trim();
    // Reasoning/thinking models may answer with an empty content but a
    // populated trace (reasoning_content / reasoning) — that still proves the
    // model served the request, so it counts as a pass. Adapters without the
    // openai-compat reasoning fold (cloudflare/cohere/aihorde/google) need this.
    const reasoning = [msgOut?.reasoning_content, msgOut?.reasoning]
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .join('\n');
    const replyPreview = (text || reasoning).slice(0, 120);
    if (text.length > 0 || reasoning.length > 0) {
      return { modelDbId, modelId: route.modelId, platform: route.platform, ok: true, latencyMs, replyPreview };
    }
    return {
      modelDbId,
      modelId: route.modelId,
      platform: route.platform,
      ok: false,
      latencyMs,
      error: 'empty_response',
      replyPreview,
    };
  } catch (err: any) {
    const latencyMs = Date.now() - t0;
    const msg = sanitizeProviderErrorMessage(err?.message ?? String(err));
    const sanitized = msg || 'upstream_error';
    // Preserve upstream status as a hint when it's handy — EXCEPT 401: the
    // dashboard logs out on ANY 401, and an upstream bad-key 401 is not a
    // session failure. Report it as 502 so one revoked provider key can't
    // nuke the operator's session mid Test-All.
    const upstreamStatus = err?.status && err.status >= 400 ? err.status : 502;
    const status = upstreamStatus === 401 ? 502 : upstreamStatus;
    const code = err?.status ? `${sanitized} (${err.status})` : sanitized;
    // Re-throw as a typed error so the route handler serializes a clean body.
    const e: any = new Error(code);
    e.status = status;
    e.code = 'upstream_error';
    e.latencyMs = latencyMs;
    e.platform = route.platform;
    e.modelId = route.modelId;
    throw e;
  } finally {
    // selectKeyForModel took an in-flight lease for this probe; production
    // loops release it, and so must we — otherwise every probe benches its key
    // (concurrency/TPM gates) for up to the 120s lease age-out.
    route.release?.();
  }
}

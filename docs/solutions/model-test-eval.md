# Model Test / Test-All — evaluation record

Date: 2026-09-08 · Branch work merged to `main` as PR #5 (`29abfb5`)
Scope: `POST /api/fallback/test` + Models-page `Test` / `Test All` (commit `a6a40d7` + proof tests)

## Verdict

The logic is correct and proven: 53 new tests green, full client suite (272)
green, server + client production builds green, live stack verified
(`:3001` ping ok, `:5173` HTTP 200).

## Single Test — server/src/services/model-test.ts:34

1. Validate row: 404 `not_found` / 400 `model_disabled` / 503 `no_provider`.
2. Build single-row `ChainRow`, call `routeRequest(20, …, prefetchedChain=[row])`
   → pinned dispatch, no chain walk. `RouteError` on exhaustion → 503
   `no_usable_key` with diagnostics (never null — the old null check was dead).
3. `provider.chatCompletion(apiKey, [{user: "Reply with just: ok"}],
   modelId, {max_tokens: 256, temperature: 0, timeoutMs: 15000, signal})`.
   Signal = `AbortSignal.timeout(15000)` (+ caller signal via `AbortSignal.any`).
4. Pass iff `content` non-empty OR `reasoning_content`/`reasoning` non-empty
   (covers adapters without the openai-compat fold: google/cloudflare/cohere/aihorde).
   Else `ok:false error:'empty_response'` (HTTP 200, no throw).
5. Errors sanitized (`sanitizeProviderErrorMessage`); upstream 401 clamped to
   502 at service AND route layers — `/test` can never 401 the dashboard.
6. `finally { route.release?.() }` — in-flight lease always freed (120s age-out
   is backstop, not policy).

Route `server/src/routes/fallback.ts:680`: `requireAuth` → 120/min limiter →
zod `{modelDbId}` → `testSingleModel` → 200 `{ok,…}`; 400/404/429/502/503 typed.

## Test All — client/src/pages/FallbackPage.tsx:334

Visible + enabled rows only (respects search/vision/tools/context filters),
deduplicated ids, sequential `probeOne` + 900 ms gap (`MODEL_TEST_GAP_MS`),
single `bulkAbortRef` controller; header button toggles to Stop (aborts gap +
in-flight fetch, deletes only still-`testing` spinners, keeps finished
results). `isTestingAny` blocks concurrent runs/double-clicks. States keyed by
`modelDbId`: testing → ok (✓ + latency) / error (✗ + message); tooltips show
latency / replyPreview / per-member breakdown.

Client `lib/api.ts:42`: logout only on 401 with missing/`authentication_error`
type — typed `upstream_error` never logs out.

## Proof artifacts

- `server/src/__tests__/services/model-test.test.ts` — 10 tests
- `server/src/__tests__/providers/reasoning-probe.test.ts` — 16 tests
- `client/src/pages/__tests__/fallback-probe.test.ts` — 22 tests
- `client/src/pages/__tests__/fallback-401.test.ts` — 5 tests

## Residual notes (not bugs)

- Probe bypasses bandit penalties/cooldowns by design (no `recordSuccess`/
  `recordModelFailure`); it neither benches nor heals production routing.
- Reasoning models may take most of the 256-token budget on the hidden trace;
  pass still holds via the reasoning channel.
- `AbortSignal.any` needs Node ≥ 20.3 (engines require ≥ 20.18 — satisfied).

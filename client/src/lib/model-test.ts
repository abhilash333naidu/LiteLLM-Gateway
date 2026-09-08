// Shared helpers for the live model probe (see server/src/services/model-test.ts).
// The dashboard sends one tiny non-streaming chat completion per provider row
// and passes only when non-empty reply text arrives.

export type ModelTestStatus = 'idle' | 'testing' | 'ok' | 'error'

export interface ModelTestState {
  status: ModelTestStatus
  latencyMs?: number
  error?: string
  replyPreview?: string
}

export interface ModelTestResult {
  modelDbId: number
  modelId: string
  platform: string
  ok: boolean
  latencyMs: number
  error?: string
  replyPreview?: string
}

// Wall time for one probe and the pause between probes when "Test all" walks
// the visible list (#1150). 900ms keeps the dashboard's 120-RPM admin limiter
// out of the way and spaces load on 20-RPM free tiers; tightening it needs a
// limiter bump.
export const MODEL_TEST_GAP_MS = 900
export const MODEL_TEST_TIMEOUT_MS = 15_000

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return
  if (signal?.aborted) return
  await new Promise<void>(resolve => {
    let t: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => {
      if (t) clearTimeout(t)
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
  })
}

export function isTestOk(result: ModelTestResult | { ok: boolean; error?: string }): boolean {
  return result.ok && !result.error
}

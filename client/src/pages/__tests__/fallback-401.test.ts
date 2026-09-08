import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { apiFetch, UNAUTHORIZED_EVENT } from '../../lib/api'

// Typed 401s from OTHER causes (e.g. an upstream provider rejecting a key,
// proxied through /api/fallback/test as `upstream_error`) must NOT log out:
// one revoked provider key would otherwise nuke the operator's session mid
// Test-All. Only a missing type or `authentication_error` clears the token.

const here = path.dirname(fileURLToPath(import.meta.url))
const apiSource = readFileSync(path.join(here, '../../lib/api.ts'), 'utf8')

function mockFailure(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: false,
    status,
    statusText: 'Unauthorized',
    json: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('apiFetch 401 handling', () => {
  let removeItem: ReturnType<typeof vi.fn>
  let dispatchEvent: ReturnType<typeof vi.fn>

  beforeEach(() => {
    removeItem = vi.fn()
    dispatchEvent = vi.fn()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn().mockReturnValue('session-token'),
      setItem: vi.fn(),
      removeItem,
    })
    vi.stubGlobal('window', { dispatchEvent })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('pins the logout rule in source: only missing/authentication_error 401s clear the token', () => {
    expect(apiSource).toContain("body.error?.type === undefined || body.error?.type === 'authentication_error'")
    expect(apiSource).toContain('upstream_error')
  })

  it('does NOT clear the token on a typed upstream_error 401 (probe failure)', async () => {
    mockFailure(401, { error: { type: 'upstream_error', message: 'provider key rejected' } })
    const err: any = await apiFetch('/api/fallback/test', { method: 'POST' }).catch(e => e)
    expect(err.status).toBe(401)
    expect(err.code).toBe('upstream_error')
    expect(removeItem).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })

  it('clears the token + dispatches unauthorized on authentication_error 401', async () => {
    mockFailure(401, { error: { type: 'authentication_error', message: 'session expired' } })
    const err: any = await apiFetch('/api/me').catch(e => e)
    expect(err.status).toBe(401)
    expect(err.code).toBe('authentication_error')
    expect(removeItem).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    expect(dispatchEvent.mock.calls[0][0]).toBeInstanceOf(CustomEvent)
    expect(dispatchEvent.mock.calls[0][0].type).toBe(UNAUTHORIZED_EVENT)
  })

  it('clears the token on a typeless 401 (legacy session expiry)', async () => {
    mockFailure(401, { error: { message: 'unauthorized' } })
    await apiFetch('/api/me').catch(e => e)
    expect(removeItem).toHaveBeenCalledTimes(1)
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
  })

  it('does NOT clear the token on non-401 failures even with upstream_error type', async () => {
    mockFailure(429, { error: { type: 'upstream_error', message: 'rate limited' } })
    const err: any = await apiFetch('/api/fallback/test', { method: 'POST' }).catch(e => e)
    expect(err.status).toBe(429)
    expect(removeItem).not.toHaveBeenCalled()
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})

import { useQuery } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'

export interface LicenseStatus {
  valid: boolean
  plan: 'annual' | 'lifetime' | null
  status: string | null
  expiresAt: string | null
  cancelAtPeriodEnd?: boolean
  reason?: string
  checkedAtMs: number
}

export interface CatalogSyncState {
  baseUrl: string
  appliedVersion: string | null
  appliedTier: string | null
  lastSyncMs: number | null
  lastError: string | null
}

export interface LiveDiscoveryCounts {
  added: number
  reinstated: number
  deprecated: number
  skipped: number
  paidSkipped: number
  tombstoned: number
}

export interface LiveDiscoveryResult {
  ok: boolean
  platforms: string[]
  counts: LiveDiscoveryCounts
  failures: Array<{ platform: string; error: string }>
  fingerprint: string
  durationMs: number
}

export interface LiveDiscoveryState {
  enabled: boolean
  lastRunMs: number | null
  lastError: string | null
  lastResult: LiveDiscoveryResult | null
}

export interface PremiumStatus {
  hasKey: boolean
  maskedKey: string | null
  license: LicenseStatus | null
  catalog: CatalogSyncState
  liveDiscovery: LiveDiscoveryState
  siteUrl: string
}

export function usePremium() {
  const query = useQuery<PremiumStatus>({
    queryKey: ['premium'],
    queryFn: () => apiFetch('/api/premium'),
  })

  return {
    ...query,
    licensed: Boolean(query.data?.hasKey && query.data.license?.valid),
  }
}

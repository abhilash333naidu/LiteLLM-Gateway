import { beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../../app.js';
import { initDb, getDb } from '../../db/index.js';
import {
  getCatalogModelTombstone,
  recordCatalogModelTombstone,
  reinstateUpstreamRetiredCatalogModel,
  upsertModelOverrides,
} from '../../services/model-state.js';
import { mintDashboardToken, isGatedApiPath } from '../helpers/auth.js';

// A dashboard disable (Test+disable, switches) must land in BOTH chain
// tables, and a boot-time reinstate must not resurrect chain flags.

let app: Express;
let dashToken = '';

async function request(method: string, path: string, body?: unknown) {
  const server = app.listen(0, '127.0.0.1');
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', () => resolve()));
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(isGatedApiPath(path) ? { Authorization: `Bearer ${dashToken}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => null);
  server.close();
  return { status: res.status, body: data };
}

function activeProfileId(): number {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'active_profile_id'").get() as { value: string };
  return Number(row.value);
}

function addModel(modelId: string, platform = 'groq'): number {
  const db = getDb();
  const inserted = db.prepare(`
    INSERT INTO models (
      platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
      monthly_token_budget, enabled
    )
    VALUES (?, ?, ?, 1, 1, 'Small', '~1M', 1)
  `).run(platform, modelId, modelId);
  const id = Number(inserted.lastInsertRowid);
  db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)').run(id, 1);
  db.prepare('INSERT INTO profile_models (profile_id, model_db_id, priority, enabled) VALUES (?, ?, ?, 1)')
    .run(activeProfileId(), id, 1);
  return id;
}

function chainFlags(id: number): { pm: number | null; fc: number | null } {
  const db = getDb();
  const pm = db.prepare('SELECT enabled FROM profile_models WHERE profile_id = ? AND model_db_id = ?')
    .get(activeProfileId(), id) as { enabled: number } | undefined;
  const fc = db.prepare('SELECT enabled FROM fallback_config WHERE model_db_id = ?')
    .get(id) as { enabled: number } | undefined;
  return { pm: pm?.enabled ?? null, fc: fc?.enabled ?? null };
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
  app = createApp();
  dashToken = mintDashboardToken();
});

describe('bulk PUT writes both chain tables (Fix 1)', () => {
  it('disabling via PUT persists in profile_models AND fallback_config', async () => {
    const id = addModel('persist-model');
    const put = await request('PUT', '/api/fallback', [{ modelDbId: id, priority: 1, enabled: false }]);
    expect(put.status).toBe(200);
    expect(chainFlags(id)).toEqual({ pm: 0, fc: 0 });

    const get = await request('GET', '/api/fallback');
    expect(get.status).toBe(200);
    expect((get.body as { modelDbId: number; enabled: boolean }[]).find(r => r.modelDbId === id)?.enabled).toBe(false);
  });

  it('re-enabling via PUT restores both tables', async () => {
    const id = addModel('relight-model');
    await request('PUT', '/api/fallback', [{ modelDbId: id, priority: 1, enabled: false }]);
    expect(chainFlags(id)).toEqual({ pm: 0, fc: 0 });
    await request('PUT', '/api/fallback', [{ modelDbId: id, priority: 1, enabled: true }]);
    expect(chainFlags(id)).toEqual({ pm: 1, fc: 1 });
  });
});

describe('catalog reinstate leaves chain membership to the user (Fix 2)', () => {
  it('clears the tombstone but does not touch chain flags', () => {
    const db = getDb();
    const id = addModel('retired-model');
    // Retirement took it out of both chains (as retireCatalogModelUpstream does).
    db.prepare('UPDATE fallback_config SET enabled = 0 WHERE model_db_id = ?').run(id);
    db.prepare('UPDATE profile_models SET enabled = 0 WHERE model_db_id = ?').run(id);
    recordCatalogModelTombstone(db, 'chat', 'groq', 'retired-model', { source: 'upstream_eol', reason: 'gone' });

    expect(reinstateUpstreamRetiredCatalogModel(db, 'groq', 'retired-model')).toBe(true);
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'retired-model')).toBeUndefined();
    // Availability fact lifted, but the user's chain stays off.
    expect(chainFlags(id)).toEqual({ pm: 0, fc: 0 });
  });

  it('an explicit overrides pin blocks even the tombstone clear', () => {
    const db = getDb();
    addModel('pinned-model');
    recordCatalogModelTombstone(db, 'chat', 'groq', 'pinned-model', { source: 'upstream_eol', reason: 'gone' });
    upsertModelOverrides(db, 'groq', 'pinned-model', { enabled: false });

    expect(reinstateUpstreamRetiredCatalogModel(db, 'groq', 'pinned-model')).toBe(false);
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'pinned-model')?.source).toBe('upstream_eol');
  });

  it('ignores non-upstream tombstones', () => {
    const db = getDb();
    addModel('user-deleted-model');
    recordCatalogModelTombstone(db, 'chat', 'groq', 'user-deleted-model', { source: 'user', reason: 'deleted' });

    expect(reinstateUpstreamRetiredCatalogModel(db, 'groq', 'user-deleted-model')).toBe(false);
    expect(getCatalogModelTombstone(db, 'chat', 'groq', 'user-deleted-model')?.source).toBe('user');
  });
});

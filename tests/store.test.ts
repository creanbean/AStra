import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { Store } from '../server/store.js';

it('persists a private profile and marks interrupted runs so they cannot silently resubmit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'astra-store-'));
  try {
    const original = new Store(dir);
    await original.init();
    original.profile.firstName = 'Alex';
    original.runs.push({ id: 'test', url: 'https://example.com/apply', autoSubmit: true, status: 'running', createdAt: 'now', updatedAt: 'now', events: [], questions: [] });
    await original.save();
    const restored = new Store(dir);
    await restored.init();
    expect(restored.profile.firstName).toBe('Alex');
    expect(restored.runs[0].status).toBe('failed');
    expect(restored.runs[0].result).toContain('avoid duplicate');
    expect((await stat(path.join(dir, 'profile.json'))).mode & 0o777).toBe(0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

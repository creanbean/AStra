import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { CampaignRunner } from '../server/campaign.js';
import { canonicalUrl } from '../server/discovery.js';
import type { ApplicationRun, JobCandidate, SearchPreferences } from '../shared/types.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
const preferences: SearchPreferences = { description: 'Entry level electrical engineering', level: 'entry-level', location: 'NJ', maxApplications: 2, maxSearchRounds: 3, autoSubmit: true };
const job = (id: string): JobCandidate => ({ url: `https://employer.example/jobs/${id}`, title: 'Electrical Engineer I', company: 'Test', location: 'NJ', reason: 'New graduate', state: 'queued' });
async function setup() { const dir = await mkdtemp(join(tmpdir(), 'astra-queue-')); dirs.push(dir); const store = new Store(dir); await store.init(); return store; }
function runFor(url: string): ApplicationRun { return { id: crypto.randomUUID(), url, status: 'submitted', autoSubmit: true, events: [], questions: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }; }
it('applies immediately after discovery, deduplicates and stops at the attempt limit', async () => {
  const store = await setup(); const order: string[] = [];
  const runner = new CampaignRunner(store, {
    discover: async () => { order.push('search'); return [job('1'), job('1'), job('2'), job('3')]; },
    apply: async candidate => { order.push('apply'); const run = runFor(candidate.url); store.runs.push(run); return run; },
  });
  const campaign = await runner.start(preferences);
  await vi.waitFor(() => expect(runner.busy).toBe(false));
  expect(order).toEqual(['search', 'apply', 'apply']);
  expect(campaign.jobs.filter(j => j.state === 'submitted')).toHaveLength(2);
  expect(campaign.jobs.filter(j => j.state === 'queued')).toHaveLength(1);
  expect(campaign.status).toBe('completed');
});
it('continues after a failed employer form and never rediscovers attempted URLs', async () => {
  const store = await setup(); let attempt = 0;
  const runner = new CampaignRunner(store, {
    discover: async (_p, excluded) => { expect(excluded).toEqual([]); return [job('1'), job('2')]; },
    apply: async j => { const run = runFor(j.url); run.status = attempt++ === 0 ? 'failed' : 'submitted'; store.runs.push(run); return run; },
  });
  const c = await runner.start(preferences); await vi.waitFor(() => expect(runner.busy).toBe(false));
  expect(c.jobs.map(j => j.state)).toEqual(['failed', 'submitted']);
});
it('pauses an active run and resumes only untouched jobs', async () => {
  const store = await setup();
  const runner = new CampaignRunner(store, {
    discover: async () => [job('1'), job('2')],
    apply: async (j, _c, signal) => { const run = runFor(j.url); j.runId = run.id; store.runs.push(run); if (j.url.endsWith('/1')) await new Promise<void>(resolve => signal.addEventListener('abort', () => { run.status = 'cancelled'; resolve(); }, { once: true })); return run; },
  });
  const c = await runner.start(preferences); await vi.waitFor(() => expect(c.jobs[0]?.runId).toBeTruthy());
  await runner.stop(); expect(c.status).toBe('paused');
  await runner.resume(c.id); await vi.waitFor(() => expect(runner.busy).toBe(false));
  expect(store.runs).toHaveLength(2); expect(c.jobs.map(j => j.state)).toEqual(['failed', 'submitted']);
});
it('stops after three empty searches and persists restart state without replaying jobs', async () => {
  const store = await setup(); const discover = vi.fn(async () => []);
  const runner = new CampaignRunner(store, { discover, apply: async j => runFor(j.url) });
  const c = await runner.start({ ...preferences, maxSearchRounds: 10 }); await vi.waitFor(() => expect(runner.busy).toBe(false));
  expect(discover).toHaveBeenCalledTimes(3);
  c.status = 'running'; c.jobs = [{ ...job('old'), state: 'running' }, job('new')]; await store.save();
  const restored = new Store(store.root); await restored.init();
  expect(restored.campaigns[0].status).toBe('paused');
  expect(restored.campaigns[0].jobs.map(j => j.state)).toEqual(['failed', 'queued']);
});
it('removes tracking but preserves actual job identifiers and hash routes', () => {
  expect(canonicalUrl('https://company.example/job?gh_jid=42&utm_source=foo#detail')).toBe('https://company.example/job?gh_jid=42');
  expect(canonicalUrl('https://company.example/#/jobs/42')).toContain('#/jobs/42');
});

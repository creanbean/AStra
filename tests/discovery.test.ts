import { afterEach, expect, it, vi } from 'vitest';
import { discoverJobs } from '../server/discovery.js';
import { responses } from '../server/ai.js';
import type { SearchPreferences } from '../shared/types.js';
const prefs: SearchPreferences = { description: 'Electrical engineering solar controls', level: 'entry-level', location: 'New Jersey', maxApplications: 3, maxSearchRounds: 2, autoSubmit: true };
const output = (text: string, sources: string[] = []) => new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text, annotations: sources.map(url => ({ type: 'url_citation', url })) }] }] }), { status: 200 });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
it('queues only source-backed individual jobs and rejects fabricated, senior and duplicate URLs', async () => {
  vi.stubEnv('AI_API_KEY', 'fixture-key');
  const base = { title: 'Electrical Engineer I', company: 'Fixture', location: 'NJ', reason: 'New graduate, controls' };
  const urls = ['https://example.com/jobs/1', 'https://example.com/jobs/2', 'https://example.com/jobs/3'];
  const mock = vi.fn().mockResolvedValueOnce(output('Verified live job research', urls)).mockResolvedValueOnce(output(JSON.stringify({ jobs: [
    { ...base, url: urls[0] }, { ...base, url: urls[1], title: 'Senior Electrical Engineer' },
    { ...base, url: urls[2] }, { ...base, url: 'https://invented.example/fake' },
  ] })));
  vi.stubGlobal('fetch', mock);
  const result = await discoverJobs(prefs, [urls[2]], 1, new AbortController().signal);
  expect(result.map(j => j.url)).toEqual([urls[0]]);
  const request = JSON.parse(mock.mock.calls[0][1].body);
  expect(request.tools).toEqual([{ type: 'web_search' }]);
  expect(request.tool_choice).toBe('required');
  expect(JSON.parse(request.input)).toEqual({ preferences: prefs, round: 1, excludedUrls: [urls[2]] });
});
it('puts the JSON keyword in Responses input while preserving application fields', async () => {
  vi.stubEnv('AI_API_KEY', 'fixture-key');
  const mocked = vi.fn().mockResolvedValue(output('{"ok":true}'));
  vi.stubGlobal('fetch', mocked);
  const details = { url: 'https://example.com/job/1', controls: [{ label: 'Send my candidacy' }] };
  await responses('Choose a navigation action.', details, new AbortController().signal);
  const request = JSON.parse(mocked.mock.calls[0][1].body);
  expect(request.text).toEqual({ format: { type: 'json_object' } });
  expect(request.input).toMatch(/json/i);
  expect(JSON.parse(request.input)).toMatchObject(details);
});
it('reports API failures and incomplete output instead of silently fabricating a job queue', async () => {
  vi.stubEnv('AI_API_KEY', 'fixture-key');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 401 })));
  await expect(responses('test', {}, new AbortController().signal)).rejects.toThrow('HTTP 401');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'incomplete' }))));
  await expect(responses('test', {}, new AbortController().signal)).rejects.toThrow('incomplete');
});

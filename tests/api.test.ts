import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApp } from '../server/app.js';
import { emptyProfile } from '../shared/types.js';

let server: Server;
let origin: string;
let dir: string;
let close: () => Promise<void>;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'astra-api-'));
  const instance = await createApp(dir);
  close = instance.close;
  server = createServer(instance.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });

const json = (method: string, body: unknown) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

it('requires real profile details and an attached resume before starting', async () => {
  const response = await fetch(origin + '/api/runs', json('POST', { url: 'https://example.com/apply' }));
  expect(response.status).toBe(400);
  expect((await response.json()).error).toContain('resume');
});

it('rejects cross-origin mutation and non-JSON requests', async () => {
  const crossOrigin = await fetch(origin + '/api/profile', { ...json('PUT', emptyProfile), headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' } });
  expect(crossOrigin.status).toBe(403);
  const form = await fetch(origin + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'url=https://example.com' });
  expect(form.status).toBe(415);
});

it('saves profile and resume, preserves resume on profile updates, and guards local targets', async () => {
  const profile = { ...emptyProfile, firstName: 'Alex', lastName: 'Rivera', email: 'alex@example.com' };
  expect((await fetch(origin + '/api/profile', json('PUT', profile))).status).toBe(200);
  const form = new FormData();
  form.append('resume', new Blob(['Alex Rivera\nSoftware engineer with TypeScript experience.'], { type: 'text/plain' }), 'Resume.txt');
  const upload = await fetch(origin + '/api/resume', { method: 'POST', body: form });
  expect(upload.status).toBe(200);
  const uploaded = await upload.json();
  expect(uploaded.resume.name).toBe('Resume.txt');
  expect(uploaded.resume.text).toContain('TypeScript');
  expect(uploaded.resume.path).toBe('');
  const update = await fetch(origin + '/api/profile', json('PUT', { ...profile, city: 'New York', resume: { path: '/etc/passwd', text: 'untrusted' } }));
  expect((await update.json()).resume.text).toContain('TypeScript');
  const persisted = JSON.parse(await readFile(path.join(dir, 'profile.json'), 'utf8'));
  expect(persisted.resume.path.startsWith(dir)).toBe(true);
  const blocked = await fetch(origin + '/api/runs', json('POST', { url: 'http://127.0.0.1/private', autoSubmit: true }));
  expect(blocked.status).toBe(400);
  expect((await blocked.json()).error).toContain('private');
  expect(await (await fetch(origin + '/api/runs')).json()).toEqual([]);
});

it('rejects malformed and unreadable resume uploads without replacing a valid resume', async () => {
  for (const [name, contents] of [['bad.pdf', 'not a PDF'], ['empty.txt', '   ']]) {
    const form = new FormData();
    form.append('resume', new Blob([contents]), name);
    expect((await fetch(origin + '/api/resume', { method: 'POST', body: form })).status).toBe(400);
  }
  const profile = await (await fetch(origin + '/api/profile')).json();
  expect(profile.resume.name).toBe('Resume.txt');
});

it('extracts a real PDF resume and attaches its original filename metadata', async () => {
  const content = 'BT /F1 12 Tf 72 720 Td (Alex Rivera - Software Engineer) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const form = new FormData();
  form.append('resume', new Blob([pdf], { type: 'application/pdf' }), 'Resume.pdf');
  const response = await fetch(origin + '/api/resume', { method: 'POST', body: form });
  expect(response.status).toBe(200);
  const profile = await response.json();
  expect(profile.resume.name).toBe('Resume.pdf');
  expect(profile.resume.text).toContain('Alex Rivera - Software Engineer');
});

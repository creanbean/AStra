import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { CampaignRunner } from './campaign.js';
import { preferencesSchema, canonicalUrl } from './discovery.js';
import { Store } from './store.js';
import { assertPublicUrl } from './security.js';
import { runApplication } from './agent.js';
import { emptyProfile, type ApplicationRun, type Profile, type Campaign } from '../shared/types.js';

const strings = Object.fromEntries(Object.keys(emptyProfile).filter(key => key !== 'answers').map(key => [key, z.string().max(10000).default('')]));
const answerSchema = z.record(z.string().min(1).max(1000), z.string().max(10000)).refine(value => Object.keys(value).length <= 200, 'Too many answers.');
const profileSchema = z.object({ ...strings, answers: answerSchema.default({}) });
const runSchema = z.object({ url: z.string().url().max(4096), autoSubmit: z.boolean().default(true) });
type Waiter<T> = { promise: Promise<T>; resolve: (value: T) => void };
type ActiveRun = { id: string; controller: AbortController; answers?: Waiter<Record<string, string>>; submit?: Waiter<void>; task?: Promise<void> };
function deferred<T>(signal: AbortSignal): Waiter<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes, no) => {
    const onAbort = () => no(new Error('Run cancelled.'));
    resolve = value => { signal.removeEventListener('abort', onAbort); yes(value); };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return { promise, resolve };
}

export async function createApp(dataDir = process.env.ASTRA_DATA_DIR || '.astra') {
  const store = new Store(dataDir);
  await store.init();
  const app = express();
  app.disable('x-powered-by');
  const accessToken = process.env.ASTRA_ACCESS_TOKEN || '';
  const port = process.env.PORT || '3000';
  const allowedOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, 'http://localhost:5173', 'http://127.0.0.1:5173', ...(process.env.ASTRA_ALLOWED_ORIGINS || '').split(',').filter(Boolean)]);
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
      if (req.headers.origin && !allowedOrigins.has(req.headers.origin)) return res.status(403).json({ error: 'Origin not allowed.' });
      if (!accessToken && !['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: 'Local access only. Configure an access token before remote access.' });
      if (accessToken) {
        const supplied = Buffer.from((req.headers.authorization || '').replace(/^Bearer /, ''));
        const expected = Buffer.from(accessToken);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.status(401).json({ error: 'Access token required.' });
      }
      if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.path.endsWith('/resume') && !req.is('application/json')) return res.status(415).json({ error: 'Use application/json.' });
    }
    next();
  });
  app.use(express.json({ limit: '512kb' }));
  const publicProfile = (): Profile => ({ ...store.profile, resume: store.profile.resume ? { ...store.profile.resume, path: '' } : undefined });
  let active: ActiveRun | undefined;
  const getRun = (id: string) => {
    const run = store.runs.find(item => item.id === id);
    if (!run) throw Object.assign(new Error('Application not found.'), { status: 404 });
    return run;
  };
  app.get('/api/config', async (_req, res) => {
    let browserAvailable = true;
    try { await access(process.env.BROWSER_EXECUTABLE_PATH || '/usr/bin/chromium'); }
    catch { const { chromium } = await import('playwright'); try { await access(chromium.executablePath()); } catch { browserAvailable = false; } }
    let baseUrl = 'Invalid AI_BASE_URL';
    try { const url = new URL(process.env.AI_BASE_URL || 'https://api.openai.com/v1'); baseUrl = url.origin + url.pathname; } catch {}
    res.json({ aiConfigured: Boolean(process.env.AI_API_KEY), model: process.env.AI_MODEL || 'gpt-4.1-mini', baseUrl, browserAvailable, requiresAccessToken: Boolean(accessToken) });
  });
  app.get('/api/profile', (_req, res) => res.json(publicProfile()));
  app.put('/api/profile', async (req, res) => {
    const data = profileSchema.parse(req.body) as unknown as Profile;
    if (data.email && !z.email().safeParse(data.email).success) return res.status(400).json({ error: 'Enter a valid email address.' });
    store.profile = { ...data, resume: store.profile.resume };
    await store.save();
    res.json(publicProfile());
  });
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
  app.post('/api/resume', upload.single('resume'), async (req, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Choose a PDF, DOCX, or plain-text resume.' });
    const ext = path.extname(file.originalname).toLowerCase();
    let text = '';
    if (ext === '.pdf' && file.buffer.subarray(0, 5).toString() === '%PDF-') {
      const parser = new PDFParse({ data: file.buffer });
      try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
    } else if (ext === '.docx' && file.buffer.subarray(0, 2).toString() === 'PK') {
      text = (await mammoth.extractRawText({ buffer: file.buffer })).value;
    } else if (ext === '.txt') text = file.buffer.toString('utf8');
    else return res.status(400).json({ error: 'Resume must be a valid PDF, DOCX, or TXT file.' });
    if (!text.trim()) return res.status(400).json({ error: 'No readable text found. Use a text-based PDF or DOCX so the agent can read your experience.' });
    const filename = file.originalname.replace(/[^a-zA-Z0-9._ -]/g, '_').slice(-150);
    const target = path.join(store.root, 'resumes', randomUUID() + ext);
    await writeFile(target, file.buffer, { mode: 0o600 });
    // Existing running applications use an immutable profile snapshot.
    store.profile.resume = { path: target, name: filename, text: text.slice(0, 100000) };
    await store.save();
    res.json(publicProfile());
  });
  app.get('/api/runs', (_req, res) => res.json([...store.runs].reverse()));
  app.get('/api/runs/:id', (req, res) => res.json(getRun(req.params.id)));
  function requireProfile() {
    if (!store.profile.firstName || !store.profile.lastName || !store.profile.email || !store.profile.resume) throw new Error('Save your name, email, and resume before starting an application.');
  }
  async function beginRun(url: string, autoSubmit: boolean, campaign?: Campaign, parentSignal?: AbortSignal) {
    requireProfile();
    await assertPublicUrl(url);
    parentSignal?.throwIfAborted();
    if (active) throw new Error('An application is already active.');
    if (store.runs.some(r => canonicalUrl(r.url) === canonicalUrl(url))) throw new Error('This job already has an application attempt. Check its history before applying again.');
    const now = new Date().toISOString();
    const run: ApplicationRun = { id: randomUUID(), url, autoSubmit, campaignId: campaign?.id, searchPreferences: campaign?.preferences, status: 'queued', createdAt: now, updatedAt: now, events: [], questions: [] };
    const profile = structuredClone(store.profile);
    const control: ActiveRun = { id: run.id, controller: new AbortController() };
    active = control;
    const abort = () => control.controller.abort();
    parentSignal?.addEventListener('abort', abort, { once: true });
    if (parentSignal?.aborted) abort();
    store.runs.push(run);
    await mkdir(store.artifactDir(run.id), { recursive: true, mode: 0o700 });
    await store.save();
    const timer = setTimeout(() => control.controller.abort(new Error('Application exceeded the 30-minute limit.')), 30 * 60 * 1000);
    control.task = runApplication({
      run, profile, artifactDir: store.artifactDir(run.id), signal: control.controller.signal,
      onUpdate: async () => { run.updatedAt = new Date().toISOString(); await store.save(); },
      assertUrl: assertPublicUrl,
      waitForInput: () => { control.answers = deferred(control.controller.signal); return control.answers.promise; },
      waitForSubmit: () => { control.submit = deferred(control.controller.signal); return control.submit.promise; },
    }).catch(async error => {
      if (run.status !== 'submitted' && run.status !== 'cancelled') {
        run.status = control.controller.signal.aborted ? 'cancelled' : 'failed';
        run.result = error instanceof Error ? error.message : 'Application failed.';
      }
    }).finally(async () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abort);
      if (active?.id === run.id) active = undefined;
      run.updatedAt = new Date().toISOString();
      await store.save();
    });
    return { run, task: control.task };
  }
  const campaigns = new CampaignRunner(store, { apply: async (job, campaign, signal) => {
    const { run, task } = await beginRun(job.url, campaign.preferences.autoSubmit, campaign, signal);
    job.runId = run.id;
    await store.save();
    await task;
    return run;
  } });
  app.get('/api/campaigns', (_req, res) => res.json([...store.campaigns].reverse()));
  app.post('/api/campaigns', async (req, res) => {
    if (active || campaigns.busy) return res.status(409).json({ error: 'Finish or stop the current application campaign first.' });
    requireProfile();
    if (!process.env.AI_API_KEY) throw new Error('Set AI_API_KEY before starting automatic job discovery.');
    res.status(201).json(await campaigns.start(preferencesSchema.parse(req.body)));
  });
  app.post('/api/campaigns/:id/stop', async (req, res) => {
    if (!store.campaigns.some(c => c.id === req.params.id && c.status === 'running')) throw new Error('This campaign is not running.');
    await campaigns.stop();
    res.json(store.campaigns.find(c => c.id === req.params.id));
  });
  app.post('/api/campaigns/:id/resume', async (req, res) => {
    if (active || campaigns.busy) return res.status(409).json({ error: 'An application is already active.' });
    requireProfile();
    if (!process.env.AI_API_KEY) throw new Error('Set AI_API_KEY before resuming automatic discovery.');
    res.json(await campaigns.resume(req.params.id));
  });
  app.post('/api/runs', async (req, res) => {
    if (active || campaigns.busy) return res.status(409).json({ error: 'Finish or cancel the current application before starting another.' });
    const { url, autoSubmit } = runSchema.parse(req.body);
    const { run } = await beginRun(url, autoSubmit);
    res.status(201).json(run);
  });
  app.post('/api/runs/:id/answers', async (req, res) => {
    const run = getRun(req.params.id);
    const answers = z.object({ answers: answerSchema }).parse(req.body).answers;
    if (run.status !== 'needs_input' || active?.id !== run.id || !active.answers) return res.status(409).json({ error: 'This application is not waiting for answers.' });
    for (const question of run.questions) {
      const value = answers[question.key];
      if (question.required && !value?.trim()) return res.status(400).json({ error: `Answer the required question: ${question.label}` });
      if (question.options.length && value && !question.options.includes(value)) return res.status(400).json({ error: `Choose an available option for: ${question.label}` });
    }
    const waiter = active.answers;
    active.answers = undefined;
    // Run-specific consent and facts stay within this application. Reusable
    // answers are saved only when the applicant edits their profile.
    waiter.resolve(answers);
    res.json(run);
  });
  app.post('/api/runs/:id/submit', (req, res) => {
    const run = getRun(req.params.id);
    if (run.status !== 'ready_to_submit' || active?.id !== run.id || !active.submit) return res.status(409).json({ error: 'This application is not waiting for submission approval.' });
    active.submit.resolve();
    active.submit = undefined;
    res.json(run);
  });
  app.post('/api/runs/:id/cancel', async (req, res) => {
    const run = getRun(req.params.id);
    if (active?.id !== run.id) return res.status(409).json({ error: 'This application is no longer running.' });
    run.status = 'cancelled';
    run.result = 'Cancelled by you. Check the employer site if a submission was already in progress.';
    active.controller.abort();
    await store.save();
    res.json(run);
  });
  app.get('/api/runs/:id/screenshot', async (req, res) => {
    const run = getRun(req.params.id);
    const target = path.join(store.artifactDir(run.id), 'latest.png');
    try { await access(target); res.sendFile(target); } catch { res.status(404).json({ error: 'Screenshot is not available yet.' }); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use(express.static(path.resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/index.html')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof z.ZodError) return res.status(400).json({ error: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') });
    if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Resume must be under 10 MB.' : error.message });
    const status = (error as { status?: number }).status || 400;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Request failed.' });
  });
  return { app, store, close: async () => { await campaigns.stop(); const task = active?.task; active?.controller.abort(); if (task) await task; await store.save(); } };
}

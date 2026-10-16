import { createServer, type Server } from 'node:http';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express as ExpressApp } from 'express';
import multer from 'multer';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runApplication } from '../server/agent.js';
import { emptyProfile, type ApplicationRun, type BrowserAgentOptions, type Profile } from '../shared/types.js';

type Submission = { route: string; fields: Record<string, string>; filename?: string; file?: Buffer };
const submissions: Submission[] = [];
let server: Server;
let origin: string;
let temporaryDirectory: string;
let profile: Profile;

function document(body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture application</title>
    <style>body{font:16px sans-serif;max-width:720px;margin:40px}label,fieldset{display:block;margin:16px 0}input,select,button{padding:8px}button{margin:12px 0}[hidden]{display:none}</style>
    </head><body>${body}</body></html>`;
}

const identityFields = `
  <label>First name <input name="firstName" autocomplete="given-name" required></label>
  <label>Last name <input name="lastName" autocomplete="family-name" required></label>
  <label>Email address <input name="email" type="email" autocomplete="email" required></label>`;

function record(route: string, fields: Record<string, string>, file?: Express.Multer.File): void {
  submissions.push({ route, fields: { ...fields }, filename: file?.originalname, file: file?.buffer });
}

function fixture(): ExpressApp {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  const upload = multer({ storage: multer.memoryStorage() });

  let humanSolved = false;
  app.get('/human-check', (_req, res) => { humanSolved = false; res.send(document(`
    <div id="gate" data-sitekey="fixture">Human verification widget</div>
    <textarea name="g-recaptcha-response" hidden></textarea>
    <form method="post" action="/human-submit">${identityFields}<button>Submit application</button></form>
    <script>const poll=setInterval(async()=>{if((await (await fetch('/human-status')).json()).solved){
      document.querySelector('[name="g-recaptcha-response"]').value='user-completed-fixture';
      document.querySelector('#gate').remove();clearInterval(poll);}},50);</script>`)); });
  app.get('/human-status', (_req, res) => res.json({ solved: humanSolved }));
  app.post('/human-solve', (_req, res) => { humanSolved = true; res.json({ ok: true }); });
  app.post('/human-submit', (req, res) => { record('/human-submit', req.body); res.redirect(303, '/complete'); });

  app.get('/workflow/step-1', (_req, res) => res.send(document(`
    <h1>Apply for Software Engineer</h1><p>Step 1 of 2: Contact details</p>
    <form method="post" action="/workflow/step-1" enctype="multipart/form-data">
      ${identityFields}
      <label>Phone number <input name="phone" type="tel" required></label>
      <label>Resume <input name="resume" type="file" accept=".pdf" required></label>
      <button type="submit">Next</button>
    </form>`)));
  app.post('/workflow/step-1', upload.single('resume'), (req, res) => {
    record('/workflow/step-1', req.body, req.file);
    if (!req.body.firstName || !req.body.lastName || !req.body.email || !req.body.phone || !req.file) {
      res.status(422).send(document('<h1>Contact details are incomplete</h1>'));
      return;
    }
    res.redirect(303, '/workflow/step-2');
  });
  app.get('/workflow/step-2', (_req, res) => res.send(document(`
    <h1>Apply for Software Engineer</h1><p>Step 2 of 2: Eligibility</p>
    <form method="post" action="/workflow/step-2">
      <label>Years of professional experience
        <select name="experience" required><option value="">Please select</option><option value="0-2">0–2 years</option><option value="3-5">3–5 years</option><option value="6+">6 or more years</option></select>
      </label>
      <fieldset><legend>Are you legally authorized to work in the United States?</legend>
        <label><input type="radio" name="authorized" value="yes" required>Yes</label>
        <label><input type="radio" name="authorized" value="no" required>No</label>
      </fieldset>
      <label>Will you require visa sponsorship?
        <select name="sponsorship" required><option value="">Select an answer</option><option value="yes">Yes</option><option value="no">No</option></select>
      </label>
      <label><input name="consent" type="checkbox" value="yes" required>I consent to processing my application</label>
      <button type="submit">Submit application</button>
    </form>`)));
  app.post('/workflow/step-2', (req, res) => {
    record('/workflow/step-2', req.body);
    if (req.body.experience !== '3-5' || req.body.authorized !== 'yes' || req.body.sponsorship !== 'no' || req.body.consent !== 'yes') {
      res.status(422).send(document('<h1>Application validation failed</h1><p role="alert">Your eligibility answers are incomplete.</p>'));
      return;
    }
    res.redirect(303, '/complete');
  });

  app.get('/custom-dropdown', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1>
    <form method="post" action="/custom-dropdown">
      ${identityFields}
      <label id="authorization-label">Are you legally authorized to work in the United States?</label>
      <button type="button" id="authorization" role="combobox" aria-labelledby="authorization-label" aria-expanded="false" aria-controls="authorization-options" aria-required="true">Select an answer</button>
      <div id="authorization-options" role="listbox" aria-labelledby="authorization-label" hidden>
        <div role="option" tabindex="0" data-value="yes">Yes</div>
        <div role="option" tabindex="0" data-value="no">No</div>
      </div>
      <input name="authorized" id="authorization-value" type="hidden">
      <button type="submit">Submit application</button>
    </form>
    <script>
      const combo = document.getElementById('authorization');
      const list = document.getElementById('authorization-options');
      combo.addEventListener('click', () => { list.hidden = !list.hidden; combo.setAttribute('aria-expanded', String(!list.hidden)); });
      for (const option of list.children) option.addEventListener('click', () => {
        document.getElementById('authorization-value').value = option.dataset.value;
        combo.textContent = option.textContent; combo.setAttribute('aria-expanded', 'false');
        option.setAttribute('aria-selected', 'true'); list.hidden = true;
      });
    </script>`)));
  app.post('/custom-dropdown', (req, res) => {
    record('/custom-dropdown', req.body);
    if (req.body.authorized !== 'yes' || !req.body.email) {
      res.status(422).send(document('<h1>Application validation failed</h1>'));
      return;
    }
    res.redirect(303, '/complete');
  });

  app.get('/button-dropdown', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/button-dropdown">
      ${identityFields}
      <label id="button-authorization-label">Are you legally authorized to work in the United States?</label>
      <button type="button" id="button-authorization" aria-haspopup="listbox" aria-labelledby="button-authorization-label" aria-controls="button-options" aria-expanded="false" aria-required="true">Choose an answer</button>
      <div id="button-options" role="listbox" hidden><div role="option">Yes</div><div role="option">No</div></div>
      <input type="hidden" name="authorized" id="button-value">
      <button type="submit">Submit application</button>
    </form><script>
      const trigger=document.getElementById('button-authorization');
      const list=document.getElementById('button-options');
      trigger.addEventListener('click',()=>{list.hidden=!list.hidden;trigger.setAttribute('aria-expanded',String(!list.hidden));});
      for(const option of list.children)option.addEventListener('click',()=>{
        document.getElementById('button-value').value=option.textContent.toLowerCase();
        trigger.textContent=option.textContent;list.hidden=true;trigger.setAttribute('aria-expanded','false');
      });
    </script>`)));
  app.post('/button-dropdown', (req, res) => {
    record('/button-dropdown', req.body);
    if (req.body.authorized !== 'yes') return res.status(422).send(document('<p role="alert">Missing work authorization</p>'));
    res.redirect(303, '/complete');
  });

  app.get('/searchable-dropdown', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/searchable-dropdown">
      ${identityFields}
      <label id="search-label">Are you legally authorized to work in the United States?</label>
      <div data-field><input role="combobox" id="search-trigger" aria-labelledby="search-label" aria-controls="search-options" aria-required="true" aria-expanded="false" autocomplete="off">
        <input type="hidden" name="authorized" id="search-value">
        <div id="search-options" role="listbox" hidden><div role="option" aria-selected="false">Yes</div><div role="option" aria-selected="false">No</div></div>
      </div><button type="submit">Submit application</button>
    </form><script>
      const search=document.getElementById('search-trigger');
      const choices=document.getElementById('search-options');
      search.addEventListener('input',()=>{choices.hidden=!search.value;search.setAttribute('aria-expanded',String(!choices.hidden));});
      for (const option of choices.children) option.addEventListener('click',()=>{
        document.getElementById('search-value').value=option.textContent.toLowerCase();
        for(const item of choices.children)item.setAttribute('aria-selected',String(item===option));
        search.value='';choices.hidden=true;search.setAttribute('aria-expanded','false');
      });
    </script>`)));
  app.post('/searchable-dropdown', (req, res) => {
    record('/searchable-dropdown', req.body);
    if (req.body.authorized !== 'yes') return res.status(422).send(document('<p role="alert">Missing work authorization</p>'));
    res.redirect(303, '/complete');
  });

  app.get('/multi-select', (_req, res) => res.send(document(`
    <h1>Engineer application</h1>
    <form method="post" action="/multi-select">${identityFields}
      <label>Technical skills
        <select name="languages" multiple required>
          <option value="ts">TypeScript</option><option value="react">React</option><option value="py">Python</option>
        </select>
      </label><button type="submit">Submit application</button>
    </form>`)));
  app.post('/multi-select', (req, res) => {
    record('/multi-select', req.body);
    const answers = Array.isArray(req.body.languages) ? req.body.languages : [req.body.languages];
    if (!answers.includes('ts') || !answers.includes('react') || answers.includes('py')) return res.status(422).send(document('<p role="alert">Incorrect skills</p>'));
    res.redirect(303, '/complete');
  });

  app.get('/unsupported-multi', (_req, res) => res.send(document(`
    <h1>Engineer application</h1><form method="post" action="/unsupported-multi">${identityFields}
      <div role="listbox" aria-multiselectable="true" aria-required="true" aria-label="Available work shifts">
        <div role="option" aria-selected="false">Morning</div><div role="option" aria-selected="false">Evening</div>
      </div>
      <button type="submit">Submit application</button>
    </form>`)));
  app.post('/unsupported-multi', (req, res) => { record('/unsupported-multi', req.body); res.redirect(303, '/complete'); });

  app.get('/conditional-fields', (_req, res) => res.send(document(`
    <h1>Engineer application</h1><form method="post" action="/conditional-fields">${identityFields}
      <label>Country <select name="country" id="country" required>
        <option value="">Choose an answer</option><option value="United States">United States</option>
      </select></label>
      <div id="conditional"></div>
      <button type="submit">Submit application</button></form>
      <script>
        document.getElementById('country').addEventListener('change', () => {
          document.getElementById('conditional').innerHTML = '<label>City <input name="city" required></label>';
        });
      </script>`)));
  app.post('/conditional-fields', (req, res) => {
    record('/conditional-fields', req.body);
    if (req.body.country !== 'United States' || req.body.city !== 'New York') return res.status(422).send(document('<p role="alert">Location missing</p>'));
    res.redirect(303, '/complete');
  });

  app.get('/react-toggle', (_req, res) => res.send(document(`
    <h1>Engineer application</h1><form method="post" action="/react-toggle">${identityFields}
      <label id="react-label">Are you legally authorized to work in the United States?</label>
      <div data-field>
        <input role="combobox" id="react-select-input" aria-labelledby="react-label" aria-controls="portal-options" aria-required="true" aria-expanded="false" autocomplete="off">
        <button type="button" id="flyout" aria-label="Toggle flyout">▼</button>
        <input name="authorized" type="hidden" id="react-value">
      </div>
      <div id="portal-options" role="listbox" hidden><div role="option">Yes</div><div role="option">No</div></div>
      <button type="submit">Submit application</button></form>
      <script>
        const flyout=document.getElementById('flyout');
        const menu=document.getElementById('portal-options');
        flyout.addEventListener('click',()=>{menu.hidden=false;document.getElementById('react-select-input').setAttribute('aria-expanded','true');});
        for(const option of menu.children) option.addEventListener('click',()=>{
          document.getElementById('react-value').value=option.textContent.toLowerCase();
          document.getElementById('react-select-input').setAttribute('aria-expanded','false');
          menu.hidden=true;
        });
      </script>`)));
  app.post('/react-toggle', (req, res) => {
    record('/react-toggle', req.body);
    if (req.body.authorized !== 'yes') return res.status(422).send(document('<p role="alert">Missing authorization</p>'));
    res.redirect(303, '/complete');
  });

  app.get('/review', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/review">${identityFields}<button type="submit">Submit application</button></form>`)));
  app.post('/review', (req, res) => { record('/review', req.body); res.redirect(303, '/complete'); });

  app.get('/unknown-fact', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/unknown-fact">${identityFields}
      <label>Do you hold an active security clearance?
        <select name="clearance" required><option value="">Choose an answer</option><option value="yes">Yes</option><option value="no">No</option></select>
      </label><button type="submit">Submit application</button></form>`)));
  app.post('/unknown-fact', (req, res) => {
    record('/unknown-fact', req.body);
    if (req.body.clearance !== 'no') {
      res.status(422).send(document('<h1>Application validation failed</h1>'));
      return;
    }
    res.redirect(303, '/complete');
  });

  app.get('/rejected', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/rejected">${identityFields}<button type="submit">Submit application</button></form>`)));
  app.post('/rejected', (req, res) => {
    record('/rejected', req.body);
    res.status(422).send(document('<h1>Application cannot be accepted</h1><p role="alert">Your application was not submitted. This position has closed.</p>'));
  });
  app.get('/preexisting-confirmation', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><p>Thank you for applying through our hiring portal.</p>
    <form id="application" method="post" action="/preexisting-confirmation">${identityFields}<button type="submit">Submit application</button></form>
    <p id="submission-error" role="alert"></p>
    <script>
      document.getElementById('application').addEventListener('submit', async event => {
        event.preventDefault();
        const response = await fetch('/preexisting-confirmation', { method: 'POST', body: new URLSearchParams(new FormData(event.currentTarget)) });
        const result = await response.json();
        document.getElementById('submission-error').textContent = result.error;
      });
    </script>`)));
  app.post('/preexisting-confirmation', (req, res) => {
    record('/preexisting-confirmation', req.body);
    res.status(422).json({ error: 'The application could not be accepted because the position has closed.' });
  });
  app.get('/delayed-confirmation', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form id="application" method="post" action="/delayed-confirmation">${identityFields}<button type="submit">Submit application</button></form>
    <div id="confirmation" role="alert" aria-live="polite"></div>
    <script>
      document.getElementById('application').addEventListener('submit', async event => {
        event.preventDefault();
        const response = await fetch('/delayed-confirmation', { method: 'POST', body: new URLSearchParams(new FormData(event.currentTarget)) });
        if (response.ok) setTimeout(() => {
          document.getElementById('confirmation').textContent = 'Your application has been submitted successfully. Thank you for applying.';
        }, 4000);
      });
    </script>`)));
  app.post('/delayed-confirmation', (req, res) => {
    record('/delayed-confirmation', req.body);
    res.json({ accepted: true });
  });
  app.get('/ambiguous-final', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/ambiguous-final">${identityFields}<button type="submit">Review &amp; submit</button></form>`)));
  app.post('/ambiguous-final', (req, res) => { record('/ambiguous-final', req.body); res.redirect(303, '/complete'); });
  app.get('/embedded', (_req, res) => res.send(document(`
    <h1>Software Engineer opening</h1><p>Complete the embedded application below.</p>
    <iframe title="Job application" src="/embedded/form" style="width:100%;height:650px;border:0"></iframe>`)));
  app.get('/embedded/form', (_req, res) => res.send(document(`
    <h1>Candidate details</h1><form id="application" method="post" action="/embedded/submit">
      ${identityFields}<div id="address"></div><button type="submit">Submit application</button>
    </form><p id="confirmation" aria-live="polite"></p><p id="error" role="alert"></p>
    <script>
      const address = document.getElementById('address').attachShadow({ mode: 'open' });
      address.innerHTML = '<label>City <input name="city" required></label>';
      document.getElementById('application').addEventListener('submit', async event => {
        event.preventDefault();
        const fields = new URLSearchParams(new FormData(event.currentTarget));
        fields.set('city', address.querySelector('input').value);
        const response = await fetch('/embedded/submit', { method: 'POST', body: fields });
        const result = await response.json();
        document.getElementById(response.ok ? 'confirmation' : 'error').textContent = result.message;
      });
    </script>`)));
  app.post('/embedded/submit', (req, res) => {
    record('/embedded/submit', req.body);
    if (!req.body.firstName || !req.body.lastName || !req.body.email || req.body.city !== 'New York') {
      res.status(422).json({ message: 'The candidate details are incomplete.' });
      return;
    }
    res.json({ message: 'Your application has been successfully submitted.' });
  });
  app.get('/optional-demographic-defaults', (_req, res) => res.send(document(`
    <h1>Apply for Engineer</h1><form method="post" action="/optional-demographic-defaults">
      ${identityFields}
      <h2>Optional demographic survey</h2>
      <label>Gender
        <select name="gender"><option value="female" selected>Female</option><option value="male">Male</option><option value="nonbinary">Nonbinary</option></select>
      </label>
      <fieldset><legend>Are you a protected veteran?</legend>
        <label><input type="radio" name="veteran" value="yes" checked>Yes</label>
        <label><input type="radio" name="veteran" value="no">No</label>
      </fieldset>
      <label><input type="checkbox" name="disability" value="yes" checked>I have a disability</label>
      <button type="submit">Submit application</button>
    </form>`)));
  app.post('/optional-demographic-defaults', (req, res) => {
    record('/optional-demographic-defaults', req.body);
    res.redirect(303, '/complete');
  });
  app.get('/semantic-form', (_req, res) => res.send(document(`<h1>Electrical Engineer I</h1><p>Open role for new graduates in New Jersey.</p><form method="post" action="/semantic-submit">${identityFields}<label>What is your primary programming language?<select name="language" required><option value="">Select</option><option>TypeScript</option><option>Python</option></select></label><button type="button" onclick="this.form.submit()">Send my candidacy to the hiring team</button></form>`)));
  app.post('/semantic-submit', (req, res) => { record('/semantic-submit', req.body); res.redirect(303, '/complete'); });
  app.get('/complete', (_req, res) => res.send(document('<h1>Application submitted successfully</h1><p>Thank you for applying. Your application has been received.</p>')));
  return app;
}

async function application(path: string, overrides: Partial<BrowserAgentOptions> = {}) {
  const run: ApplicationRun = overrides.run ?? {
    id: crypto.randomUUID(), url: `${origin}${path}`, autoSubmit: true, status: 'queued',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], questions: [],
  };
  const updates: ApplicationRun[] = [];
  const controller = new AbortController();
  const options: BrowserAgentOptions = {
    run, profile: structuredClone(profile), artifactDir: join(temporaryDirectory, run.id), signal: controller.signal,
    onUpdate: async state => { updates.push(structuredClone(state)); },
    waitForInput: async () => { throw new Error(`Unexpected request for input: ${run.questions.map(question => question.label).join('; ')}`); },
    waitForSubmit: async () => { throw new Error('Unexpected review gate for an automatically submitted application'); },
    assertUrl: async url => { if (new URL(url).origin !== origin) throw new Error('Fixture attempted an external request'); },
    ...overrides,
  };
  // Browser errors should abort quickly and remain visible in assertion output.
  await runApplication(options);
  return { run, updates };
}

beforeAll(async () => {
  vi.stubEnv('AI_API_KEY', '');
  // Check the executable without reading the potentially large Chromium binary.
  if (await access('/usr/bin/chromium').then(() => true, () => false)) vi.stubEnv('BROWSER_EXECUTABLE_PATH', '/usr/bin/chromium');
  temporaryDirectory = await mkdtemp(join(tmpdir(), 'astra-browser-test-'));
  const resumePath = join(temporaryDirectory, 'Alex-Rivera-Resume.pdf');
  await writeFile(resumePath, '%PDF-1.4\n% Local upload fixture\nAlex Rivera\nSoftware Engineer\n%%EOF\n');
  profile = {
    ...emptyProfile, firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', phone: '+12025550123',
    city: 'New York', country: 'United States', yearsExperience: '4', workAuthorization: 'Yes', requiresSponsorship: 'No',
    skills: 'TypeScript, React, Node.js', answers: { 'I consent to processing my application': 'Yes' },
    resume: { path: resumePath, name: 'Alex-Rivera-Resume.pdf', text: 'Alex Rivera. Software engineer with 4 years of TypeScript experience.' },
  };
  server = createServer(fixture());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not acquire a port');
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(() => { submissions.length = 0; });

afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('browser application agent against a real local application server', () => {
  it('uses live-page fit checking and a semantic navigation decision for an unfamiliar final button', async () => {
    vi.stubEnv('AI_API_KEY', 'fixture-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.instructions.startsWith('You help an applicant')) return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ answer: 'TypeScript', evidence: 'TypeScript experience' }) }] }] }));
      const input = JSON.parse(request.input);
      const answer = request.instructions.startsWith('Check this job page')
        ? { matches: true, evidence: 'Open role for new graduates in New Jersey.', reason: 'Fits criteria' }
        : { index: input.controls.findIndex((c: {label:string}) => c.label === 'Send my candidacy to the hiring team'), kind: 'submit' };
      return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] }));
    });
    try {
      const run: ApplicationRun = { id: crypto.randomUUID(), url: origin + '/semantic-form', autoSubmit: true, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], questions: [], searchPreferences: { description: 'Electrical engineering', level: 'entry-level', location: 'New Jersey', maxApplications: 1, maxSearchRounds: 1, autoSubmit: true } };
      const result = await application('/semantic-form', { run });
      expect(result.run.status, JSON.stringify(run.events)).toBe('submitted');
      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(submissions).toHaveLength(1);
      expect(submissions[0].fields.email).toBe(profile.email);
      expect(submissions[0].fields.language).toBe('TypeScript');
    } finally { fetchSpy.mockRestore(); vi.stubEnv('AI_API_KEY', ''); }
  });

  it('pauses for a human challenge and resumes the same browser session to submission', async () => {
    const waitForInput = vi.fn(async () => {
      expect(submissions).toHaveLength(0);
      await fetch(origin + '/human-solve', { method: 'POST' });
      await new Promise(resolve => setTimeout(resolve, 250));
      return { __challenge: 'Continue' };
    });
    const { run } = await application('/human-check', { waitForInput });
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(waitForInput).toHaveBeenCalledTimes(1);
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.email).toBe(profile.email);
  });

  it('submits a complete multistep application with the actual resume, dropdowns, radios, and consent', async () => {
    const { run, updates } = await application('/workflow/step-1');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions.map(submission => submission.route)).toEqual(['/workflow/step-1', '/workflow/step-2']);
    expect(submissions[0].fields).toEqual({ firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', phone: '+12025550123' });
    expect(submissions[0].filename).toBe('Alex-Rivera-Resume.pdf');
    expect(submissions[0].file).toEqual(await readFile(profile.resume!.path));
    expect(submissions[1].fields).toEqual({ experience: '3-5', authorized: 'yes', sponsorship: 'no', consent: 'yes' });
    expect(updates.some(update => update.status === 'running')).toBe(true);
  });

  it('selects a custom ARIA combobox answer and actually submits it', async () => {
    const { run } = await application('/custom-dropdown');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields).toMatchObject({ firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', authorized: 'yes' });
  });

  it('handles a required button dropdown with aria-haspopup but no combobox role', async () => {
    const { run } = await application('/button-dropdown');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.authorized).toBe('yes');
  });

  it('fills searchable options and verifies a choice even when the search input clears', async () => {
    const { run } = await application('/searchable-dropdown');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.authorized).toBe('yes');
  });

  it('selects and verifies multiple native options from explicit saved applicant facts', async () => {
    const candidate = structuredClone(profile);
    candidate.answers['Technical skills'] = 'TypeScript; React';
    const { run } = await application('/multi-select', { profile: candidate });
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(run.compatibility?.status).toBe('compatible');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.languages).toEqual(['ts', 'react']);
  });

  it('detects unsupported required widgets and never auto-submits campaign applications', async () => {
    const run: ApplicationRun = {
      id: crypto.randomUUID(), url: `${origin}/unsupported-multi`, campaignId: 'fixture-campaign',
      autoSubmit: true, status: 'queued', createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), events: [], questions: [],
    };
    const result = await application('/unsupported-multi', { run });
    expect(result.run.status).toBe('failed');
    expect(result.run.compatibility?.status).toBe('needs_review');
    expect(result.run.compatibility?.issues.some(issue => /Specialized selection control/.test(issue))).toBe(true);
    expect(submissions).toHaveLength(0);
  });

  it('detects conditionally injected required fields before submission', async () => {
    const { run } = await application('/conditional-fields');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.city).toBe('New York');
  });

  it('opens portal-rendered dropdowns through a sibling React-style toggle', async () => {
    const { run } = await application('/react-toggle');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.authorized).toBe('yes');
  });

  it('waits for approval in review mode before posting the final application', async () => {
    const run: ApplicationRun = {
      id: crypto.randomUUID(), url: `${origin}/review`, autoSubmit: false, status: 'queued',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], questions: [],
    };
    let resolveApproval!: () => void;
    let reportReady!: () => void;
    const approval = new Promise<void>(resolve => { resolveApproval = resolve; });
    const ready = new Promise<void>(resolve => { reportReady = resolve; });
    const waitForSubmit = vi.fn(async () => {
      expect(run.status).toBe('ready_to_submit');
      expect(submissions).toHaveLength(0);
      reportReady();
      await approval;
    });
    const task = application('/review', { run, waitForSubmit });
    await Promise.race([ready, task.then(result => { throw new Error(`Agent exited before review: ${JSON.stringify(result.run.events)}`); })]);
    expect(submissions).toHaveLength(0);
    resolveApproval();
    const result = await task;
    expect(waitForSubmit).toHaveBeenCalledTimes(1);
    expect(result.run.status, JSON.stringify(result.run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.email).toBe('alex.rivera@example.com');
  });

  it('asks for missing factual information and resumes using the supplied answer', async () => {
    const run: ApplicationRun = {
      id: crypto.randomUUID(), url: `${origin}/unknown-fact`, autoSubmit: true, status: 'queued',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], questions: [],
    };
    const waitForInput = vi.fn(async () => {
      expect(run.status).toBe('needs_input');
      expect(submissions).toHaveLength(0);
      const question = run.questions.find(question => /security clearance/i.test(question.label));
      expect(question).toBeDefined();
      expect(question!.options).toContain('No');
      return { [question!.key]: 'No' };
    });
    const result = await application('/unknown-fact', { run, waitForInput });
    expect(waitForInput).toHaveBeenCalledTimes(1);
    expect(result.run.status, JSON.stringify(result.run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.clearance).toBe('no');
  });

  it('does not report success when the server rejects the final POST', async () => {
    const { run, updates } = await application('/rejected');
    expect(submissions).toHaveLength(1);
    expect(run.status, JSON.stringify(run.events)).toBe('failed');
    expect(updates.some(update => update.status === 'submitted')).toBe(false);
  });

  it('does not accept preexisting thank-you copy as confirmation of a rejected same-page submission', async () => {
    const { run, updates } = await application('/preexisting-confirmation');
    expect(submissions).toHaveLength(1);
    expect(run.status, JSON.stringify(run.events)).toBe('failed');
    expect(updates.some(update => update.status === 'submitted')).toBe(false);
  });

  it('waits for delayed confirmation without posting an enabled final-submit button twice', async () => {
    const { run } = await application('/delayed-confirmation');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields.email).toBe('alex.rivera@example.com');
  });

  it('treats Review & submit as a final action that requires approval in review mode', async () => {
    const run: ApplicationRun = {
      id: crypto.randomUUID(), url: `${origin}/ambiguous-final`, autoSubmit: false, status: 'queued',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], questions: [],
    };
    let resolveApproval!: () => void;
    let reportReady!: () => void;
    const approval = new Promise<void>(resolve => { resolveApproval = resolve; });
    const ready = new Promise<void>(resolve => { reportReady = resolve; });
    const waitForSubmit = vi.fn(async () => {
      expect(run.status).toBe('ready_to_submit');
      expect(submissions).toHaveLength(0);
      reportReady();
      await approval;
    });
    const task = application('/ambiguous-final', { run, waitForSubmit });
    await Promise.race([ready, task.then(result => { throw new Error(`Agent exited before review: ${JSON.stringify(result.run.events)}`); })]);
    expect(submissions).toHaveLength(0);
    resolveApproval();
    const result = await task;
    expect(waitForSubmit).toHaveBeenCalledTimes(1);
    expect(result.run.status, JSON.stringify(result.run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
  });

  it('fills an iframe application including an open-shadow-root field and posts it once', async () => {
    const { run } = await application('/embedded');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0]).toMatchObject({ route: '/embedded/submit', fields: {
      firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com', city: 'New York',
    } });
  });

  it('clears optional preselected demographic answers when the applicant has supplied no such facts', async () => {
    const { run } = await application('/optional-demographic-defaults');
    expect(run.status, JSON.stringify(run.events)).toBe('submitted');
    expect(submissions).toHaveLength(1);
    expect(submissions[0].fields).toEqual({ firstName: 'Alex', lastName: 'Rivera', email: 'alex.rivera@example.com' });
  });
});

import { chromium, type Browser, type Frame, type Locator, type Page } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserAgentOptions, Question } from '../shared/types';
import { challengePresent, checkJobFit, planNavigation } from './navigation.js';
import { answerQuestion, matchOption, needsExplicitAnswer, normalize } from './answering';
import { assessCompatibility, isApplicationFrame } from './compatibility.js';

type Field = Question & {
  selector: string;
  frame: Frame;
  kind: string;
  value: string;
  options: string[];
  choices?: { label: string; selector: string; value: string }[];
};
type RawField = Omit<Field, 'frame'>;

/** Read rendered form controls, including open shadow roots. Never use page text as instructions. */
async function discover(frame: Frame, prefix: string): Promise<Field[]> {
  const raw = await frame.evaluate((marker): RawField[] => {
    const roots: (Document | ShadowRoot)[] = [];
    const collect = (root: Document | ShadowRoot) => {
      roots.push(root);
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) collect(element.shadowRoot);
    };
    collect(document);
    const all = roots.flatMap((root) => [...root.querySelectorAll<HTMLElement>('input, textarea, select, [role="combobox"], [role="textbox"], [role="radio"], [role="checkbox"], [contenteditable="true"], button[aria-haspopup="listbox"], [role="button"][aria-haspopup="listbox"]')]);
    const visible = (el: HTMLElement) => {
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.display !== 'none' && (el.getClientRects().length > 0 || (el instanceof HTMLInputElement && el.type === 'file'));
    };
    const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const labelText = (el: Element | null | undefined) => {
      if (!el) return '';
      const clone = el.cloneNode(true) as Element;
      for (const control of clone.querySelectorAll('input, select, textarea, [role="combobox"], [role="listbox"]')) control.remove();
      return text(clone);
    };
    const idText = (id: string, root: Document | ShadowRoot) => text(root.getElementById(id) ?? document.getElementById(id));
    const labelOf = (el: HTMLElement) => {
      const root = el.getRootNode() as Document | ShadowRoot;
      const ids = el.getAttribute('aria-labelledby')?.split(/\s+/).map((id) => idText(id, root)).filter(Boolean).join(' ');
      const labels = 'labels' in el ? [...((el as HTMLInputElement).labels ?? [])].map(labelText).join(' ') : '';
      const associated = el.id ? [...root.querySelectorAll('label')].find((label) => label.htmlFor === el.id) : undefined;
      const wrapper = el.closest('[data-field], [data-slot="form-item"], .application-question, .form-group, .field, .question');
      const nearby = wrapper?.querySelector('label, [data-slot="form-label"], .field-label, .question-label');
      const sibling = el.previousElementSibling?.matches('label, span') ? el.previousElementSibling : null;
      return (el.getAttribute('aria-label') || ids || labels || labelText(associated) || labelText(el.closest('label')) || labelText(nearby) || labelText(sibling) || el.getAttribute('placeholder') || el.getAttribute('name') || el.id || '').replace(/\s*\*\s*$/, '').trim().slice(0, 300);
    };
    let counter = 0;
    const tag = (el: HTMLElement) => {
      if (!el.getAttribute('data-astra-control')?.startsWith(marker)) el.setAttribute('data-astra-control', `${marker}-${++counter}-${Math.random().toString(36).slice(2, 8)}`);
      return `[data-astra-control="${el.getAttribute('data-astra-control')}"]`;
    };
    const seen = new Set<HTMLElement>();
    const results: RawField[] = [];
    for (const el of all) {
      if (seen.has(el) || !visible(el) || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true' || (el.hasAttribute('readonly') && el.getAttribute('role') !== 'combobox' && el.getAttribute('aria-haspopup') !== 'listbox')) continue;
      if (el instanceof HTMLInputElement && ['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) continue;
      if (el.closest('[role="combobox"]') && el.getAttribute('role') !== 'combobox') continue;
      const role = el.getAttribute('role');
      const kind = el instanceof HTMLSelectElement ? (el.multiple ? 'select-multiple' : 'select') : (role === 'combobox' || el.getAttribute('aria-haspopup') === 'listbox') ? 'combobox' : el instanceof HTMLInputElement ? el.type : role || (el.isContentEditable ? 'contenteditable' : 'textarea');
      let label = labelOf(el);
      const container = el.closest('fieldset, [role="radiogroup"], [role="group"]');
      const required = el.hasAttribute('required') || el.getAttribute('aria-required') === 'true' || (kind === 'radio' && !!container?.querySelector('input[type="radio"][required], [role="radio"][aria-required="true"]')) || (container?.getAttribute('aria-required') === 'true');
      let options: string[] = [];
      let choices: RawField['choices'];
      let value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? el.value : el.getAttribute('aria-valuetext') || el.textContent?.trim() || '';
      if (kind === 'radio') {
        const name = el.getAttribute('name');
        const members = all.filter((candidate) => candidate instanceof HTMLInputElement && candidate.type === 'radio' && visible(candidate) && (name ? candidate.name === name && candidate.getRootNode() === el.getRootNode() : container ? container.contains(candidate) : candidate === el));
        for (const member of members) seen.add(member);
        label = text(container?.querySelector('legend')) || container?.getAttribute('aria-label') || (container?.getAttribute('aria-labelledby') ? idText(container.getAttribute('aria-labelledby')!, el.getRootNode() as Document | ShadowRoot) : '') || label;
        choices = members.map((member) => ({ label: labelOf(member) || member.getAttribute('value') || '', selector: tag(member), value: member.getAttribute('value') || '' }));
        options = choices.map((choice) => choice.label);
        value = members.some((member) => (member as HTMLInputElement).checked) ? labelOf(members.find((member) => (member as HTMLInputElement).checked)!) : '';
      } else if (role === 'radio') {
        const members = container ? all.filter((member) => member.getAttribute('role') === 'radio' && container.contains(member)) : [el];
        for (const member of members) seen.add(member);
        label = text(container?.querySelector('legend')) || container?.getAttribute('aria-label') || label;
        choices = members.map((member) => ({ label: labelOf(member) || text(member), selector: tag(member), value: text(member) }));
        options = choices.map((choice) => choice.label);
        value = choices.find((choice) => members.find((member) => member.getAttribute('data-astra-control') === choice.selector.match(/"([^\"]+)"/)?.[1])?.getAttribute('aria-checked') === 'true')?.label || '';
      } else if (kind === 'select' || kind === 'select-multiple') {
        options = [...(el as HTMLSelectElement).options].filter((option) => !option.disabled && option.value !== '' && !/^(select|choose|please select|please choose)(\b|\.)/i.test(option.label)).map((option) => option.label.trim());
        choices = [...(el as HTMLSelectElement).options].map((option) => ({ label: option.label.trim(), value: option.value, selector: '' }));
      } else if (kind === 'checkbox') {
        options = ['Yes', 'No'];
        value = el instanceof HTMLInputElement ? (el.checked ? 'Yes' : 'No') : el.getAttribute('aria-checked') === 'true' ? 'Yes' : 'No';
      } else if (kind === 'combobox') {
        const controlled = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        const box = controlled ? (el.getRootNode() as Document | ShadowRoot).getElementById(controlled) || document.getElementById(controlled) : undefined;
        options = box ? [...box.querySelectorAll('[role="option"]')].map(text).filter(Boolean) : [];
        if (el instanceof HTMLInputElement) value = el.value;
      }
      if (!label) label = `${kind} field ${results.length + 1}`;
      const name = el.getAttribute('name') || el.id || label;
      const key = `${name}:${label}`.replace(/\s+/g, ' ').slice(0, 300);
      const section = el.closest('fieldset, section, [role="group"], [role="radiogroup"]');
      const context = section ? text(section).slice(0, 1000) : '';
      results.push({ context, key, label, type: kind, kind, required, options, value, choices, selector: tag(el) });
    }
    return results;
  }, prefix);
  return raw.map((field) => ({ ...field, frame }));
}

/** Visible options in the open popup. Many ATS menus portal their choices outside the trigger. */
const dropdownOptionSelector = '[role="option"], [role="menuitemradio"], .select2-results__option, .choices__item--choice, .ant-select-item-option, [data-automation-id="menuItem"], [role="listbox"] li, [role="listbox"] [data-value], [data-radix-select-viewport] [data-radix-collection-item]';

async function visibleDropdownChoices(field: Field): Promise<{ label: string; locator: Locator }[]> {
  const trigger = field.frame.locator(field.selector);
  const controlled = await trigger.getAttribute('aria-controls') || await trigger.getAttribute('aria-owns');
  const roots: Locator[] = [];
  if (controlled) roots.push(field.frame.locator('[id="' + controlled.replace(/"/g, '\\"') + '"]'));
  // Read open listbox/menu overlays first, even when framework portals have no
  // aria-controls relationship. Only fall back to the body when nothing is exposed.
  roots.push(field.frame.locator('[role="listbox"]:visible, .select2-results:visible, .choices__list--dropdown:visible, .ant-select-dropdown:visible, [data-automation-id="menuContainer"]:visible'));
  roots.push(field.frame.locator('body'));
  for (const root of roots) {
    const options = root.locator(dropdownOptionSelector);
    const found: { label: string; locator: Locator }[] = [];
    for (let i = 0, count = Math.min(await options.count(), 120); i < count; i++) {
      const option = options.nth(i);
      if (!await option.isVisible().catch(() => false)) continue;
      const label = ((await option.getAttribute('aria-label')) || await option.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      if (label && !found.some((item) => normalize(item.label) === normalize(label))) found.push({ label, locator: option });
    }
    if (found.length) return found;
  }
  return [];
}

async function customOptions(field: Field): Promise<void> {
  const locator = field.frame.locator(field.selector);
  let available = await visibleDropdownChoices(field);
  if (!available.length) {
    await locator.click({ timeout: 5_000 });
    available = await visibleDropdownChoices(field);
  }
  if (!available.length) {
    // React-select and some Greenhouse widgets open via a sibling chevron.
    const parent = locator.locator('xpath=..');
    const toggle = parent.locator('button[aria-label*="Toggle"], button[aria-label*="Open"], button[aria-label*="Show"], [aria-label="Toggle flyout"]');
    if (await toggle.count()) {
      await toggle.first().click({ timeout: 3_000 });
      await field.frame.page().waitForTimeout(200);
      available = await visibleDropdownChoices(field);
    }
  }
  // Leave the popup open; some non-native menus do not implement Escape,
  // and clicking their trigger a second time closes it instead of selecting.
  field.options = available.map((option) => option.label);
}

/** Multiple answers are permitted only when grounded in saved applicant facts. */
function multipleAnswers(field: Field, profile: BrowserAgentOptions['profile']): string[] {
  const direct = profile.answers[field.key] ?? profile.answers[field.label] ??
    Object.entries(profile.answers).find(([key]) => normalize(key) === normalize(field.label))?.[1];
  const isSkills = /\b(skill|technical|programming language|technology|framework|tool)s?\b/i.test(field.label);
  const raw = direct || (isSkills ? profile.skills : '');
  if (!raw?.trim()) return [];
  let inputs: string[];
  try {
    const parsed: unknown = JSON.parse(raw);
    inputs = Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed as string[] : [raw];
  } catch { inputs = [raw]; }
  if (inputs.length === 1 && !matchOption(inputs[0], field.options)) inputs = inputs[0].split(/[;,\n]/);
  const matched = inputs.map((input) => matchOption(input.trim(), field.options));
  if (direct && matched.some((item) => !item)) return [];
  return [...new Set(matched.filter((item): item is string => !!item))];
}

async function fillField(field: Field, answer: string): Promise<void> {
  const locator = field.frame.locator(field.selector);
  if (field.kind === 'select-multiple') {
    const labels = answer.split(';').map((value) => value.trim()).filter(Boolean);
    const values = labels.map((label) => field.choices?.find((choice) => choice.label === label)?.value);
    if (!labels.length || values.some((value) => value === undefined)) throw new Error('Multiple choice answers do not match offered options.');
    await locator.selectOption(values as string[]);
  } else if (field.kind === 'select') {
    const choice = field.choices?.find((candidate) => candidate.label === answer);
    if (!choice) throw new Error('The requested select choice is no longer available.');
    await locator.selectOption({ value: choice.value });
  } else if (field.kind === 'radio') {
    const choice = field.choices?.find((candidate) => candidate.label === answer);
    if (!choice) throw new Error('The requested radio choice is no longer available.');
    const member = field.frame.locator(choice.selector);
    if (await member.getAttribute('role') === 'radio') await member.click();
    else await member.check();
  } else if (field.kind === 'checkbox') {
    const checked = /^(yes|true|1)$/i.test(answer.trim());
    if (await locator.getAttribute('role') === 'checkbox') {
      if ((await locator.getAttribute('aria-checked') === 'true') !== checked) await locator.click();
    } else await locator.setChecked(checked);
  } else if (field.kind === 'combobox') {
    let choices = await visibleDropdownChoices(field);
    if (!choices.length) {
      await customOptions(field);
      choices = await visibleDropdownChoices(field);
    }
    let matching = choices.filter((candidate) => normalize(candidate.label) === normalize(answer));
    if (matching.length !== 1 && await locator.evaluate((element) => element.tagName.toLowerCase()) === 'input') {
      // Searchable combos expose choices only after typing the proposed answer.
      await locator.fill(answer);
      await field.frame.page().waitForTimeout(200);
      choices = await visibleDropdownChoices(field);
      matching = choices.filter((candidate) => normalize(candidate.label) === normalize(answer));
    }
    if (matching.length !== 1) {
      // Async portals can populate after a network request. Do not use positional guesses.
      for (let retry = 0; retry < 5 && matching.length !== 1; retry++) {
        await field.frame.page().waitForTimeout(250);
        choices = await visibleDropdownChoices(field);
        matching = choices.filter((candidate) => normalize(candidate.label) === normalize(answer));
      }
    }
    if (matching.length !== 1) throw new Error('The custom dropdown did not expose one unambiguous matching option.');
    await matching[0].locator.click();
  } else {
    await locator.fill(answer);
    await locator.press('Tab').catch(() => {});
  }
}

/** Verify the rendered control, not just whether a fill action returned without error. */
async function hasRenderedAnswer(field: Field, answer: string): Promise<boolean> {
  try {
    const locator = field.frame.locator(field.selector);
    if (field.kind === 'file') return locator.evaluate(el => !!(el as HTMLInputElement).files?.length);
    if (field.kind === 'select-multiple') {
      const labels = answer.split(';').map((value) => value.trim()).filter(Boolean);
      const values = labels.map((label) => field.choices?.find((choice) => choice.label === label)?.value);
      if (!values.length || values.some((value) => value === undefined)) return false;
      const selected = await locator.evaluate((el) => [...(el as HTMLSelectElement).selectedOptions].map((option) => option.value));
      return selected.length === values.length && values.every((value) => selected.includes(value!));
    }
    if (field.kind === 'select') {
      const choice = field.choices?.find(c => c.label === answer);
      return !!choice && await locator.inputValue() === choice.value;
    }
    if (field.kind === 'radio') {
      const choice = field.choices?.find(c => c.label === answer);
      if (!choice) return false;
      const option = field.frame.locator(choice.selector);
      return await option.getAttribute('role') === 'radio' ? await option.getAttribute('aria-checked') === 'true' : await option.isChecked();
    }
    if (field.kind === 'checkbox') {
      const expected = /^(yes|true|1)$/i.test(answer.trim());
      const actual = await locator.getAttribute('role') === 'checkbox'
        ? await locator.getAttribute('aria-checked') === 'true' : await locator.isChecked();
      return actual === expected;
    }
    if (field.kind === 'combobox') {
      const values = await locator.evaluate((el) => {
        const scope = el.closest('fieldset, [data-field], [data-slot="form-item"], [role="group"]') || el.parentElement;
        const controlled = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
        const listbox = controlled ? el.ownerDocument.getElementById(controlled) : null;
        const selected = [...(listbox?.querySelectorAll<HTMLElement>('[aria-selected="true"], [data-state="checked"], [data-selected="true"]') || [])]
          .map((item) => item.getAttribute('aria-label') || item.textContent || '');
        const hidden = [...(scope?.querySelectorAll<HTMLInputElement>('input[type="hidden"]') || [])].map((item) => item.value);
        const direct = el instanceof HTMLInputElement ? el.value : el.getAttribute('aria-valuetext') || el.textContent || '';
        return [direct, ...selected, ...hidden];
      });
      return values.some((value) => normalize(value) === normalize(answer));
    }
    const actual = await locator.evaluate(el => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value : el.getAttribute('aria-valuetext') || el.textContent || '');
    return normalize(actual) === normalize(answer);
  } catch { return false; }
}

async function clearOptionalDefault(field: Field): Promise<void> {
  if (field.kind === 'select') {
    await field.frame.locator(field.selector).evaluate((element) => {
      (element as HTMLSelectElement).selectedIndex = -1;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    });
  } else if (field.kind === 'radio') {
    for (const choice of field.choices ?? []) {
      const member = field.frame.locator(choice.selector);
      if (await member.getAttribute('role') === 'radio') throw new Error('This custom radio default requires your explicit answer.');
      await member.evaluate((element) => {
        (element as HTMLInputElement).checked = false;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  } else if (field.kind === 'checkbox') await fillField(field, 'No');
  else if (needsExplicitAnswer(field.label) && ['text', 'textarea', 'date', 'number'].includes(field.kind)) await field.frame.locator(field.selector).fill('');
}

async function visibleText(page: Page): Promise<string> {
  const text = await Promise.all(page.frames().map((frame) => frame.locator('body').innerText({ timeout: 3_000 }).catch(() => '')));
  return text.join('\n');
}

const successPattern = /\b(?:your application (?:has been |was )?(?:successfully )?(?:submitted|received)|application (?:successfully )?submitted|thank you for (?:applying|your application)|thanks for (?:applying|your application)|we (?:have |successfully )?received your application|application complete|application sent successfully)\b/i;

const negativeSubmission = /(?:application (?:was |has been |is )?(?:not submitted|not received|rejected|failed|cannot be accepted)|(?:unable|failed) to submit|submission (?:failed|error)|position (?:has )?closed)/i;

async function confirmationEvidence(page: Page): Promise<string[]> {
  const text = await visibleText(page);
  if (negativeSubmission.test(text) || (await validationErrors(page)).length) return [];
  return text.split('\n').filter((line) => successPattern.test(line)).map((line) => normalize(line));
}

async function freshConfirmation(page: Page, before: string[], beforeUrl: string): Promise<boolean> {
  const evidence = await confirmationEvidence(page);
  if (!evidence.length) return false;
  if (evidence.some((line) => !before.includes(line))) return true;
  // A fresh navigation to a confirmation page can repeat introductory wording;
  // require the application controls to be gone to avoid accepting a rejected form.
  return page.url() !== beforeUrl && !await page.locator('input:not([type="hidden"]), select, textarea, [role="combobox"]').count();
}

async function findAction(page: Page, preferApply = false): Promise<{ locator: Locator; kind: 'next' | 'submit' | 'apply'; label: string } | undefined> {
  const candidates: { locator: Locator; kind: 'next' | 'submit' | 'apply'; label: string; score: number }[] = [];
  for (const frame of page.frames()) {
    const controls = frame.locator('button, input[type="submit"], input[type="button"], a, [role="button"]');
    for (let i = 0, count = await controls.count(); i < Math.min(count, 200); i++) {
      const locator = controls.nth(i);
      if (!await locator.isVisible() || !await locator.isEnabled() || await locator.getAttribute('aria-disabled') === 'true') continue;
      const label = ((await locator.getAttribute('aria-label')) || (await locator.getAttribute('value')) || (await locator.innerText().catch(() => ''))).replace(/\s+/g, ' ').trim();
      if (/^(next(?: step)?|continue(?: application| to (?:the )?next step)?|save (?:and|&) continue|review(?: application)?|proceed)$/i.test(label)) candidates.push({ locator, kind: 'next', label, score: 3 });
      else if (/^(submit(?: (?:my |your )?application)?|send application|complete application|finish(?: application)?|save (?:and|&) submit|(?:confirm|review) (?:and|&) submit|submit now)$/i.test(label)) candidates.push({ locator, kind: 'submit', label, score: 2 });
      else if (/^(apply(?: now| for (?:this )?(?:job|position))?|start application|begin application)$/i.test(label)) candidates.push({ locator, kind: 'apply', label, score: 1 });
    }
  }
  return candidates.sort((a, b) => (preferApply ? Number(b.kind === 'apply') - Number(a.kind === 'apply') : 0) || b.score - a.score)[0];
}

async function validationErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  for (const frame of page.frames()) {
    const found = await frame.evaluate(({ positive, negative }) => {
      const invalid = [...document.querySelectorAll<HTMLInputElement>('input, select, textarea')].filter((el) => el.getClientRects().length && !el.validity.valid);
      const described = [...document.querySelectorAll('[role="alert"], .field-error, .error-message, [data-error], [aria-invalid="true"]')].filter((el) => el.getClientRects().length).filter((el) => {
        const text = el.textContent?.trim() || '';
        const onlyAlert = el.getAttribute('role') === 'alert' && !el.matches('.field-error, .error-message, [data-error], [aria-invalid="true"]');
        return !onlyAlert || !new RegExp(positive, 'i').test(text) || new RegExp(negative, 'i').test(text);
      }).map((el) => el.textContent?.trim()).filter((s): s is string => !!s);
      return [...invalid.map((el) => `${el.getAttribute('aria-label') || el.name || el.id || 'Field'}: ${el.validationMessage}`), ...described];
    }, { positive: successPattern.source, negative: negativeSubmission.source }).catch(() => []);
    errors.push(...found);
  }
  return [...new Set(errors)].slice(0, 12);
}

function throwIfCancelled(signal: AbortSignal) { if (signal.aborted) throw new Error('Cancelled'); }

export async function runApplication(options: BrowserAgentOptions): Promise<void> {
  const { run, profile, artifactDir, signal, onUpdate, waitForInput, waitForSubmit, assertUrl } = options;
  let browser: Browser | undefined;
  let page: Page | undefined;
  let submittedAttempt = false;
  const marker = `astra-${run.id.replace(/[^a-zA-Z0-9]/g, '')}`;
  const completed = new Map<string, string>();
  const ignored = new Set<string>();
  const log = async (message: string, kind: 'info' | 'action' | 'warning' | 'error' = 'info') => {
    run.events.push({ at: new Date().toISOString(), message, kind });
    run.updatedAt = new Date().toISOString();
    await onUpdate(run);
  };
  const screenshot = async () => {
    if (page && !page.isClosed()) {
      await mkdir(artifactDir, { recursive: true });
      await page.screenshot({ path: join(artifactDir, 'latest.png'), fullPage: true, timeout: 10_000 }).then(() => { run.screenshot = true; }).catch(() => {});
    }
  };
  const pause = async (questions: Question[], message: string) => {
    throwIfCancelled(signal);
    run.questions = questions;
    run.status = 'needs_input';
    const waiting = waitForInput();
    void waiting.catch(() => {});
    await screenshot();
    await log(message, 'warning');
    const answers = await waiting;
    throwIfCancelled(signal);
    for (const [key, value] of Object.entries(answers)) if (typeof value === 'string' && !key.startsWith('__')) profile.answers[key] = value;
    run.questions = [];
    run.status = 'running';
    await onUpdate(run);
    return answers;
  };
  const closeOnAbort = () => { void browser?.close().catch(() => {}); };
  signal.addEventListener('abort', closeOnAbort, { once: true });
  try {
    throwIfCancelled(signal);
    await assertUrl(run.url);
    run.status = 'running';
    await log('Opening the job application in a private browser.');
    const executablePath = process.env.BROWSER_EXECUTABLE_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
    browser = await chromium.launch({ headless: process.env.ASTRA_HEADLESS === 'true' || process.env.NODE_ENV === 'test', executablePath, args: ['--disable-dev-shm-usage'] }).catch(() => { throw new Error('The application browser could not start. Run npx playwright install chromium, check BROWSER_EXECUTABLE_PATH, and use a desktop session for visible browser mode.'); });
    const context = await browser.newContext({ viewport: { width: 1366, height: 1000 }, acceptDownloads: false, serviceWorkers: 'block' });
    context.setDefaultTimeout(12_000);
    context.setDefaultNavigationTimeout(30_000);
    await context.route('**/*', async (route) => {
      try {
        const url = route.request().url();
        if (/^https?:/.test(url)) await assertUrl(url);
        else if (!/^(data:|blob:|about:)/.test(url)) throw new Error('Unsupported request protocol');
        if (signal.aborted) await route.abort();
        else await route.continue();
      } catch { await route.abort('blockedbyclient').catch(() => {}); }
    });
    await context.routeWebSocket('**/*', async (socket) => {
      try {
        const url = socket.url().replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
        await assertUrl(url);
        if (signal.aborted) await socket.close({ code: 1008, reason: 'Application cancelled' });
        else socket.connectToServer();
      } catch { await socket.close({ code: 1008, reason: 'Destination unavailable' }).catch(() => {}); }
    });
    context.on('page', (popup) => { page = popup; });
    page = await context.newPage();
    await page.goto(run.url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
    let fitChecked = false;
    let noProgress = 0;
    let previousState = '';
    let activeMs = 0;
    let manualCompatibilityAcknowledged = '';
    for (let step = 0; step < 80; step++) {
      const started = Date.now();
      throwIfCancelled(signal);
      if (page.isClosed()) throw new Error('The application browser was closed.');
      await assertUrl(page.url());
      const body = await visibleText(page);
      if (run.searchPreferences && !fitChecked) {
        await checkJobFit(page, run.searchPreferences, signal);
        fitChecked = true;
        await log('Verified that the live listing matches your role, level and location.');
      }
      const fields: Field[] = [];
      const inspectionFailures: string[] = [];
      for (const frame of page.frames()) {
        if (!isApplicationFrame(frame)) continue;
        const discovered = await discover(frame, marker).catch(() => {
          inspectionFailures.push('Could not discover fields in one embedded application frame.');
          return [] as Field[];
        });
        // Keys remain stable across navigation but do not collide between frames.
        for (const field of discovered) {
          const duplicate = fields.some((existing) => existing.key === field.key);
          if (duplicate) field.key = `${field.key}:frame-${fields.length}`;
          fields.push(field);
        }
      }
      // Job detail pages often contain navigation/filter inputs but no application.
      // Open the actual application before auditing or answering incidental fields.
      const hasApplicationIdentity = fields.some((field) => /\b(first|given|last|family|full)\s+name\b|\bresume\b|r[eé]sum[eé]|\bcover letter\b/i.test(field.label))
        || fields.length >= 3 && fields.some((field) => /\b(email|phone)\b/i.test(field.label));
      if (!hasApplicationIdentity) {
        const entry = await findAction(page, true);
        if (entry?.kind === 'apply') {
          await log(`Opening the application form via "${entry.label}" before answering fields.`, 'action');
          await entry.locator.click();
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
          noProgress = 0;
          previousState = '';
          continue;
        }
      }
      const report = await assessCompatibility(page, fields, inspectionFailures);
      if (JSON.stringify(run.compatibility) !== JSON.stringify(report)) {
        run.compatibility = report;
        await log(`Form compatibility: ${report.platform}, ${report.status.replace('_', ' ')} (${report.detectedFields} controls detected).${report.issues.length ? ' ' + report.issues.join('; ') : ''}`, report.issues.length ? 'warning' : 'info');
      }
      let filled = 0;
      const unresolved: Question[] = [];
      for (const field of fields) {
        throwIfCancelled(signal);
        if (ignored.has(field.key) && !field.required) continue;
        if (field.required) ignored.delete(field.key);
        const previous = completed.get(field.selector);
        if (previous !== undefined) {
          // React/ATS forms can reset or replace a control after an async update.
          // Re-check the DOM so we never treat a lost dropdown selection as filled.
          if (await hasRenderedAnswer(field, previous)) continue;
          completed.delete(field.selector);
        }
        if (field.kind === 'file') {
          if (completed.has(field.selector)) continue;
          const resumeField = /resume|résumé|\bcv\b/i.test(field.label) || fields.filter((f) => f.kind === 'file').length === 1 && !/cover|letter|transcript|certificate|photo|portfolio/i.test(field.label);
          if (resumeField && profile.resume && existsSync(profile.resume.path)) {
            await field.frame.locator(field.selector).setInputFiles({ name: profile.resume.name, mimeType: mimeType(profile.resume.name), buffer: await import('node:fs/promises').then((fs) => fs.readFile(profile.resume!.path)) });
            if (!await hasRenderedAnswer(field, 'uploaded')) throw new Error('The resume upload did not remain attached.');
            completed.set(field.selector, 'uploaded');
            filled++;
            await log('Attached the uploaded resume.', 'action');
          } else if (field.required) unresolved.push({ key: field.key, label: `${field.label} — upload the requested document in your profile before starting a new run.`, type: 'file', options: [], required: true });
          else ignored.add(field.key);
          continue;
        }
        if (field.kind === 'password') continue;
        if (field.kind === 'select-multiple') {
          const answers = multipleAnswers(field, profile);
          if (answers.length) {
            const selection = answers.join('; ');
            await fillField(field, selection);
            if (!await hasRenderedAnswer(field, selection)) throw new Error('Multiple selection was not retained.');
            completed.set(field.selector, selection);
            filled++;
            await log('Selected multiple choices grounded in your saved profile.', 'action');
          } else if (field.required) {
            if (run.campaignId) throw new Error('A required multi-select needs a saved, factual answer. No application was submitted.');
            unresolved.push({ key: field.key, label: `${field.label} — enter one or more offered choices separated by semicolons.`, type: 'select-multiple', options: field.options, required: true });
          } else ignored.add(field.key);
          continue;
        }
        if (field.kind === 'combobox' && !field.options.length) await customOptions(field).catch(() => {});
        const answer = await answerQuestion(field, profile, signal);
        // Do not silently skip optional fields when the configured AI provider failed.
        if (answer.reason && /^(?:AI request failed|AI response was incomplete|AI returned no usable output|AI answering failed)/.test(answer.reason)) {
          throw new Error(`AI form answering unavailable: ${answer.reason}`);
        }
        if (answer.value !== undefined) {
          try {
            await fillField(field, answer.value);
            if (!await hasRenderedAnswer(field, answer.value)) throw new Error('The form did not retain the selected answer.');
            completed.set(field.selector, answer.value);
            filled++;
            await log(`Answered a ${field.kind} field from ${answer.source === 'ai' ? 'resume-grounded AI reasoning' : answer.source === 'saved' ? 'your saved answer' : 'your profile'}.`, 'action');
          } catch {
            unresolved.push({ key: field.key, label: `${field.label} — this control could not be filled automatically.`, type: field.kind, options: field.options, required: true });
          }
        } else if (field.required || field.kind === 'checkbox' && /agree|consent|terms|certif|attest|acknowledge/i.test(field.label)) {
          unresolved.push({ key: field.key, label: field.label, type: field.kind, options: field.options, required: field.required });
        } else if (!field.value || ['select', 'combobox', 'checkbox'].includes(field.kind)) {
          const customDefault = field.kind === 'combobox' && field.value.trim() && !/^(select|choose|please select|please choose)(\b|\.)/i.test(field.value);
          try {
            if (customDefault) throw new Error('An unsupported custom default requires an explicit answer.');
            await clearOptionalDefault(field);
            ignored.add(field.key);
          } catch {
            unresolved.push({ key: field.key, label: `${field.label} — confirm or change this preselected answer before submission.`, type: field.kind, options: field.options, required: true });
          }
        } else if (['radio'].includes(field.kind) || needsExplicitAnswer(field.label)) {
          try { await clearOptionalDefault(field); ignored.add(field.key); }
          catch { unresolved.push({ key: field.key, label: `${field.label} — confirm or change this preselected answer before submission.`, type: field.kind, options: field.options, required: true }); }
        }
      }
      if (unresolved.length) {
        const unique = [...new Map(unresolved.map((q) => [q.key, q])).values()];
        const submittedAnswers = await pause(unique, `${unique.length} question${unique.length === 1 ? '' : 's'} need your answer before the application can continue.`);
        // A new answer must be applied even if a control previously held a default.
        for (const q of unique) {
          if (!q.required && !submittedAnswers[q.key]?.trim()) ignored.add(q.key);
          const field = fields.find((f) => f.key === q.key);
          if (field) completed.delete(field.selector);
        }
        continue;
      }
      if (report.status === 'needs_review' && report.issues.length) {
        // Never discard the entire form before handling fields we *can* fill.
        // A genuinely unsupported widget is still not safe to auto-submit.
        await screenshot();
        await log(`Automated fill attempted; unsupported widgets need review: ${report.issues.join('; ')}`, 'warning');
        // Keep unattended campaigns waiting for a human instead of skipping whole batches.
        const fingerprint = page.url() + JSON.stringify(report.issues);
        if (manualCompatibilityAcknowledged !== fingerprint) {
          await page.bringToFront();
          await pause([{ key: '__compatibility', label: `Complete these unsupported controls in the AStra browser without submitting: ${report.issues.join('; ')}`, type: 'manual', options: ['Continue'], required: true }], 'Recognized fields have been filled. Please complete the unsupported controls in the AStra browser.');
          manualCompatibilityAcknowledged = fingerprint;
          continue;
        }
      }
      // Fill application fields first. A real verification gate is only a
      // blocker when proceeding to the next step or submitting the form.
      // Passive reCAPTCHA badges never stop ordinary form completion.
      if (await challengePresent(page)) {
        await page.bringToFront();
        await pause([{ key: '__challenge', label: 'The application fields have been filled where possible. Complete the visible CAPTCHA, login, or verification in the AStra browser window, then continue here.', type: 'manual', options: ['Continue'], required: true }], 'Visible human verification is required before proceeding. AStra has already attempted to fill the form.');
        continue;
      }
      const action = await findAction(page) || await planNavigation(page, signal);
      const state = `${page.url()}|${fields.map((field) => `${field.key}:${field.value}`).join('|')}|${action?.label}`;
      noProgress = state === previousState && !filled ? noProgress + 1 : 0;
      previousState = state;
      if (noProgress > 2) {
        await pause([{ key: '__manual', label: 'Resolve the blocked control in the AStra browser, without submitting, then continue.', type: 'manual', options: ['Continue'], required: true }], 'This page is not progressing. Please resolve the highlighted fields in the browser window.');
        noProgress = 0; previousState = ''; completed.clear(); continue;
      }
      if (!action) {
        await pause([{ key: '__manual', label: 'Open the application or complete the unusual control in the AStra browser without submitting. Then continue.', type: 'manual', options: ['Continue'], required: true }], 'No usable navigation control was found. Please move to the application form in the open browser.');
        continue;
      }
      const isFinal = action.kind === 'submit' || (action.kind === 'apply' && hasApplicationIdentity);
      if (isFinal) {
        // Conditional ATS questions can appear *after* a prior selection. Discover again
        // immediately before considering submission so we do not miss new required fields.
        const refreshed: Field[] = [];
        for (const frame of page.frames()) if (isApplicationFrame(frame)) refreshed.push(...await discover(frame, marker).catch(() => []));
        if (refreshed.some((field) => field.required && !fields.some((prior) => prior.frame === field.frame && prior.selector === field.selector))) {
          await log('New required fields appeared after answering. Rechecking the application before submission.', 'info');
          continue;
        }
        const errors = await validationErrors(page);
        if (errors.length) {
          // Ask for a corrected answer rather than repeatedly clicking an invalid form.
          const badFields = fields.filter((f) => f.required || /invalid|error/i.test(f.label));
          if (!badFields.length) throw new Error('The form reports validation errors that could not be associated with a control. Check the screenshot.');
          await pause(badFields.map((f) => ({ key: f.key, label: `${f.label} — please verify this answer; the employer form reports a validation error.`, type: f.kind, options: f.options, required: true })), 'The employer form reports validation errors. Correct the requested fields to continue.');
          for (const field of badFields) completed.delete(field.selector);
          continue;
        }
        if (submittedAttempt) throw new Error('The final action was already clicked. Submission is uncertain; check the employer website before retrying.');
        if (!run.autoSubmit || run.compatibility?.status === 'needs_review') {
          run.status = 'ready_to_submit';
          const waiting = waitForSubmit();
          void waiting.catch(() => {});
          await screenshot();
          await log(run.compatibility?.status === 'needs_review' ? 'Manual compatibility review required before submission. Confirm all unsupported controls in the employer browser.' : 'The application is complete and ready for your submission approval.');
          await waiting;
          throwIfCancelled(signal);
          run.status = 'running';
        }
        submittedAttempt = true;
        await log('Submitting the completed application to the employer.', 'action');
      } else await log(action.kind === 'apply' ? 'Opening the application form.' : 'Continuing to the next application step.', 'action');
      await screenshot();
      const beforeEvidence = isFinal ? await confirmationEvidence(page) : [];
      const beforeUrl = page.url();
      await action.locator.click();
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 4_000 }).catch(() => {});
      if (isFinal) {
        // Final clicks can have slow asynchronous results. Poll for evidence and
        // never click again: a second POST could create a duplicate application.
        let deadline = Date.now() + 15_000;
        do {
          throwIfCancelled(signal);
          await assertUrl(page.url());
          if (await freshConfirmation(page, beforeEvidence, beforeUrl)) {
            run.status = 'submitted';
            run.result = 'The employer page confirmed that your application was submitted.';
            run.questions = [];
            await screenshot();
            await log('Application submission confirmed by the employer page.', 'action');
            return;
          }
          if (await challengePresent(page)) {
            await page.bringToFront();
            await pause([{ key: '__challenge', label: 'Complete verification in the AStra browser. If the site requires a final click, complete it there, then continue.', type: 'manual', options: ['Continue'], required: true }], 'Verification appeared after submission. Finish it in the open browser; AStra will check for confirmation without repeating the submit click.');
            deadline = Date.now() + 15_000;
          }
          if (negativeSubmission.test(await visibleText(page))) break;
          await page.waitForTimeout(350);
        } while (Date.now() < deadline);
        throw new Error('The final action was clicked once, but the employer did not confirm submission. Submission is uncertain; check the screenshot and employer website before retrying.');
      }
      await page.waitForTimeout(300);
      activeMs += Date.now() - started;
      if (activeMs > 15 * 60_000) throw new Error('This application exceeded the 15-minute automation limit. Review the latest screenshot before retrying.');
    }
    throw new Error('This application exceeded the 80-step automation limit. Review the latest screenshot before retrying.');
  } catch (error) {
    run.status = signal.aborted ? 'cancelled' : 'failed';
    run.questions = [];
    const message = error instanceof Error ? error.message : 'Unexpected browser automation failure.';
    // Browser/HTTP exception messages can contain URLs or form values. Keep user-visible failures concise.
    run.result = signal.aborted ? 'Application run cancelled.' : /^(The |This |No |AI |Cancelled)/.test(message) && message.length < 500 ? message : 'The browser could not complete this application. Check the latest screenshot and run again after resolving the issue.';
    await screenshot();
    await log(run.result, signal.aborted ? 'info' : 'error');
  } finally {
    signal.removeEventListener('abort', closeOnAbort);
    await browser?.close().catch(() => {});
  }
}

function mimeType(filename: string): string {
  if (/\.pdf$/i.test(filename)) return 'application/pdf';
  if (/\.docx$/i.test(filename)) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (/\.doc$/i.test(filename)) return 'application/msword';
  return 'text/plain';
}

import type { Frame, Page } from 'playwright';
import type { CompatibilityReport } from '../shared/types.js';

/** Security widgets and verification frames are not employer application forms. */
export function isApplicationFrame(frame: Frame): boolean {
  const url = frame.url();
  if (!url || url === 'about:blank') return true;
  return !/(?:google\.[^/]+|recaptcha\.net)\/recaptcha\/|\/recaptcha\/(?:api2|enterprise)\/|hcaptcha\.com\/|challenges\.cloudflare\.com\/|arkoselabs\.com\/|funcaptcha\.com\/|captcha-delivery\.com\//i.test(url);
}

export interface AuditedField {
  kind: string;
  label: string;
  required: boolean;
  selector: string;
}

/** Identify the host for display, not as evidence that a particular form is supported. */
export function identifyATS(urls: string[]): string {
  const all = urls.join(' ').toLowerCase();
  if (/greenhouse\.io|boards\.greenhouse\.io/.test(all)) return 'Greenhouse';
  if (/lever\.co/.test(all)) return 'Lever';
  if (/ashbyhq\.com/.test(all)) return 'Ashby';
  if (/myworkdayjobs\.com|workday\.com/.test(all)) return 'Workday';
  if (/smartrecruiters\.com/.test(all)) return 'SmartRecruiters';
  if (/icims\.com/.test(all)) return 'iCIMS';
  if (/taleo\.net/.test(all)) return 'Taleo';
  if (/successfactors\.|successfactors\.com/.test(all)) return 'SuccessFactors';
  if (/jobvite\.com/.test(all)) return 'Jobvite';
  if (/bamboohr\.com/.test(all)) return 'BambooHR';
  if (/recruitee\.com/.test(all)) return 'Recruitee';
  if (/workable\.com/.test(all)) return 'Workable';
  return 'Custom employer form';
}

/**
 * Scan *visible* required controls for elements not in the agent's control map.
 * We check the live DOM at each step, rather than granting support by URL alone.
 * Open shadow roots and nested iframes are visited separately by Playwright.
 */
async function findUnsupported(frame: Frame): Promise<string[]> {
  return frame.evaluate(() => {
    const issues: string[] = [];
    const roots: (Document | ShadowRoot)[] = [];
    const collect = (root: Document | ShadowRoot) => {
      roots.push(root);
      for (const element of root.querySelectorAll('*')) {
        if (element.shadowRoot) collect(element.shadowRoot);
      }
    };
    collect(document);
    const visible = (el: Element) => {
      const html = el as HTMLElement;
      const style = getComputedStyle(html);
      return style.display !== 'none' && style.visibility !== 'hidden' && html.getClientRects().length > 0;
    };
    const describe = (el: Element) => (
      el.getAttribute('aria-label') || el.getAttribute('name') || el.getAttribute('id') ||
      el.closest('fieldset')?.querySelector('legend')?.textContent?.trim() ||
      el.textContent?.trim().slice(0, 80) || el.tagName.toLowerCase()
    ).replace(/\s+/g, ' ').slice(0, 90);
    for (const root of roots) {
      const unsupported = root.querySelectorAll('input[type="range"], input[type="color"], [role="listbox"][aria-multiselectable="true"], [role="grid"][aria-required="true"], [role="tree"][aria-required="true"], [role="slider"][aria-required="true"], [role="spinbutton"][aria-required="true"]');
      for (const el of unsupported) {
        if (visible(el) && !el.closest('[aria-hidden="true"]')) issues.push('Specialized selection control needs review: ' + describe(el));
      }
      const required = root.querySelectorAll('[required], [aria-required="true"]');
      for (const el of required) {
        if (!visible(el) || el.matches('input[type="hidden"], option, [aria-hidden="true"]')) continue;
        if (el.matches('input[type="range"], input[type="color"], [role="listbox"][aria-multiselectable="true"]')) continue;
        if (el.matches('fieldset, [role="group"], [role="radiogroup"]')) continue;
        if (el.closest('[data-astra-control]') || el.querySelector('[data-astra-control]')) continue;
        if (el.closest('[aria-hidden="true"]')) continue;
        issues.push('Unrecognized required control: ' + describe(el));
      }
    }
    return [...new Set(issues)].slice(0, 15);
  });
}

export async function assessCompatibility(page: Page, fields: AuditedField[], discoveryFailures: string[] = []): Promise<CompatibilityReport> {
  const issues = [...discoveryFailures];
  for (const field of fields) {
    if (field.kind === 'combobox-multiple') {
      issues.push('Multi-select needs human confirmation: ' + field.label);
    }
    if (field.required && !field.label.trim()) issues.push('Required field has no accessible label.');
  }
  for (const frame of page.frames()) {
    if (!isApplicationFrame(frame)) continue;
    try {
      issues.push(...await findUnsupported(frame));
    } catch {
      issues.push('Could not inspect an embedded application frame.');
    }
  }
  return {
    platform: identifyATS(page.frames().filter(isApplicationFrame).map(frame => frame.url())),
    status: issues.length ? 'needs_review' : fields.length ? 'compatible' : 'checking',
    detectedFields: fields.length,
    issues: [...new Set(issues)].slice(0, 15),
    scope: 'current_step',
  };
}

import { afterEach, describe, expect, it, vi } from 'vitest';
import { answerQuestion, deterministicAnswer, matchOption } from '../server/answering';
import { emptyProfile, type Profile, type Question } from '../shared/types';

const profile: Profile = { ...emptyProfile, firstName: 'Alex', lastName: 'Rivera', email: 'alex@example.com', country: 'United States', yearsExperience: '4', workAuthorization: 'Yes', requiresSponsorship: 'No', answers: {} };
const question = (label: string, options: string[] = []): Question => ({ label, key: label, type: options.length ? 'select' : 'text', options, required: true });

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('truthful applicant answers', () => {
  it('uses actual offered choices for profile facts and numeric ranges', () => {
    expect(deterministicAnswer(question('Are you legally authorized to work in the United States?', ['Yes', 'No']), profile).value).toBe('Yes');
    expect(deterministicAnswer(question('Will you require visa sponsorship?', ['Yes', 'No']), profile).value).toBe('No');
    expect(deterministicAnswer(question('Years of professional experience', ['0–2 years', '3–5 years', '6+ years']), profile).value).toBe('3–5 years');
    expect(matchOption('United States', ['US', 'Canada'])).toBe('US');
    expect(matchOption('yes', ['Absolutely', 'No thanks'])).toBeUndefined();
  });

  it('does not reuse total experience for a skill-specific qualification', () => {
    expect(deterministicAnswer(question('How many years of experience do you have with Kubernetes?'), profile).value).toBeUndefined();
    expect(deterministicAnswer(question('Do you have at least five years of Python experience?', ['Yes', 'No']), profile).value).toBeUndefined();
  });

  it('does not confuse institution names, past salary, or another country’s work authorization with profile facts', () => {
    const complete = { ...profile, country: 'United States', currentCompany: 'Example Co', salaryExpectation: '100000' };
    expect(deterministicAnswer(question('Name of university'), complete).value).toBeUndefined();
    expect(deterministicAnswer(question('Name of your current employer'), complete).value).toBe('Example Co');
    expect(deterministicAnswer(question('Current salary'), complete).value).toBeUndefined();
    expect(deterministicAnswer(question('Are you legally authorized to work in Canada?', ['Yes', 'No']), complete).value).toBeUndefined();
    expect(deterministicAnswer(question('Are you legally authorized to work in Brazil?', ['Yes', 'No']), complete).value).toBeUndefined();
    expect(deterministicAnswer(question('Are you legally authorized to work in the United States?', ['Yes', 'No']), { ...complete, country: '' }).value).toBeUndefined();
    expect(deterministicAnswer(question('Are you legally authorized to work in an unknown jurisdiction?', ['Yes', 'No']), complete).value).toBeUndefined();
    expect(deterministicAnswer(question('Will you require visa sponsorship in the UK?', ['Yes', 'No']), complete).value).toBeUndefined();
  });

  it('never infers demographics, consent, credentials, or background facts', async () => {
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    for (const label of ['What is your gender?', 'Are you a veteran?', 'Do you have a disability?', 'I consent to these terms', 'Do you hold an active security clearance?', 'I certify that these answers are accurate']) {
      expect((await answerQuestion(question(label, ['Yes', 'No']), profile)).value).toBeUndefined();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deterministicAnswer(question('I consent to these terms', ['Yes', 'No']), { ...profile, answers: { 'I consent to these terms': 'Yes' } }).value).toBe('Yes');
  });

  it('asks for missing information without requiring an AI key', async () => {
    vi.stubEnv('AI_API_KEY', '');
    expect((await answerQuestion(question('Describe your experience leading a design organization'), profile)).value).toBeUndefined();
  });

  it('rejects AI output that has no verbatim supporting evidence', async () => {
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Ten years', evidence: 'Invented ten years of experience' }) } }] }), { status: 200 }));
    expect((await answerQuestion(question('How many years of aerospace leadership experience do you have?'), profile)).value).toBeUndefined();
  });

  it('accepts a supported offered AI choice grounded in supplied resume text', async () => {
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'TypeScript', evidence: 'TypeScript engineer' }) } }] }), { status: 200 }));
    const grounded = { ...profile, resume: { path: '/tmp/private.pdf', name: 'resume.pdf', text: 'Alex is a TypeScript engineer.' } };
    const result = await answerQuestion(question('What is your primary programming language?', ['TypeScript', 'Python']), grounded);
    expect(result).toEqual({ value: 'TypeScript', source: 'ai' });
    const request = JSON.parse(fetchSpy.mock.calls[0][1]!.body as string);
    expect(request.messages[1].content).not.toContain('/tmp/private.pdf');
  });

  it('serializes real browser fields without cyclic Playwright runtime objects', async () => {
    vi.stubEnv('AI_API_KEY', 'test-key');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'C++', evidence: 'C++ firmware' }) } }] })));
    const frame: Record<string, unknown> = {}; frame.parent = frame;
    const field = { ...question('Which language have you used?', ['C++', 'Java']), frame, selector: '#private-runtime', context: 'Engineering skills' };
    const result = await answerQuestion(field, { ...profile, skills: 'C++ firmware' });
    expect(result).toEqual({ value: 'C++', source: 'ai' });
    const request = JSON.parse(String(fetchSpy.mock.calls[0][1]?.body));
    const sent = JSON.parse(request.messages[1].content);
    expect(sent.question.context).toBe('Engineering skills');
    expect(sent.question.frame).toBeUndefined();
    expect(sent.question.selector).toBeUndefined();
  });

  it('does not send a key through an insecure remote endpoint', async () => {
    vi.stubEnv('AI_API_KEY', 'test-key');
    vi.stubEnv('AI_BASE_URL', 'http://untrusted.example/v1');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect((await answerQuestion(question('Describe your engineering accomplishments'), profile)).value).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

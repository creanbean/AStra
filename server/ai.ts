/** Shared bounded API client. Credentials never reach employer pages. */
export async function responses(instructions: string, input: unknown, signal: AbortSignal, search = false) {
  if (!process.env.AI_API_KEY) throw new Error('AI_API_KEY is required for automatic discovery and navigation.');
  const base = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const url = new URL(`${base}/responses`);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('AI endpoint must use HTTPS.');
  const response = await fetch(url, {
    method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { Authorization: `Bearer ${process.env.AI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: process.env.AI_MODEL || 'gpt-4.1-mini', store: false, instructions,
      input: (search ? '' : 'Return only a JSON object.\n') + JSON.stringify(input), max_output_tokens: 5000,
      ...(search ? { tools: [{ type: 'web_search' }], tool_choice: 'required', include: ['web_search_call.action.sources'] } : { text: { format: { type: 'json_object' } } }),
    }),
  });
  if (!response.ok) {
    const apiError = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    const rawDetail = apiError?.error?.message || 'The provider returned no error details.';
    const safeDetail = rawDetail.replace(/sk-(?:proj-)?[A-Za-z0-9_-]+/g, '[REDACTED API KEY]').slice(0, 600);
    throw new Error(`AI request failed (HTTP ${response.status}): ${safeDetail}`);
  }
  const data = await response.json() as any;
  if (data.status === 'incomplete' || data.error) throw new Error('AI response was incomplete. Try a smaller request or another supported model.');
  const messages = (data.output || []).filter((x: any) => x.type === 'message').flatMap((x: any) => x.content || []);
  const text = messages.filter((x: any) => x.type === 'output_text').map((x: any) => x.text).join('\n');
  const sources: string[] = [
    ...messages.flatMap((x: any) => (x.annotations || []).filter((a: any) => a.type === 'url_citation').map((a: any) => a.url)),
    ...(data.output || []).filter((x: any) => x.type === 'web_search_call').flatMap((x: any) => (x.action?.sources || []).map((s: any) => s.url)),
  ].filter((x): x is string => typeof x === 'string');
  if (!text) throw new Error('AI returned no usable output.');
  return { text, sources };
}
export async function jsonAI(instructions: string, input: unknown, signal: AbortSignal): Promise<unknown> {
  return JSON.parse((await responses(instructions + ' Return JSON only.', input, signal)).text);
}

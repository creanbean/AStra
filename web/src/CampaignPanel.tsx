import { useEffect, useState } from 'react';
import type { Campaign, SearchPreferences } from '../../shared/types';

type Props = {
  request: <T>(path: string, options?: RequestInit) => Promise<T>;
  onError: (error: unknown) => void;
  onSelect: (id: string) => void;
  ready: boolean;
};
export function CampaignPanel({ request, onError, onSelect, ready }: Props) {
  const [items, setItems] = useState<Campaign[]>([]);
  const [busy, setBusy] = useState(false);
  const [preferences, setPreferences] = useState<SearchPreferences>({
    description: 'Electrical engineering roles in power systems, solar energy, controls, electronics, or PCB design. Include startups.',
    level: 'entry-level', location: 'United States', maxApplications: 10, maxSearchRounds: 10, autoSubmit: true,
  });
  useEffect(() => {
    let live = true;
    const refresh = () => void request<Campaign[]>('/campaigns').then(data => { if (live) setItems(data); }).catch(onError);
    refresh(); const timer = setInterval(refresh, 2500);
    return () => { live = false; clearInterval(timer); };
  }, [request, onError]);
  const current = items[0];
  const active = current?.status === 'running';
  async function mutate(path: string, body: object = {}) {
    setBusy(true);
    try {
      const c = await request<Campaign>(path, { method: 'POST', body: JSON.stringify(body) });
      setItems(old => [c, ...old.filter(x => x.id !== c.id)]);
    } catch (error) { onError(error); } finally { setBusy(false); }
  }
  return <section className="card campaign-card">
    <div className="section-heading"><div><span className="section-eyebrow">FIND + APPLY AUTOMATICALLY</span><h2>Your job search, on autopilot</h2><p>Describe the roles. AStra searches live listings and starts applications in small batches.</p></div><span className="mini-label">ELECTRICAL ENGINEERING</span></div>
    <form onSubmit={e => { e.preventDefault(); void mutate('/campaigns', preferences); }}>
      <label className="form-field"><span>What roles are you looking for?</span><textarea required minLength={10} maxLength={4000} rows={3} value={preferences.description} onChange={e => setPreferences(p => ({ ...p, description: e.target.value }))}/></label>
      <div className="campaign-fields">
        <label className="form-field"><span>Experience level</span><select value={preferences.level} onChange={e => setPreferences(p => ({ ...p, level: e.target.value as SearchPreferences['level'] }))}><option value="entry-level">Entry-level / new graduate</option><option value="internship">Internship</option></select></label>
        <label className="form-field"><span>Location / remote preference</span><input required minLength={2} value={preferences.location} onChange={e => setPreferences(p => ({ ...p, location: e.target.value }))}/></label>
        <label className="form-field"><span>Maximum application attempts</span><input type="number" min={1} max={200} required value={preferences.maxApplications} onChange={e => setPreferences(p => ({ ...p, maxApplications: Number(e.target.value) }))}/></label>
        <label className="form-field"><span>Maximum search batches</span><input type="number" min={1} max={40} required value={preferences.maxSearchRounds} onChange={e => setPreferences(p => ({ ...p, maxSearchRounds: Number(e.target.value) }))}/></label>
      </div>
      <label className="review-option"><input type="checkbox" checked={!preferences.autoSubmit} onChange={e => setPreferences(p => ({ ...p, autoSubmit: !e.target.checked }))}/><span><strong>Review each application before submission</strong><span>Leave off to automatically submit matching jobs using your profile and résumé.</span></span></label>
      {!ready && <p className="field-help">First save your profile and PDF résumé, configure your API key, and install Chromium.</p>}
      <div className="campaign-actions"><button className="button button-primary" disabled={busy || active || !ready}>{busy ? 'Working…' : active ? 'Search campaign running' : 'Find jobs & apply'}</button><p className="field-help">Starting authorizes searching and {preferences.autoSubmit ? 'submitting' : 'preparing'} up to {preferences.maxApplications} applications. API usage is billed to your API account.</p></div>
    </form>
    {current && <div className="campaign-progress" aria-live="polite">
      <div className="section-heading"><div><strong>{current.status.toUpperCase()} · Batch {current.rounds} / {current.preferences.maxSearchRounds}</strong><p>{current.message}</p></div>{active ? <button className="button button-outline button-small" disabled={busy} onClick={() => void mutate(`/campaigns/${current.id}/stop`)}>Pause campaign</button> : ['paused', 'failed'].includes(current.status) && <button className="button button-outline button-small" disabled={busy} onClick={() => void mutate(`/campaigns/${current.id}/resume`)}>Resume remaining jobs</button>}</div>
      <div className="campaign-job-list">{current.jobs.map(job => <div className="campaign-job" key={job.url}><div><a href={job.url} target="_blank" rel="noreferrer">{job.title}</a><p>{job.company} · {job.location}</p><small>{job.reason}</small>{job.outcome && <p className="field-help"><strong>{job.state === 'skipped' ? 'Skipped because: ' : 'Attempt result: '}</strong>{job.outcome}</p>}</div><div><span>{job.state}</span>{job.runId && <button className="text-button" onClick={() => onSelect(job.runId!)}>View application</button>}</div></div>)}</div>
    </div>}
  </section>;
}

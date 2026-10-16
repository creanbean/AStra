import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { emptyProfile, type AppConfig, type ApplicationRun, type Profile, type RunStatus } from '../../shared/types';

import { CampaignPanel } from './CampaignPanel';

type View = 'dashboard' | 'profile' | 'history';
type IconName = 'star' | 'grid' | 'person' | 'history' | 'arrow' | 'link' | 'file' | 'upload' | 'check' | 'external' | 'close' | 'chevron' | 'bolt' | 'shield' | 'plus' | 'trash' | 'eye' | 'clock' | 'search';
const iconPaths: Record<IconName, ReactNode> = {
  star: <path d="m12 2 2.8 7.2L22 12l-7.2 2.8L12 22l-2.8-7.2L2 12l7.2-2.8Z" />,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  person: <><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></>,
  history: <><path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7"/><path d="M12 7v5l3 2"/></>,
  arrow: <><path d="M4 12h16m-6-6 6 6-6 6"/></>,
  link: <><path d="m10 13 4-4m-6 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m2 2 1-1a4 4 0 0 1 6 6l-4 4a4 4 0 0 1-6 0"/></>,
  file: <><path d="M14 2H5a1 1 0 0 0-1 1v18a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8Zm0 0v6h6M8 13h8m-8 4h6"/></>,
  upload: <><path d="M12 16V3m-5 5 5-5 5 5M3 15v5a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-5"/></>,
  check: <path d="m5 12 4 4L19 6" />,
  external: <><path d="M14 3h7v7m0-7L10 14M10 3H4a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6"/></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevron: <path d="m9 5 7 7-7 7" />,
  bolt: <path d="m13 2-9 12h7l-1 8 10-12h-7Z" />,
  shield: <><path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6Z"/><path d="m8 12 3 3 5-6"/></>,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
};
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{iconPaths[name]}</svg>;
}
class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }
async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  const token = sessionStorage.getItem('astra-access-token');
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, { ...options, headers });
  if (!response.ok) {
    let message = `Request failed (${response.status}).`;
    try { const data = await response.json(); message = typeof data.error === 'string' ? data.error : data.message || message; } catch { /* A proxy can return a non-JSON error. */ }
    throw new ApiError(message, response.status);
  }
  return response.json() as Promise<T>;
}
const statusLabels: Record<RunStatus, string> = { queued: 'Queued', running: 'In progress', needs_input: 'Needs your input', ready_to_submit: 'Ready for review', submitted: 'Submitted', failed: 'Stopped', cancelled: 'Cancelled' };
const activeStatuses: RunStatus[] = ['queued', 'running', 'needs_input', 'ready_to_submit'];
function Status({ status }: { status: RunStatus }) { return <span className={`status status-${status}`}><span />{statusLabels[status]}</span>; }
function siteName(url: string) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
function dateLabel(date: string) { return new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function timeLabel(date: string) { return new Date(date).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); }
function initials(profile: Profile) { return `${profile.firstName[0] || 'Y'}${profile.lastName[0] || 'U'}`.toUpperCase(); }
function Spinner() { return <span className="spinner" aria-hidden="true" />; }
function Empty({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) { return <div className="empty-state"><span className="empty-icon"><Icon name={icon} size={27}/></span><h3>{title}</h3><p>{children}</p></div>; }

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [profile, setProfile] = useState<Profile>(emptyProfile);
  const [runs, setRuns] = useState<ApplicationRun[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [needsAuth, setNeedsAuth] = useState(false);
  const [token, setToken] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [url, setUrl] = useState('');
  const [review, setReview] = useState(false);
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = useCallback((message: string) => { setNotice(message); if (noticeTimer.current) clearTimeout(noticeTimer.current); noticeTimer.current = setTimeout(() => setNotice(''), 5000); }, []);
  const handleError = useCallback((err: unknown) => { if (err instanceof ApiError && err.status === 401) setNeedsAuth(true); else setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.'); }, []);
  const load = useCallback(async () => {
    setError('');
    try {
      const nextConfig = await api<AppConfig>('/config');
      const [nextProfile, nextRuns] = await Promise.all([api<Profile>('/profile'), api<ApplicationRun[]>('/runs')]);
      setConfig(nextConfig); setProfile(nextProfile); setRuns(nextRuns); setNeedsAuth(false);
      setSelectedId(current => current || nextRuns.find(run => activeStatuses.includes(run.status))?.id || null);
    } catch (err) { handleError(err); } finally { setLoading(false); }
  }, [handleError]);
  useEffect(() => { void load(); return () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }; }, [load]);
  useEffect(() => {
    if (needsAuth || loading) return;
    const interval = setInterval(() => { void api<ApplicationRun[]>('/runs').then(setRuns).catch(handleError); }, 2500);
    return () => clearInterval(interval);
  }, [loading, needsAuth, handleError]);
  const selected = runs.find(run => run.status === 'needs_input' || run.status === 'ready_to_submit') || runs.find(run => run.id === selectedId) || runs.find(run => activeStatuses.includes(run.status));
  const submittedCount = runs.filter(run => run.status === 'submitted').length;
  const activeCount = runs.filter(run => activeStatuses.includes(run.status)).length;
  const attentionCount = runs.filter(run => ['needs_input', 'ready_to_submit'].includes(run.status)).length;
  const profileReady = Boolean(profile.firstName && profile.lastName && profile.email && profile.resume);
  const serviceReady = Boolean(config?.browserAvailable);
  const updateRun = (run: ApplicationRun) => { setRuns(current => [run, ...current.filter(item => item.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); };
  async function startApplication(event: FormEvent) {
    event.preventDefault(); setError('');
    if (!profileReady) { setView('profile'); showNotice('Add your name, email, and résumé to get started.'); return; }
    setStarting(true);
    try { const run = await api<ApplicationRun>('/runs', { method: 'POST', body: JSON.stringify({ url: url.trim(), autoSubmit: !review }) }); updateRun(run); setSelectedId(run.id); setUrl(''); showNotice(review ? 'Application started. AStra will pause before submitting.' : 'Application started. AStra is authorized to fill and submit this application.'); }
    catch (err) { handleError(err); } finally { setStarting(false); }
  }
  async function unlock(event: FormEvent) {
    event.preventDefault(); setAuthLoading(true); sessionStorage.setItem('astra-access-token', token.trim());
    try { await api<AppConfig>('/config'); setToken(''); await load(); } catch (err) { setError(err instanceof Error ? err.message : 'Unable to connect.'); } finally { setAuthLoading(false); }
  }
  const visibleRuns = runs.filter(run => (filter === 'all' || (filter === 'active' ? activeStatuses.includes(run.status) : filter === 'attention' ? ['needs_input', 'ready_to_submit'].includes(run.status) : run.status === filter)) && run.url.toLowerCase().includes(search.toLowerCase()));

  return <div className="app-shell">
    <aside className="sidebar" inert={needsAuth}>
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setView('dashboard'); }} aria-label="AStra dashboard"><span className="brand-mark"><Icon name="star" size={25}/></span><span>AStra<span className="brand-dot">.</span></span></a>
      <div className="sidebar-label">YOUR WORKSPACE</div>
      <nav aria-label="Main navigation">
        {([['dashboard', 'grid', 'Overview'], ['profile', 'person', 'My profile'], ['history', 'history', 'Applications']] as const).map(([key, icon, label]) => <button key={key} className={`nav-item ${view === key ? 'active' : ''}`} onClick={() => setView(key)} aria-label={label} aria-current={view === key ? 'page' : undefined}><Icon name={icon}/><span>{label}</span>{key === 'history' && runs.length > 0 && <span className="nav-count">{runs.length}</span>}</button>)}
      </nav>
      <div className="sidebar-tip"><span className="tip-star"><Icon name="star" size={19}/></span><h3>Your next chapter starts here.</h3><p>AStra finds opportunities<br/>and handles applications.</p><div className="tip-orbit" /></div>
      <div className="sidebar-bottom"><div className="connection"><span className={`connection-dot ${serviceReady ? 'online' : ''}`}/>{serviceReady ? 'Agent ready' : loading ? 'Connecting…' : 'Setup needed'}</div><div className="account"><div className="avatar">{initials(profile)}</div><div><strong>{profile.firstName ? `${profile.firstName} ${profile.lastName}`.trim() : 'Your workspace'}</strong><span>Personal account</span></div><button className="icon-button" title="Edit profile" aria-label="Edit profile" onClick={() => setView('profile')}><Icon name="chevron" size={16}/></button></div></div>
    </aside>
    <main className="main-content" inert={needsAuth}>
      <header className="topbar"><div className="breadcrumb">Workspace <span>/</span> <strong>{view === 'dashboard' ? 'Overview' : view === 'profile' ? 'My profile' : 'Applications'}</strong></div><div className="topbar-right"><span className="workspace-tag"><span/> Personal workspace</span><span className="small-avatar">{initials(profile)}</span></div></header>
      <div className="page-content">
        {error && <div className="alert error" role="alert"><span>{error}</span><button className="icon-button" onClick={() => setError('')} aria-label="Dismiss error"><Icon name="close" size={17}/></button></div>}
        {notice && <div className="alert success" role="status"><Icon name="check" size={18}/><span>{notice}</span></div>}
        {loading ? <div className="initial-loading"><Spinner/><p>Preparing your workspace…</p></div> : <>
          {view === 'dashboard' && <>
            <div className="page-heading"><div><span className="eyebrow">LESS ADMIN. MORE OPPORTUNITY.</span><h1>Your next chapter{profile.firstName ? `, ${profile.firstName}` : ''}<span className="heading-star">✧</span></h1><p>Put your job search in motion. Let AStra take care of the paperwork.</p></div><button className="button button-outline profile-shortcut" onClick={() => setView('profile')}><Icon name="person" size={17}/>Manage profile</button></div>
            <div className="stats-grid"><Stat label="Applications submitted" value={submittedCount} icon="check" tone="mint" detail="Confirmed by the application site"/><Stat label="Currently in progress" value={activeCount} icon="bolt" tone="lilac" detail={activeCount ? 'Your agent is on it' : 'Ready for your next opportunity'}/><Stat label="Need your attention" value={attentionCount} icon="clock" tone="peach" detail={attentionCount ? 'A quick answer goes a long way' : 'You’re all caught up'}/></div>
            {(!serviceReady || !config?.aiConfigured) && <div className="setup-banner"><span className="icon-tile lilac"><Icon name="bolt"/></span><div><strong>{serviceReady ? 'Your profile is ready to do the talking' : 'Let’s connect your agent'}</strong><p>{!config?.aiConfigured ? 'AI is not connected. AStra can use your saved facts and will ask for answers it cannot determine. Configure AI_API_KEY on your server for AI assistance. ' : ''}{!config?.browserAvailable ? 'Install the Playwright Chromium browser to enable applications.' : ''}</p></div><button className="button button-small button-outline" onClick={() => void load()}>Check again</button></div>}
            <CampaignPanel request={api} onError={handleError} onSelect={setSelectedId} ready={profileReady && serviceReady && !!config?.aiConfigured}/>
            <div className={`dashboard-grid ${selected ? 'has-run' : ''}`}>
              <section className="card apply-card"><div className="card-heading"><div className="card-title"><span className="icon-tile lilac"><Icon name="star"/></span><div><h2>Apply to a specific job</h2><p>Optional: already have a listing? Paste it here.</p></div></div><span className="mini-label">AI ASSISTED</span></div>
                <form onSubmit={startApplication}>
                  <label className="field-label" htmlFor="application-url">Job application URL</label><div className="url-input"><Icon name="link" size={19}/><input id="application-url" type="url" required placeholder="https://company.com/careers/your-next-role" value={url} onChange={event => setUrl(event.target.value)} autoComplete="url"/></div><p className="field-help">Paste the direct link to a job listing or its application form.</p>
                  <div className="attached-profile"><span className={`file-icon ${profile.resume ? 'ready' : ''}`}><Icon name="file" size={23}/></span><div><strong>{profile.resume?.name || 'Add your résumé to get started'}</strong><span>{profile.resume ? 'Your saved profile and résumé will be used' : 'Upload once. Use it for every application.'}</span></div><button type="button" className="text-button" onClick={() => setView('profile')}>{profile.resume ? 'Edit' : 'Add'}<Icon name="chevron" size={15}/></button></div>
                  <label className="review-option"><input type="checkbox" checked={review} onChange={event => setReview(event.target.checked)}/><span><strong>Let me review before submitting</strong><span>{review ? 'AStra will pause at the final step for your approval.' : 'Optional — applications are submitted automatically by default.'}</span></span></label>
                  <button className="button button-primary launch-button" disabled={starting || !serviceReady || activeCount > 0} type="submit">{starting ? <><Spinner/>Starting your application…</> : activeCount > 0 ? <><Icon name="clock" size={19}/>An application is in progress</> : <><Icon name="bolt" size={19}/>{review ? 'Prepare my application' : 'Apply & submit'}<Icon name="arrow" size={18}/></>}</button>
                  <p className="authorization-note"><Icon name="shield" size={14}/>{review ? 'By continuing, you authorize AStra to fill this application with your saved information.' : 'By continuing, you authorize AStra to fill and submit this application with your saved information.'}</p>
                </form>
              </section>
              {selected ? <RunDetail run={selected} onUpdate={updateRun} onError={handleError} onNotice={showNotice} onClose={() => setSelectedId(null)}/> : <section className="card how-card"><div className="section-eyebrow">A LITTLE HELP. A BIG STEP.</div><h2>From link to<br/>application.</h2><p className="how-intro">Your application agent works through the details so you can focus on what comes next.</p><div className="how-steps"><HowStep number="01" title="Make it yours" description="Save your profile and upload your résumé."/><HowStep number="02" title="Let AStra do the work" description="It reads the form, answers from your facts, and attaches your résumé."/><HowStep number="03" title="Get it across the line" description="It submits and checks for a confirmation, or pauses when it needs you."/></div><div className="honesty-note"><Icon name="shield" size={16}/><span>Missing facts, login, or CAPTCHA? AStra asks for help. Website support varies.</span></div></section>}
            </div>
            <section className="card recent-card"><div className="section-heading"><div><h2>Recent applications</h2><p>A little momentum, all in one place.</p></div><button className="text-button" onClick={() => setView('history')}>View all<Icon name="arrow" size={16}/></button></div>{runs.length ? <div className="run-list">{runs.slice(0, 4).map(run => <RunRow key={run.id} run={run} selected={selectedId === run.id} onClick={() => setSelectedId(run.id)}/>)}</div> : <div className="recent-empty"><span className="empty-icon"><Icon name="link" size={25}/></span><div><h3>Your first opportunity is waiting</h3><p>Add a job link above, and we’ll start building your application history.</p></div><span className="decorative-arrow"><Icon name="arrow" size={27}/></span></div>}</section>
          </>}
          {view === 'profile' && <><div className="page-heading"><div><span className="eyebrow">A GREAT APPLICATION STARTS WITH YOU.</span><h1>Your profile<span className="heading-star">✧</span></h1><p>Give AStra the facts. It’ll bring them to your next opportunity.</p></div><span className={`profile-completeness ${profileReady ? 'complete' : ''}`}><Icon name={profileReady ? 'check' : 'person'} size={17}/>{profileReady ? 'Ready to apply' : 'Finish your essentials'}</span></div><ProfileEditor profile={profile} onSave={(next, message) => { setProfile(next); showNotice(message || 'Your profile is saved. You’re one step closer.'); }} onError={handleError}/></>}
          {view === 'history' && <><div className="page-heading"><div><span className="eyebrow">EVERY STEP COUNTS.</span><h1>Your applications<span className="heading-star">✧</span></h1><p>Follow your progress, answer questions, and see what’s next.</p></div><button className="button button-primary" onClick={() => { setView('dashboard'); setSelectedId(null); }}><Icon name="plus" size={18}/>New application</button></div><section className="card history-card"><div className="history-toolbar"><div className="tabs" role="group" aria-label="Filter applications">{[['all', 'All'], ['active', 'In progress'], ['submitted', 'Submitted'], ['attention', 'Needs you']].map(([value, label]) => <button key={value} className={filter === value ? 'selected' : ''} onClick={() => setFilter(value)} aria-pressed={filter === value}>{label}</button>)}</div><label className="search-input"><Icon name="search" size={17}/><input type="search" placeholder="Search by website" aria-label="Search applications by website" value={search} onChange={event => setSearch(event.target.value)}/></label></div>{visibleRuns.length ? <div className="run-list">{visibleRuns.map(run => <RunRow key={run.id} run={run} selected={selectedId === run.id} onClick={() => setSelectedId(run.id)}/>)}</div> : <Empty icon="history" title={runs.length ? 'No matching applications' : 'A fresh start'}>{runs.length ? 'Try another filter or search term.' : 'Your applications will appear here once you start. Find a role you love and give AStra the link.'}</Empty>}</section>{selected && <div className="history-detail"><RunDetail run={selected} onUpdate={updateRun} onError={handleError} onNotice={showNotice} onClose={() => setSelectedId(null)}/></div>}</>}
        </>}
        <footer className="page-footer"><span>Made for your next move.</span><span><Icon name="star" size={12}/>AStra</span></footer>
      </div>
    </main>
    {needsAuth && <div className="modal-backdrop"><section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title"><span className="brand-mark"><Icon name="star" size={28}/></span><span className="eyebrow">YOUR PRIVATE WORKSPACE</span><h2 id="auth-title">Welcome to AStra.</h2><p>Enter your server access token to connect. It stays in this browser tab’s session.</p>{error && <p className="auth-error" role="alert">{error}</p>}<form onSubmit={unlock}><label className="field-label" htmlFor="access-token">Access token</label><input id="access-token" type="password" value={token} onChange={event => setToken(event.target.value)} autoComplete="off" required autoFocus/><button className="button button-primary" disabled={authLoading}>{authLoading ? <Spinner/> : <Icon name="arrow" size={18}/>}Open my workspace</button></form><p className="field-help">Use the ASTRA_ACCESS_TOKEN configured on your server.</p></section></div>}
  </div>;
}

function Stat({ label, value, icon, tone, detail }: { label: string; value: number; icon: IconName; tone: string; detail: string }) { return <section className="stat-card"><div><span className="stat-label">{label}</span><strong className="stat-value">{String(value).padStart(2, '0')}</strong><span className="stat-detail">{detail}</span></div><span className={`icon-tile ${tone}`}><Icon name={icon} size={21}/></span></section>; }
function HowStep({ number, title, description }: { number: string; title: string; description: string }) { return <div className="how-step"><span>{number}</span><div><h3>{title}</h3><p>{description}</p></div></div>; }
function RunRow({ run, selected, onClick }: { run: ApplicationRun; selected: boolean; onClick: () => void }) { return <button className={`run-row ${selected ? 'selected' : ''}`} onClick={onClick}><span className="site-icon">{siteName(run.url).charAt(0).toUpperCase()}</span><span className="run-row-title"><strong>{siteName(run.url)}</strong><span>{run.url}</span></span><Status status={run.status}/><span className="run-date">{dateLabel(run.createdAt)}</span><Icon name="chevron" size={17}/></button>; }

function RunDetail({ run, onUpdate, onError, onNotice, onClose }: { run: ApplicationRun; onUpdate: (run: ApplicationRun) => void; onError: (error: unknown) => void; onNotice: (message: string) => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [showScreenshot, setShowScreenshot] = useState(false);
  const [screenshot, setScreenshot] = useState('');
  const [screenshotError, setScreenshotError] = useState('');
  useEffect(() => { if (run.status === 'needs_input') { document.title = 'Action needed • AStra'; if ('Notification' in window && Notification.permission === 'granted') new Notification('AStra needs your help', { body: run.questions[0]?.label || 'Open AStra to continue.', tag: run.id }); } else document.title = 'AStra • Job applications'; }, [run.id, run.status]);
  useEffect(() => { setAnswers({}); setShowScreenshot(false); setScreenshot(''); setScreenshotError(''); }, [run.id]);
  useEffect(() => {
    if (!showScreenshot || !run.screenshot) return;
    let live = true; let imageUrl = '';
    const token = sessionStorage.getItem('astra-access-token');
    void fetch(`/api/runs/${encodeURIComponent(run.id)}/screenshot?t=${encodeURIComponent(run.updatedAt)}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }).then(async response => { if (!response.ok) throw new Error('The screenshot is not available yet.'); return response.blob(); }).then(blob => { if (!live) return; imageUrl = URL.createObjectURL(blob); setScreenshot(imageUrl); setScreenshotError(''); }).catch(err => { if (live) setScreenshotError(err instanceof Error ? err.message : 'Unable to load screenshot.'); });
    return () => { live = false; if (imageUrl) URL.revokeObjectURL(imageUrl); };
  }, [run.id, run.updatedAt, run.screenshot, showScreenshot]);
  async function action(endpoint: string, body?: object) { setBusy(true); try { const next = await api<ApplicationRun>(`/runs/${encodeURIComponent(run.id)}/${endpoint}`, { method: 'POST', body: JSON.stringify(body || {}) }); onUpdate(next); if (endpoint === 'answers') { setAnswers({}); onNotice('Answers sent. Your agent can continue.'); } if (endpoint === 'submit') onNotice('Submission authorized. AStra will check the result.'); } catch (err) { onError(err); } finally { setBusy(false); } }
  return <section className="card run-detail"><div className="section-heading"><div><span className="section-eyebrow">APPLICATION ACTIVITY</span><h2>{siteName(run.url)}</h2></div><button className="icon-button" aria-label="Close application details" onClick={onClose}><Icon name="close" size={18}/></button></div><div className="run-detail-meta"><Status status={run.status}/><a href={run.url} target="_blank" rel="noopener noreferrer" className="text-button">Open listing<Icon name="external" size={13}/></a></div>
    {run.result && <p className={`run-result ${run.status === 'submitted' ? 'confirmed' : ''}`}>{run.result}</p>}
    {run.compatibility && <div className="field-help" role="status"><strong>Form compatibility:</strong> {run.compatibility.status === 'checking' ? 'Checking for application fields' : run.compatibility.status === 'compatible' ? 'Recognized controls on this step' : 'Manual review needed'} · {run.compatibility.platform} · {run.compatibility.detectedFields} detected controls. {run.compatibility.status === 'compatible' ? 'This does not guarantee the employer will accept the application.' : ''}{run.compatibility.issues.length > 0 && <ul>{run.compatibility.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul>}</div>}
    {run.status === 'needs_input' && run.questions.some(q => q.type === 'manual') && <div className="question-panel"><h3>Continue in the AStra browser</h3><p>{run.questions[0]?.label}</p><p>Use the browser window opened by AStra on this computer. Opening the listing in another tab will not resume this session.</p><button className="button button-primary" disabled={busy} onClick={() => void action('answers', { answers: Object.fromEntries(run.questions.map(q => [q.key, 'Continue'])) })}>I’ve completed this — continue</button></div>}
    {run.status === 'needs_input' && !run.questions.some(q => q.type === 'manual') && <div className="question-panel"><h3>Over to you for a moment</h3><p>AStra needs these details to answer accurately. Your answers will be used for this application.</p>{run.questions.length ? <form onSubmit={event => { event.preventDefault(); void action('answers', { answers }); }}>{run.questions.map(question => <label className="question-field" key={question.key}><span>{question.label}{question.required && <span className="required-mark"> *</span>}</span>{question.type === 'select-multiple' ? <><textarea rows={2} required={question.required} value={answers[question.key] || ''} onChange={event => setAnswers(current => ({ ...current, [question.key]: event.target.value }))} placeholder="Example: Python; Java"/><small>Available choices: {question.options.join('; ')}</small></> : question.options.length ? <select required={question.required} value={answers[question.key] || ''} onChange={event => setAnswers(current => ({ ...current, [question.key]: event.target.value }))}><option value="">Choose an answer</option>{question.options.map((option, index) => <option key={`${index}-${option}`} value={option}>{option}</option>)}</select> : <textarea rows={2} required={question.required} value={answers[question.key] || ''} onChange={event => setAnswers(current => ({ ...current, [question.key]: event.target.value }))}/>}</label>)}<button className="button button-primary button-small" disabled={busy}>{busy ? <Spinner/> : <Icon name="arrow" size={16}/>}Continue application</button></form> : <p className="field-help">Read the latest activity for the action this site requires. Login and CAPTCHA may require manual intervention.</p>}</div>}
    {run.status === 'ready_to_submit' && <div className="review-panel"><Icon name="shield" size={22}/><h3>Your application is ready</h3><p>Review the latest browser screenshot, then authorize the final submission.</p><button className="button button-primary" disabled={busy} onClick={() => void action('submit')}>{busy ? <Spinner/> : <Icon name="check" size={18}/>}Submit application</button></div>}
    <div className="activity-log" aria-live="polite" aria-label="Application activity">{run.events.length ? run.events.slice(-12).map((event, index) => <div className={`activity-event event-${event.kind}`} key={`${event.at}-${index}`}><span className="event-dot"/><div><p>{event.message}</p><time dateTime={event.at}>{timeLabel(event.at)}</time></div></div>) : <p className="field-help">Your application is queued. Activity will appear here.</p>}</div>
    <div className="run-detail-actions">{typeof Notification !== 'undefined' && Notification.permission === 'default' && <button className="text-button" onClick={() => void Notification.requestPermission()}>Enable alerts</button>}{run.screenshot && <button className="text-button" onClick={() => setShowScreenshot(value => !value)}><Icon name="eye" size={16}/>{showScreenshot ? 'Hide browser' : 'View browser'}</button>}{activeStatuses.includes(run.status) && <button className="text-button danger-text" disabled={busy} onClick={() => void action('cancel')}>{busy ? <Spinner/> : <Icon name="close" size={15}/>}Stop application</button>}</div>
    {showScreenshot && <div className="screenshot-panel">{screenshotError ? <p className="field-help">{screenshotError}</p> : screenshot ? <a href={screenshot} target="_blank" rel="noopener noreferrer" aria-label="Open full application screenshot"><img src={screenshot} alt={`Current application page at ${siteName(run.url)}`}/></a> : <div className="screenshot-loading"><Spinner/><span>Loading browser view…</span></div>}</div>}
  </section>;
}

const basicFields: Array<[keyof Profile, string, string?, string?]> = [['firstName', 'First name', 'Alex', 'given-name'], ['lastName', 'Last name', 'Morgan', 'family-name'], ['email', 'Email address', 'alex@example.com', 'email'], ['phone', 'Phone number', '+1 (555) 000-0000', 'tel'], ['location', 'Location', 'San Francisco, CA'], ['country', 'Country', 'United States', 'country-name'], ['address', 'Street address', '123 Market Street', 'street-address'], ['city', 'City', 'San Francisco', 'address-level2'], ['region', 'State / region', 'California', 'address-level1'], ['postalCode', 'Postal code', '94103', 'postal-code'], ['linkedin', 'LinkedIn URL', 'https://linkedin.com/in/your-name'], ['website', 'Portfolio / website', 'https://your-website.com']];
const careerFields: Array<[keyof Profile, string, string?]> = [['currentTitle', 'Current / most recent title', 'Product Designer'], ['currentCompany', 'Current / most recent company', 'Company name'], ['yearsExperience', 'Years of experience', '5'], ['salaryExpectation', 'Salary expectation', 'USD 120,000–140,000 annually'], ['availableStartDate', 'Available start date', '2026-11-01']];
function ProfileEditor({ profile, onSave, onError }: { profile: Profile; onSave: (profile: Profile, message?: string) => void; onError: (error: unknown) => void }) {
  const [draft, setDraft] = useState<Profile>(profile);
  const [answerRows, setAnswerRows] = useState<Array<{ key: string; value: string }>>(() => Object.entries(profile.answers).map(([key, value]) => ({ key, value })));
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  const setField = (key: keyof Profile, value: string) => setDraft(current => ({ ...current, [key]: value }));
  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    try { const answers: Record<string, string> = {}; for (const row of answerRows) { if (row.key.trim() && row.value.trim()) answers[row.key.trim()] = row.value.trim(); } const { resume: _resume, ...editable } = draft; const next = await api<Profile>('/profile', { method: 'PUT', body: JSON.stringify({ ...editable, answers }) }); setDraft(next); onSave(next); }
    catch (err) { onError(err); } finally { setSaving(false); }
  }
  async function upload(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    try { const data = new FormData(); data.append('resume', file); const next = await api<Profile>('/resume', { method: 'POST', body: data }); setDraft(current => ({ ...current, resume: next.resume })); onSave(next, 'Your résumé is saved. Save your profile to keep any other edits.'); }
    catch (err) { onError(err); } finally { setUploading(false); if (uploadInput.current) uploadInput.current.value = ''; }
  }
  return <form className="profile-layout" onSubmit={save}>
    <div className="profile-fields">
      <section className="card profile-section"><div className="profile-section-heading"><span className="icon-tile lilac"><Icon name="person"/></span><div><h2>The essentials</h2><p>Your contact details, just as they should appear on an application.</p></div></div><div className="form-grid">{basicFields.map(([key, label, placeholder, autocomplete]) => <label className="form-field" key={key}><span>{label}{['firstName', 'lastName', 'email'].includes(key) && <span className="required-mark"> *</span>}</span><input type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : ['linkedin', 'website'].includes(key) ? 'url' : 'text'} required={['firstName', 'lastName', 'email'].includes(key)} value={String(draft[key] || '')} placeholder={placeholder} autoComplete={autocomplete} onChange={event => setField(key, event.target.value)}/></label>)}</div></section>
      <section className="card profile-section"><div className="profile-section-heading"><span className="icon-tile mint"><Icon name="bolt"/></span><div><h2>Your experience & preferences</h2><p>The details that help AStra give accurate, relevant answers.</p></div></div><div className="form-grid">{careerFields.map(([key, label, placeholder]) => <label className="form-field" key={key}><span>{label}</span><input type={key === 'availableStartDate' ? 'date' : 'text'} value={String(draft[key] || '')} placeholder={placeholder} onChange={event => setField(key, event.target.value)}/></label>)}<label className="form-field"><span>Authorized to work in your target country?</span><select value={draft.workAuthorization} onChange={event => setField('workAuthorization', event.target.value)}><option value="">Leave unanswered</option><option value="Yes">Yes</option><option value="No">No</option></select></label><label className="form-field"><span>Require visa sponsorship?</span><select value={draft.requiresSponsorship} onChange={event => setField('requiresSponsorship', event.target.value)}><option value="">Leave unanswered</option><option value="Yes">Yes</option><option value="No">No</option></select></label><label className="form-field full-width"><span>Education</span><textarea rows={2} placeholder="Degree, institution, and graduation year" value={draft.education} onChange={event => setField('education', event.target.value)}/></label><label className="form-field full-width"><span>Skills</span><textarea rows={2} placeholder="Your skills and tools, separated by commas" value={draft.skills} onChange={event => setField('skills', event.target.value)}/></label><label className="form-field full-width"><span>Professional summary</span><textarea rows={4} placeholder="A short overview of your experience, strengths, and the work you’re looking for." value={draft.summary} onChange={event => setField('summary', event.target.value)}/></label></div></section>
      <section className="card profile-section"><div className="section-heading"><div><h2>Reusable answers</h2><p>Save specific answers to questions you see often.</p></div><button className="text-button" type="button" onClick={() => setAnswerRows(current => [...current, { key: '', value: '' }])}><Icon name="plus" size={16}/>Add answer</button></div>{answerRows.length ? <div className="answer-rows">{answerRows.map((row, index) => <div className="answer-row" key={index}><label className="form-field"><span>Question or topic</span><input value={row.key} placeholder="e.g. Are you willing to relocate?" onChange={event => setAnswerRows(current => current.map((item, i) => i === index ? { ...item, key: event.target.value } : item))}/></label><label className="form-field"><span>Your answer</span><textarea rows={2} value={row.value} placeholder="e.g. Yes, within the United States." onChange={event => setAnswerRows(current => current.map((item, i) => i === index ? { ...item, value: event.target.value } : item))}/></label><button type="button" className="icon-button danger-text" aria-label={`Remove answer ${index + 1}`} onClick={() => setAnswerRows(current => current.filter((_, i) => i !== index))}><Icon name="trash" size={17}/></button></div>)}</div> : <div className="answers-empty"><Icon name="link" size={21}/><p>No saved answers yet. Add one to make your next application smoother.</p></div>}</section>
      <div className="profile-save"><p><Icon name="shield" size={16}/>Only save facts you can stand behind.</p><button className="button button-primary" disabled={saving || uploading}>{saving ? <Spinner/> : <Icon name="check" size={19}/>}Save profile</button></div>
    </div>
    <aside className="profile-aside"><section className="card resume-card"><div className="section-eyebrow">YOUR FIRST IMPRESSION</div><h2>A résumé that travels<br/>with you.</h2><p>Upload once. AStra attaches it wherever the application asks.</p><input ref={uploadInput} id="resume-upload" type="file" className="visually-hidden" accept=".pdf,.docx,.txt" onChange={event => void upload(event.target.files?.[0])} disabled={uploading}/><button type="button" className={`upload-zone ${draft.resume ? 'has-file' : ''}`} onClick={() => uploadInput.current?.click()} disabled={uploading}><span className="upload-icon">{uploading ? <Spinner/> : <Icon name={draft.resume ? 'file' : 'upload'} size={28}/>}</span><strong>{uploading ? 'Reading your résumé…' : draft.resume?.name || 'Choose your résumé'}</strong><span>{draft.resume ? 'Click to replace your file' : 'PDF, DOCX, or plain text · up to 10 MB'}</span>{draft.resume && <span className="resume-saved"><Icon name="check" size={13}/>Saved and ready</span>}</button><p className="resume-note">Your résumé is saved as soon as it uploads. Save your profile separately after editing your details.</p></section><section className="profile-note"><span className="icon-tile peach"><Icon name="shield"/></span><h3>Good answers start with real facts.</h3><p>Leave anything you’re unsure about blank. AStra pauses for missing information rather than inventing qualifications, personal details, or consent.</p><p>Sensitive demographic questions are yours to answer.</p></section></aside>
  </form>;
}

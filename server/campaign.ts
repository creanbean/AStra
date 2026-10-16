import { randomUUID } from 'node:crypto';
import type { ApplicationRun, Campaign, JobCandidate, SearchPreferences } from '../shared/types.js';
import type { Store } from './store.js';
import { canonicalUrl, discoverJobs } from './discovery.js';

type Dependencies = {
  discover?: typeof discoverJobs;
  apply: (job: JobCandidate, campaign: Campaign, signal: AbortSignal) => Promise<ApplicationRun>;
};
/** Serial durable queue: discover a small batch, apply immediately, then search again. */
export class CampaignRunner {
  private control?: AbortController;
  private task?: Promise<void>;
  constructor(private store: Store, private deps: Dependencies) {}
  get busy() { return !!this.task; }
  async start(preferences: SearchPreferences) {
    if (this.busy) throw new Error('A search campaign is already active.');
    const campaign: Campaign = { id: randomUUID(), preferences, status: 'running', rounds: 0, jobs: [], message: 'Searching for matching jobs…', createdAt: new Date().toISOString() };
    this.store.campaigns.push(campaign);
    this.launch(campaign);
    await this.store.save();
    return campaign;
  }
  async resume(id: string) {
    if (this.busy) throw new Error('A search campaign is already active.');
    const campaign = this.store.campaigns.find(c => c.id === id);
    if (!campaign || !['paused', 'failed'].includes(campaign.status)) throw new Error('This campaign cannot be resumed.');
    campaign.status = 'running';
    this.launch(campaign);
    await this.store.save();
    return campaign;
  }
  private launch(campaign: Campaign) {
    const controller = this.control = new AbortController();
    this.task = this.run(campaign, controller.signal).catch(error => {
      campaign.status = controller.signal.aborted ? 'paused' : 'failed';
      campaign.message = controller.signal.aborted ? 'Paused. Previously attempted applications will not be repeated automatically.' : error instanceof Error ? error.message : 'Campaign failed.';
    }).finally(async () => { await this.store.save(); this.control = undefined; this.task = undefined; });
  }
  async stop() { this.control?.abort(); await this.task; }
  private async run(c: Campaign, signal: AbortSignal) {
    let emptyRounds = 0;
    const attempted = () => c.jobs.filter(j => j.runId).length;
    while (!signal.aborted && attempted() < c.preferences.maxApplications) {
      let job = c.jobs.find(j => j.state === 'queued');
      if (!job) {
        if (c.rounds >= c.preferences.maxSearchRounds || emptyRounds >= 3) break;
        c.message = `Searching batch ${c.rounds + 1}; ${attempted()} applications attempted.`;
        await this.store.save();
        const excluded = [...new Set([...this.store.runs.map(r => canonicalUrl(r.url)), ...this.store.campaigns.flatMap(x => x.jobs.map(j => canonicalUrl(j.url)))])];
        const found = await (this.deps.discover || discoverJobs)(c.preferences, excluded, ++c.rounds, signal);
        signal.throwIfAborted();
        const seen = new Set(excluded);
        for (const candidate of found) {
          const url = canonicalUrl(candidate.url);
          if (!seen.has(url)) { seen.add(url); c.jobs.push({ ...candidate, url, state: 'queued' }); }
        }
        emptyRounds = c.jobs.some(j => j.state === 'queued') ? 0 : emptyRounds + 1;
        await this.store.save();
        continue;
      }
      // Also deduplicate jobs added manually after discovery.
      if (this.store.runs.some(r => canonicalUrl(r.url) === job!.url)) {
        job.state = 'skipped';
        job.outcome = 'Previously attempted; AStra will not automatically repeat a possibly submitted application. Check the prior run history.';
        await this.store.save(); continue;
      }
      job.state = 'running';
      c.message = `Applying: ${job.title} at ${job.company}`;
      await this.store.save();
      try {
        const run = await this.deps.apply(job, c, signal);
        job.runId = run.id;
        job.state = run.status === 'submitted' ? 'submitted' : run.status === 'failed' && run.compatibility?.status === 'needs_review' ? 'skipped' : 'failed';
        job.outcome = run.result || run.events.filter(event => event.kind === 'warning' || event.kind === 'error').at(-1)?.message || (run.status === 'submitted' ? 'Submission confirmed by the employer.' : 'Application stopped; inspect the run details.');
      } catch (error) {
        job.state = 'failed';
        job.outcome = error instanceof Error ? error.message : 'The attempt stopped before the browser could open.';
        if (signal.aborted) throw error;
        // Setup failures stop the campaign instead of consuming the queue silently.
        throw error;
      }
      await this.store.save();
    }
    signal.throwIfAborted();
    c.status = 'completed';
    c.message = `Finished: ${c.jobs.filter(j => j.state === 'submitted').length} confirmed submissions, ${c.jobs.filter(j => j.state === 'skipped').length} skipped (see each job's reason), ${c.jobs.filter(j => j.state === 'failed').length} failed, ${attempted()} attempts. ${attempted() >= c.preferences.maxApplications ? 'Application limit reached.' : 'Search budget reached or no new matching jobs found.'}`;
  }
}

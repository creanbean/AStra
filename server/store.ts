import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyProfile, type ApplicationRun, type Profile, type Campaign } from '../shared/types.js';

export class Store {
  readonly root: string;
  profile: Profile = structuredClone(emptyProfile);
  runs: ApplicationRun[] = [];
  campaigns: Campaign[] = [];
  private writes: Promise<void> = Promise.resolve();
  constructor(root: string) { this.root = path.resolve(root); }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'resumes'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.root, 'runs'), { recursive: true, mode: 0o700 });
    const read = async (name: string) => {
      try { return JSON.parse(await readFile(path.join(this.root, name), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
    };
    this.profile = { ...structuredClone(emptyProfile), ...await read('profile.json') };
    this.runs = await read('runs.json') ?? [];
    this.campaigns = await read('campaigns.json') ?? [];
    for (const c of this.campaigns) {
      if (c.status === 'running') { c.status = 'paused'; c.message = 'Server restarted. Resume to continue with unattempted jobs.'; }
      for (const j of c.jobs) if (j.state === 'running') j.state = 'failed';
    }
    for (const run of this.runs) {
      if (['queued', 'running', 'needs_input', 'ready_to_submit'].includes(run.status)) {
        run.status = 'failed';
        run.result = 'The server restarted. Start a new run; inspect the employer site first to avoid duplicate applications.';
        run.updatedAt = new Date().toISOString();
      }
    }
    await this.save();
  }
  save() {
    const snapshot = { profile: JSON.stringify(this.profile, null, 2), runs: JSON.stringify(this.runs, null, 2), campaigns: JSON.stringify(this.campaigns, null, 2) };
    this.writes = this.writes.catch(() => {}).then(async () => {
      for (const [name, value] of Object.entries(snapshot)) {
        const target = path.join(this.root, name + '.json');
        const temp = target + '.' + randomUUID() + '.tmp';
        await writeFile(temp, value, { mode: 0o600 });
        await rename(temp, target);
      }
    });
    return this.writes;
  }
  artifactDir(id: string) { return path.join(this.root, 'runs', id); }
}

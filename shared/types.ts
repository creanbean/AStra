export interface Profile {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  location: string;
  address: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
  linkedin: string;
  website: string;
  currentCompany: string;
  currentTitle: string;
  yearsExperience: string;
  workAuthorization: string;
  requiresSponsorship: string;
  salaryExpectation: string;
  availableStartDate: string;
  education: string;
  skills: string;
  summary: string;
  answers: Record<string, string>;
  resume?: { path: string; name: string; text: string };
}
export interface CompatibilityReport {
  platform: string;
  status: 'checking' | 'compatible' | 'needs_review';
  detectedFields: number;
  issues: string[];
  /** A positive result applies only to the currently rendered form step. */
  scope: 'current_step';
}
export type RunStatus = 'queued' | 'running' | 'needs_input' | 'ready_to_submit' | 'submitted' | 'failed' | 'cancelled';
export interface RunEvent { at: string; message: string; kind: 'info' | 'action' | 'warning' | 'error' }
export interface Question { context?: string; key: string; label: string; type: string; options: string[]; required: boolean }
export interface ApplicationRun {
  id: string;
  url: string;
  autoSubmit: boolean;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  events: RunEvent[];
  questions: Question[];
  screenshot?: boolean;
  compatibility?: CompatibilityReport;
  campaignId?: string;
  searchPreferences?: SearchPreferences;
  result?: string;
}
export interface BrowserAgentOptions {
  run: ApplicationRun;
  profile: Profile;
  artifactDir: string;
  signal: AbortSignal;
  onUpdate: (run: ApplicationRun) => Promise<void>;
  waitForInput: () => Promise<Record<string, string>>;
  waitForSubmit: () => Promise<void>;
  assertUrl: (url: string) => Promise<void>;
}
export interface AppConfig { aiConfigured: boolean; model: string; baseUrl: string; browserAvailable: boolean; requiresAccessToken: boolean }
export const emptyProfile: Profile = {
  firstName: '', lastName: '', email: '', phone: '', location: '', address: '', city: '', region: '', postalCode: '', country: '',
  linkedin: '', website: '', currentCompany: '', currentTitle: '', yearsExperience: '', workAuthorization: '', requiresSponsorship: '',
  salaryExpectation: '', availableStartDate: '', education: '', skills: '', summary: '', answers: {},
};

export interface SearchPreferences {
  description: string;
  level: 'entry-level' | 'internship';
  location: string;
  maxApplications: number;
  maxSearchRounds: number;
  autoSubmit: boolean;
}
export interface JobCandidate {
  url: string;
  title: string;
  company: string;
  location: string;
  reason: string;
  state: 'queued' | 'running' | 'submitted' | 'failed' | 'skipped';
  runId?: string;
  /** Last verified result from the browser attempt, not a job-fit rationale. */
  outcome?: string;
}
export interface Campaign {
  id: string;
  preferences: SearchPreferences;
  status: 'running' | 'paused' | 'completed' | 'failed';
  rounds: number;
  jobs: JobCandidate[];
  message: string;
  createdAt: string;
}

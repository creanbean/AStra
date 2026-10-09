# AStra

A local job application agent that reads your resume and profile, fills browser forms, uploads the resume, moves through application pages, and submits the application. The dashboard shows what the agent is doing and lets you supply missing answers without restarting.

## Run

Requires Node.js 24+ and Chromium. From this checkout:

```sh
npm ci
# Only needed when system Chromium is unavailable:
npx playwright install --with-deps chromium
cp .env.example .env
npm run dev
```

Open the Vite address printed by `npm run dev` in your local browser. The backend listens on port 3000; Vite proxies API requests. To run the built app, use `npm run build` followed by `npm start` and open the backend address printed in the terminal.

1. Save your real contact details, experience, work authorization, and any reusable answers in **Profile**.
2. Upload a text-based PDF, DOCX, or TXT resume (up to 10 MB). The uploaded file is the file attached to applications. Resume text helps the AI ground its answers.
3. Paste an application form URL, then choose **Apply & submit**. This authorizes completing and submitting that application. Review mode is available if you prefer a final checkpoint.
4. Answer any missing questions in the dashboard. The run resumes in the same browser session. These answers stay scoped to the current application; use your profile to save reusable answers explicitly. AStra records a successful result only when it sees application confirmation.

Only one application runs at a time. Do not run two applications to the same job concurrently. Cancellation during a submission or a server restart cannot undo a submitted application; check the employer's site before trying again.

## AI configuration

Set `AI_API_KEY` securely in your local `.env` or environment settings to enable OpenAI-compatible answering. The key stays on the backend and is never included in the dashboard or Git. The default endpoint is `https://api.openai.com/v1`, with model `gpt-4.1-mini`; override `AI_BASE_URL` and `AI_MODEL` for another compatible provider. The provider must support the chat completions API used in `server/answering.ts`.

Without a key, direct profile matches and saved answers still work, and missing information is requested from you. The AI is instructed to use your actual resume and profile, select only valid options, and request input rather than invent qualifications. Review your profile and reusable answers carefully: automated submissions use those facts. Resume and profile information needed to answer a question is sent to your configured AI provider when AI is enabled.

## Supported workflow and limits

AStra handles standard HTML fields, native dropdowns, radio groups, checkboxes, resume uploads, ARIA comboboxes, forms in frames, and successive application steps. Its agent inspects the current page rather than relying on a single employer's template. The tests use actual Chromium and assert the employer fixture received the final application POST and resume attachment.

No generic browser agent can guarantee every employer website. Site-specific widgets, closed shadow roots, account creation, logins, anti-bot challenges, assessments, and unusual validation may require manual completion or additional adapters. AStra stops or asks for input when it cannot safely proceed. It does not bypass CAPTCHAs or invent personal, demographic, legal, or qualification answers. A click on Submit without confirmation is not reported as a completed application.

Browser contexts are isolated per application. Account passwords are not stored, and login sessions are not imported. The application is intended for a trusted single user. Resume files, profile data, run history, and screenshots are retained in `.astra/` (ignored by Git); delete that directory when the server is stopped to erase local records. Keep this directory private and do not commit screenshots or personal data.

The server binds to localhost by default. To expose it beyond localhost, set a strong `ASTRA_ACCESS_TOKEN` and `ASTRA_ALLOWED_ORIGINS` (comma-separated exact origins), and use HTTPS through your deployment's reverse proxy. Application browser requests reject local/private addresses. This guard does not replace an isolated runtime or outbound firewall for a public multi-user deployment.

## Development

```sh
npm run build       # TypeScript and production frontend bundle
npm test            # Unit tests and real-browser submission fixtures
npm run test:browser
```

The browser uses `BROWSER_EXECUTABLE_PATH`, `/usr/bin/chromium` when present, or Playwright's downloaded Chromium. The source is split into `web/` (React dashboard), `server/` (API, persistence, browser agent, answering), `shared/` (contracts), and `tests/` (fixtures and regression tests). GitHub Actions installs Chromium and runs the build and tests.

Each cloud task already has an isolated checkout. Use the existing `/workspace/AStra` checkout; do not create a worktree unless explicitly requested. Start the server again in each new task because live processes do not survive environment snapshots.

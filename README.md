# AStra — find and apply to electrical engineering jobs

AStra is a local app with a visible automation browser. Describe your target roles, choose **entry-level / new graduate** or **internship**, specify a location, upload your PDF resume, and click **Find jobs & apply**. It discovers live listings, checks each listing against your criteria, and works through applications using your profile and resume.

## Easiest setup

1. Install **Node.js 24 LTS** from https://nodejs.org.
2. Download this repository with **Code → Download ZIP**, and extract it.
3. **Windows:** double-click `Start-AStra.bat`. **Mac:** run `bash Start-AStra.command` in Terminal from the extracted folder (or double-click it if macOS permits).
4. The setup asks for your **OpenAI API key**, installs Chromium, and builds the app. API usage is separately billed; a ChatGPT subscription alone does not provide an API key or credits. The terminal key entry is visible, so enter it privately.
5. Open **http://127.0.0.1:3000**. Keep the launcher terminal open while applications run.

Or, from Terminal:

```sh
npm run setup
```

The launcher saves configuration to your local, Git-ignored `.env`. **Existing installations:** edit `AI_MODEL=gpt-6.1-sol` in `.env` and restart; downloading updated code does not overwrite the model saved during your first setup. To change the API key/model later, edit that file and restart. Subsequent launches reuse it. If port 3000 is occupied, set `PORT` in `.env` and open that port instead. On Linux, install browser dependencies using `npx playwright install --with-deps chromium` if needed.

## Use it

1. In **My profile**, save your name, email, phone, location, education, experience, work authorization and reusable answers. Fill in facts you want the bot to use; it cannot derive your preferences or every legal answer from a resume.
2. Upload a **text-based PDF resume** (up to 10 MB; DOCX/TXT also supported). AStra extracts its text for answers and attaches the original file to applications. Image-only/scanned PDFs need OCR first.
3. Under **Find + apply automatically**, describe your desired roles, select internship or entry-level, and specify geographic/remote constraints.
4. Set a maximum number of **application attempts** and **search batches**. Start small to validate your profile. Unsuccessful and interrupted application attempts count toward the limit; these are not promised successful submissions.
5. Click **Find jobs & apply**. Auto-submit is enabled unless you check **Review each application before submission**.
6. If AStra asks for missing facts, answer in the dashboard. If it encounters CAPTCHA, login, an email code, or an unusual widget, complete that step in the **browser window opened by AStra**, then click **I've completed this — continue**. A separate tab opened from the listing link does not share the automation session. Optional desktop alerts are available in application activity.

The queue searches for up to five jobs per batch and begins applying immediately. It searches again after the batch, until the application/search limit or three empty search batches. The job list includes clickable sources and fit reasons. **Pause campaign** stops the active browser run; resuming processes untouched jobs, not interrupted applications. Individual runs can be stopped from application activity.

A direct URL application tool remains available below the campaign panel.

## How the agent works

- **Live discovery:** Responses API web search finds individual employer/ATS listings, including startups. Extracted URLs must appear in search sources. Senior titles, duplicate URLs and unsupported URL schemes are filtered.
- **Match check:** Before sending profile data in a campaign, the agent checks actual listing text against role, level and location, requiring quoted page evidence. Ambiguous/nonmatching listings stop that attempt. This is AI-assisted matching and can make mistakes.
- **Form understanding:** Reads rendered controls and labels, fieldset context, native selects, radio groups, checkboxes, ARIA comboboxes, iframes and open shadow roots. Answers use saved facts first, then resume-grounded AI with evidence validation. Dropdown answers must match an offered choice.
- **Adaptive navigation:** Recognizes common buttons and uses a bounded AI planner for unfamiliar navigation. The model chooses a visible control rather than executing arbitrary code.
- **Human handoff:** AStra fills detectable form fields before pausing for an actual visible CAPTCHA, sign-in, or verification step. reCAPTCHA v3/invisible badges, empty reCAPTCHA token fields, and “Protected by reCAPTCHA” branding alone do not trigger a pause; verification often runs only at submission. If an interactive checkbox/image challenge appears, the visible browser stays open while you solve it. AStra never solves/bypasses CAPTCHA. Ordinary missing answers are supplied in the dashboard and stay scoped to that application unless explicitly saved to your profile.
- **Submission tracking:** Counts success only after fresh confirmation from the employer page. No automatic repeat of an uncertain final click. Canonical URL deduplication persists across runs; different aliases for the same job may still escape deduplication.

## Application form compatibility (current page only)

AStra identifies common applicant-tracking hosts (Greenhouse, Lever, Ashby, Workday, SmartRecruiters, iCIMS, Taleo, SuccessFactors, Jobvite, BambooHR, Recruitee, and Workable), **but recognition of a host is not certification that its form is supported**. Compatibility is re-assessed against the DOM and accessible controls after each navigation step:

- **Recognized controls:** native text, email, telephone, number, date and file inputs; textarea; select (single and multiple); radio groups; checkboxes; ARIA comboboxes and listbox menus; React-style sibling toggles; visible portal options; ordinary dynamic input fields; open shadow roots and iframes. Native multi-select answers come only from explicit saved answers or matched profile skills, never invented data.
- **Needs review:** visible required elements the agent cannot identify, custom multi-select listboxes, uncommon rich controls or inaccessible frames. The dashboard explains the reason and displays the current ATS family. In a job-search campaign AStra **skips** such an application rather than trying to submit it. For a direct link, it asks you to complete the widget in the actual AStra browser and requires an additional submission confirmation.
- **Checking:** no application controls are visible yet, e.g. on a job description landing page. The agent discovers the form after navigation and evaluates the next step.

Compatibility reports are for the **current rendered step**, not a promise about all steps, account login, bot verification, employer-side server validation, or whether the employer accepted the application. Before submission AStra re-scans the form for conditional required fields. It never bypasses CAPTCHA, creates fictitious qualifications, or submits on a flagged unsupported form without a manual review.

For implementation choices, see the [W3C combobox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/), [Playwright select options](https://playwright.dev/docs/input), [Lever application form fields](https://hire.lever.co/developer/documentation), [Ashby application form fields](https://docs.ashbyhq.com/application-forms), and [SmartRecruiters screening field types](https://developers.smartrecruiters.com/docs/get-application-screening-questions-and-privacy-policies).

## Configuration

Default AI model is `gpt-6.1-sol`; set `AI_MODEL` to a model available in your API account. `AI_BASE_URL` defaults to `https://api.openai.com/v1`. Automatic discovery and form answering use the **Responses API**; discovery also requires **web_search + JSON output**. A provider that merely exposes chat completions cannot run AStra's AI workflows. The Sol model's default reasoning effort in AStra is medium.

Official API references: [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [structured output](https://developers.openai.com/api/docs/guides/structured-outputs).

```dotenv
AI_API_KEY=your-key-here
AI_MODEL=gpt-6.1-sol
AI_BASE_URL=https://api.openai.com/v1
ASTRA_HEADLESS=false
PORT=3000
HOST=127.0.0.1
```

Do not commit `.env`. Keep `ASTRA_HEADLESS=false` for local use so you can complete CAPTCHA/login. `BROWSER_EXECUTABLE_PATH` can select an installed Chromium executable. Without an API key, only the direct-link workflow and saved-fact answering are available.

## Scope and privacy

This is a working local application agent, **not a guarantee of hands-free applications on every employer site**. Mandatory consents require an explicit saved or run-specific answer. Unsupported widgets, closed shadow DOM, inaccessible job descriptions, assessments, account creation and some site defenses require your intervention. Sensitive traits and missing qualifications are never intentionally inferred. Workday and other ATS layouts vary; there are no claims of universal site certification.

The app runs on your computer rather than in a Chrome extension because this workflow needs long-running queues, local PDF parsing, controlled file uploads and an inspectable browser. The dashboard uses your ordinary browser; applications use a separate Chromium window. Login sessions are scoped to a single application; you may need to log in again for another employer/run.

Profile/resume text and application page text needed for AI decisions are sent to your configured AI provider. Search sends your role preferences and excluded job URLs, not your resume/contact details. Selected profile answers and the resume are sent to employers when completing applications. The API key stays on the backend.

Local profile, resume, history and screenshots are stored in Git-ignored `.astra/`; keep this directory private. Stop the server and delete it to erase local records. Restarted in-progress runs are marked interrupted and campaigns are paused. Review the employer site before retrying any interrupted/uncertain application. The UI intentionally does not offer automatic retries for previously attempted job URLs.

The server binds to localhost. Do not expose it publicly without appropriate authentication and isolation. Existing `ASTRA_ACCESS_TOKEN` and exact `ASTRA_ALLOWED_ORIGINS` configuration remain available. Browser network requests block local/private destinations, but this is not a substitute for an outbound firewall in a multi-user deployment.

## Development and verification

```sh
npm ci
npx playwright install --with-deps chromium
npm run build
npm test
npm run dev
```

Tests cover real Chromium form POSTs, original resume uploads, multiple application pages, native/custom dropdowns, radio groups, iframe/shadow controls, missing-answer continuation, CAPTCHA-style handoff, unfamiliar-button navigation, final confirmation and avoiding duplicate final clicks. Discovery and model decisions are mocked in automated tests; real employer acceptance and live AI quality are not proven by fixtures. Queue tests cover immediate application, caps, deduplication, pause/resume, restart recovery and empty-search limits.

Source: `web/` dashboard, `server/discovery.ts` search, `server/campaign.ts` queue, `server/agent.ts` forms, `server/navigation.ts` navigation/handoff, `server/answering.ts` grounded answers. GitHub Actions runs the build and tests.

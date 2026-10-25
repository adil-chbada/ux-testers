# ux-testers

AI test users for anything that runs in a browser: web apps, websites, dashboards, browser games, and mobile apps
that have a web build. Each tester plays a person (languages, tech skills, device, background, goal) and tries to do
something in your app, in a real browser on your **local dev server**. It never sees your code. You get:

- **a report page** (`report.html`): who managed what, every finding with its screenshot, and a ▶ button that plays
  the exact moment in the tester's video;
- **findings** colour-coded as they happen: 🔴 issue · 🟠 bad UX · 🟣 bad UI · 💡 smart idea · 🔤 language · 💚 praise;
- **videos** of every visit, with the tester's thoughts on screen, in English or in English plus a second language
  of your choice (Arabic, French, Spanish…).

It runs on a Claude subscription through the Claude CLI (nothing billed per token) and refuses to touch production.

## Install

**The easy way:** ask Claude Code, in one message:

> Install ux-testers from https://github.com/adil-chbada/ux-testers

**Or yourself**, in a terminal:

```bash
git clone https://github.com/adil-chbada/ux-testers && cd ux-testers
bash install.sh
```

The installer sets up everything (Bun if you agree, the packages, the browser, the Claude skill) and ends with a
check. The only step it cannot do for you: if the check says the Claude CLI is not signed in, run `claude auth login`.

## Use it

**1. Describe your app, once** (it asks a few questions: name, local address, production domains):

```bash
bun run init my-app
```

**2. Start your app's dev server**, as you usually do.

**3. Run the testers:**

```bash
bun run ux my-app
```

You see each tester's progress live. When they finish:

```bash
bun run view          # opens the newest report in your browser, videos included
```

**Or just ask Claude:** "run 2 test users on my-app" or "UX-test my app at http://localhost:3000, goal: sign up and
create a project". The skill tells Claude every step.

Something not working? `bun run doctor my-app` checks everything and says how to fix each problem.

## More ways to run

```bash
bun run ux my-app --random 3                                 # 3 random testers
bun run ux my-app --personas retiree-low-tech,power-user-pro \
  --goal "Create an account and invite a teammate"           # the same task for a low-tech and a high-tech tester
bun run ux my-game --goal "Learn how to play and finish one round"
bun run ux my-app --admin                                    # testers who need a team member to create their account
bun run ux my-app --account --goal "make your first quote"   # every tester starts signed-up (dev account made for them)
bun run ux my-app --headed                                   # watch the browsers while they work
bun run ux --help                                            # every option
bun run view runs/my-app/<date-time>                         # open a past run's report
bun run report runs/my-app/<date-time>                       # rebuild a past run's report
```

| Option | Default | What it does |
|---|---|---|
| `<app>` | | The app folder (`apps/<app>/`); its saved address, testers and goal are used. |
| `--url` | from `app.yaml` | The app's local address. Only `localhost`, `127.0.0.1`, `[::1]`, `*.localhost`, `*.test`. |
| `--personas a,b` | from `app.yaml` | Which testers, by file name (in `apps/<app>/personas/`, else `personas/`). |
| `--random N` | 3 | N random testers. |
| `--goal "…"` | from `app.yaml`, else each tester's own | One task for every tester. |
| `--steps` / `--minutes` | 60 / 15 (25 with `--admin`) | Most actions and time per tester (waiting for the admin does not count). |
| `--admin` | off | Testers can ask a team member for an account (see below). `--admin-minutes`: 10. |
| `--account` | off | Each tester starts with an account already made in your **dev** database (see below), for tasks that happen after sign-in. |
| `--model` | `sonnet` | Claude model for the testers. |
| `--headed` | off | Show the browsers. |
| `--throttle` | off | Each persona's network speed (slow 3G…); use a production-like build. |
| `--second-language` | from `app.yaml`, else none | Testers also write every thought, finding and message in this language (`ar`, `fr`, `es`…); `none` for English only. |
| `--json` | off | Print a JSON summary at the end (for scripts and AI agents). |

## Reading the results

Each run is a folder `runs/<app>/<YYYY-MM-DD-HHMM>/` (UTC; not in git). Open its **`report.html`** with `bun run view`
(a viewer on your computer only, so the videos play in any browser; the screenshots are inside the page, so the
file alone also shows them when you send it):

- the testers: goal reached or not, would they sign up and why, ▶ watch the whole visit;
- every finding as a card: what they expected and what happened (plus the second language, if set), the screenshot (click to
  enlarge), and **▶ Play at 1:11** to see that moment; filter by kind or by tester;
- the top issues, grouped across testers, with steps to reproduce.

In the videos: the bottom box is what the tester is thinking; a coloured banner at the top is a finding, with the
element outlined; a chat bubble is a message between a tester and the admin. Videos are saved as `.webm` and, when
ffmpeg is installed, also `.mp4` for phones.

Also in the folder: `findings.md` and `report.md` (the same as text), `summary.json` (for tools), and one folder per
tester (`video`, `shots/`, `steps.jsonl`, `notes.jsonl`, `finish.json`, `trace.zip`…).

## Your app's folder

`bun run init` creates `apps/<app>/`. Only `apps/example/` is in git, so your own apps stay private.

| File | What it is |
|---|---|
| `app.yaml` | Name, local address, default testers and goal, production domains, team name, second language, admin settings. `apps/example/app.yaml` explains every setting. |
| `README.md` | Notes for whoever runs the tests (people and AI agents read it first): how to start the dev server, test data. |
| `personas/*.yaml` | This app's own testers. Without it, the examples in `personas/` are used. |
| `admin.yaml`, `admin.local.json`, `scripted-admin.ts` | For `--admin` (see below). |

## Languages

English by default. Add `second_language: ar` (any two-letter code) to `app.yaml`, or `--second-language ar` for one
run, and testers also write every thought, finding and message in that language; the video, `findings.md` and
`report.html` then show both (right-to-left for Arabic, Hebrew, Persian and Urdu). Finding labels have Arabic
versions built in (`src/lang.ts`); other languages keep the English label.

## Testers

The examples in `personas/`: a retiree with poor eyesight (low tech, slow phone), a busy parent (iPhone), a student
gamer, a power user (PC), and a shop owner who reads only Arabic. **Add one:** copy a file into `apps/<app>/personas/`,
rename it, set `id` to the new file name, and change what matters:

- `tech.level` (`low`, `medium`, `high`): how boldly they click; low-tech testers ignore unlabelled icons.
- `tech.device` (`android-budget`, `iphone`, `pc`): screen size, touch, browser.
- `languages.reads` and `languages.ui_choice` (or `locale: pt-BR`): what they read, and their browser's language.
- `patience` (`low`, `medium`, `high`): about 3, 6 or 10 dead ends before they give up.
- `business`, `pains`, `doubts`: their background (for a game: what kind of player), so their judgement rings true.
- `goal`: what they come to do; `explore freely` lets them roam.

A mistake in a file is reported with the file, the setting and what is wrong.

## Testers that need an account

Some apps do not let a newcomer in alone: a team member creates or approves the account. With `--admin`:

1. The tester asks through the app like a real visitor, then writes to the team (`ask_admin`).
2. An **admin agent** opens your dev admin screens in its own recorded browser, creates the account with the
   tester's fake identity, and replies with the login (a chat bubble in both videos).
3. If the AI admin does not answer, a **scripted admin** (no AI) does the same job through your dev API.
4. The tester signs in and carries on.

**Skip the wait with `--account`.** To test what happens after sign-in (a first quote, a settings page…), the runner
makes each tester's account before the browser opens, with the same `scripted-admin.ts`, and tells the tester in its
prompt "you already have an account" with the sign-in message. Nothing is asked of a team member, no AI admin runs, and
the accounts exist only in your dev database. Combine `--admin` (sign-up flow) and `--account` (after sign-in) in
separate runs so each has its own goal.

It needs, in `apps/<app>/`: `admin.yaml` (the admin persona), `admin.local.json` (`{ "phone": "…", "password": "…" }` of
an admin that exists **only in your dev database**), `admin` paths in `app.yaml`, and `scripted-admin.ts` (your
API calls). `bun run init <app> --admin` copies templates for the first and the last.

## For AI agents

- **`AGENTS.md`**: the rules (install, run, never production, subscription only, what never to commit).
- **`--json`**: `bun run ux <app> --json` prints a JSON summary at the end; `bun run doctor <app> --json` says
  whether everything is ready and how to fix what is not.
- **Exit codes**: 0 the run finished, 1 setup problem, 2 refused (not local, not a subscription), 3 a tester reached a
  production site and was stopped.
- **MCP server** (`bash install.sh --mcp`, or `claude mcp add --scope user ux-testers -- bun <path>/src/mcp.ts`):
  `doctor`, `list_apps`, `list_testers`, `start_test` (returns at once), `test_status`, `get_results`.
- **Skill**: `skill/SKILL.md`, linked into `~/.claude/skills/` by the installer.

## Troubleshooting

| You see | Do this |
|---|---|
| Anything unclear | `bun run doctor <app>`: every problem comes with its fix. |
| `Refusing to start: … is not a local dev URL` | Use a local address. Production is never allowed. |
| `Nothing answers at …` | Start the app's dev server first. |
| `the Claude CLI is not signed in` | Run `claude auth login` yourself, in a terminal. |
| `not a Claude subscription` | The CLI is set to an API key or a cloud provider; sign in with a Claude account. |
| `Your settings need a fix` / `A tester file needs a fix` | The message names the file and the setting; fix that line. |
| The tester says the team did not answer | The model refused to start the admin agent ("safeguards flagged" in `<tester>-admin-<n>/claude.stderr.log`); it is retried, then the scripted admin takes over. |
| A visit ends with "ended without finishing" | Usually the same model refusal mid-visit; run again. |
| Findings about things you already fixed | The dev server runs an old build. |
| `STOPPED: … production site` | A tester reached a production domain; the run stopped on purpose. |

## Safety

- **No code access.** Each tester is a `claude -p` process with no built-in tools (no shell, files or web), none of
  your Claude settings, hooks or plugins, in an empty folder. Its only tools are 10 browser actions.
- **Dev only.** Non-local addresses are refused; the app's production domains are blocked at DNS and reaching one
  stops the run; links to other sites are blocked.
- **Fake data only.** Every tester gets a generated identity and is told never to enter card details.
- **Subscription only.** No API key is ever passed to a tester; the run refuses to start otherwise.

## Usage

Each run counts against your Claude plan's limits; nothing is billed per token. The report shows an estimate "at
API prices" as a sense of size: roughly $0.20–0.70 per tester visit with the default model.

## How it works

| File | Role |
|---|---|
| `install.sh` | One-step install and check. |
| `src/run.ts` | `bun run ux`: checks, live progress, runs testers in parallel, the report, `--json`. |
| `src/init.ts`, `src/doctor.ts` | `bun run init`, `bun run doctor`. |
| `src/mcp.ts` | The MCP server for AI agents. |
| `src/agent.ts` | Starts one tester (`claude -p`), retries a refused start. |
| `src/browser-mcp.ts` | The tester's browser (Playwright) and its tools: guard, recording, overlays, `ask_admin`. |
| `src/overlay.ts` | What the video shows: thought box, chat bubble, finding banner. |
| `src/persona.ts`, `src/app.ts` | Testers and app settings (with plain-language errors), prompts. |
| `src/report.ts`, `src/report-html.ts` | `report.md`, `findings.md`, `summary.json`, `report.html`. |
| `src/view.ts` | `bun run view`: serves the runs on this computer so reports play their videos. |
| `src/guard.ts`, `src/scripted-admin.ts`, `src/progress.ts` | Dev-only rules; the no-AI admin; run progress. |

## Limits

- Testers act on what the page exposes as controls (buttons, links, fields). HTML apps and sites work, and so do
  apps and games with accessibility semantics (Flutter web does). **Canvas-only games** (pure WebGL/canvas) are not
  covered yet: testers can see them but cannot click at screen coordinates.
- These are AI personas: treat their findings as leads to check with real people.
- The thoughts on screen are what the tester writes for you, not the model's hidden reasoning.
- Large text and screen readers are not simulated.
- The model's safety check sometimes refuses to start a visit; admin-style prompts are refused more often.

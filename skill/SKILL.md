---
name: ux-testers
description: Run AI test users (personas with languages, tech skills, device and background) on a web app, website or browser game running on a LOCAL dev server, and get videos with their thoughts (English, optionally plus a second language such as Arabic), colour-coded findings (issue, bad UX, bad UI, smart idea) and a ranked report. Use when the user says "run test users", "AI testers", "UX test", "let personas try the app/game", "test the onboarding with fake users", or wants UX feedback on an app before showing it to real people. Never against production.
---

# UX testers

The tool is this skill's repository (`ux-testers`, the folder that holds `skill/SKILL.md`); its README has every
option. Each tester is a `claude -p` process whose only tools are 10 browser actions; it never sees code, settings
or files.

## Steps

Follow the repo's `AGENTS.md`. In short:

0. **Not installed?** Clone the repo and run `bash install.sh` (add `--mcp` for the MCP server). If the Claude CLI is
   not signed in, the user runs `claude auth login`; never sign in for them.
1. **Ready?** `bun run doctor <app> --json`; relay each `fix` when `"ready"` is false.
2. **Which app.** `apps/<app>/`; if it has a `README.md`, read it first (how to start that app's dev server, test
   data). No folder yet: `bun run init <app> --name "…" --url http://localhost:<port> --prod <domains> --yes` (ask the
   user for the production domains).
3. **Dev server up**, on localhost, running the code the user wants tested, with outgoing email, SMS and chat
   notifications off and a dev database: testers sign up and submit forms with fake data.
4. **Run in the background** (2 to 30 minutes): `bun run ux <app> --json [--personas a,b] [--goal "…"] [--admin | --account]`.
   The address, testers and goal saved in `apps/<app>/app.yaml` are used when not given. The same `--goal` on a
   low-tech and a high-tech persona shows the gap best; for a game, "learn how to play and finish one round". Add
   `--admin` when new users need a team member to create their account (needs the app's admin files), or `--account`
   to start every tester already signed-up with a dev account (needs `scripted-admin.ts` and `admin.local.json`). English only
   unless the app sets `second_language` (or pass `--second-language ar`).
5. **Results**: the last stdout line is a JSON summary. Send the user `report_html` (it plays each finding's moment
   in the video) and the main findings from `findings.md`.

## Gotchas

- "The Claude CLI cannot answer … claude auth login" or "not signed in": the CLI's own login (separate from any app
  login). The user runs `claude auth login`; never sign in for them.
- **Subscription only, never per-token billing**: the runner refuses unless the CLI uses a Claude subscription, and
  strips API keys from every tester. Never add an API key or a paid provider. The `$` in the report is an estimate.
- The runner refuses a non-local URL, and stops a tester that reaches one of the app's `prod_domains`.
- The model's safety check sometimes refuses to start a visit ("safeguards flagged"), at random and more often for
  the admin agent; it is retried, and `apps/<app>/scripted-admin.ts` (if present) takes over for the admin.
- Findings are only as fresh as the dev server's code: check it runs what the user wants tested.
- Canvas-only games are not covered (testers cannot click at coordinates); HTML or semantics-based UIs are.
- `bun test` (≈20 s) checks the guard, the tools and the recording without calling a model.

# ux-testers: rules for AI agents

You are working in a tool that runs AI test users on a web app, website or browser game on a **local** dev server.
People read `README.md`; this file is for you (Claude, Codex, Gemini, any agent).

## Install (when asked to "install ux-testers")

```bash
bash install.sh            # add --mcp to also register the MCP server; --yes installs Bun without asking
```

Then show the user the check's result. If the Claude CLI is not signed in, tell the user to run `claude auth login`
themselves. Never sign in for them, never ask for or type a password.

## Run (when asked to "run test users", "UX test my app"…)

1. `bun run doctor <app> --json`: proceed only when `"ready": true`; otherwise relay each `fix` to the user.
2. No `apps/<app>/` yet? `bun run init <app> --name "…" --url http://localhost:<port> --prod <domains> --yes`.
   Ask the user for the production domains if you do not know them.
3. If `apps/<app>/README.md` exists, read it before starting the app's dev server or running anything.
4. Run in the background (it takes 2 to 30 minutes): `bun run ux <app> --json [--personas a,b] [--goal "…"] [--admin]`.
   The last stdout line is a JSON summary. Exit codes: 0 finished, 1 setup problem, 2 refused, 3 stopped for
   reaching production.
5. Show the user the main findings, and tell them `bun run view` opens the report with its videos (or open
   `report_html` from the summary yourself; its screenshots are inside the page).

With the MCP server: `doctor`, `list_apps`, `list_testers`, `start_test` (returns at once), `test_status`,
`get_results`.

## Never

- Point it at production, or add a production address to `--url`. Do not weaken `src/guard.ts`.
- Add an API key, `ANTHROPIC_API_KEY`, or any paid model provider: it runs on a Claude subscription only.
- Commit anything in `apps/` except `apps/example/`, or anything in `runs/`: they hold private app details and
  recordings. Keep app-specific details out of `src/`, `personas/`, `skill/` and the docs.
- Use real personal data in personas or forms; testers use generated fake identities.

## Change the tool

- `bun test` must pass (about 20 s, no AI used). Add a test for new behaviour.
- Tests write only to temp folders (`mkdtemp`); never delete a path computed from `runs/`, `apps/` or the repo.
- App-specific behaviour belongs in `apps/<app>/` (settings, personas, `scripted-admin.ts`), never in `src/`.
- Keep `README.md`, `skill/SKILL.md` and this file in step with what the code does.

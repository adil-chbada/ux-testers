#!/usr/bin/env bun
// Run AI test users on a local app, then write the report.
//   bun run ux <app>                       URL, testers and goal from apps/<app>/app.yaml
//   bun run ux <app> --url http://localhost:3000 [--personas a,b | --random 3] [--goal "…"] [--minutes 15] [--admin] …
//   bun run ux --help
// Exit codes: 0 the run finished (whatever the testers managed), 1 setup problem, 2 refused (not a local address,
// not a Claude subscription), 3 a tester reached a production site and was stopped.
// Results: runs/<app>/<YYYY-MM-DD-HHMM>/ (report.html first). --json prints a summary on stdout at the end.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { runAgent, subscriptionProblem, type AdminSetup } from "./agent";
import { ConfigError, loadApp, ROOT } from "./app";
import { isDevUrl, setProdDomains } from "./guard";
import { lang2 } from "./lang";
import { listPersonas } from "./persona";
import { testerProgress } from "./progress";
import { makeReport } from "./report";

const HELP = `Run AI test users on your local app.

  bun run ux <app>                 use the URL, testers and goal saved in apps/<app>/app.yaml
  bun run ux <app> --url http://localhost:3000 --random 2

Options
  --url <address>        the app's local address (localhost, 127.0.0.1, *.localhost, *.test)
  --personas a,b         testers by file name        --random <n>   n random testers (default 3)
  --goal "<task>"        one task for every tester   --steps <n>    most actions (default 60)
  --minutes <n>          most minutes per tester (default 15, 25 with --admin)
  --admin                testers may ask a team member for an account   --admin-minutes <n> (default 10)
  --model <name>         Claude model (default sonnet)   --headed   show the browsers   --throttle   slow networks
  --second-language <code>   testers also write in this language, e.g. ar (default: English only; app.yaml second_language)
  --json                 print a JSON summary at the end (for scripts and AI agents)

First time? bun run init <app>, then bun run doctor <app>.`;

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: "string" },
    url: { type: "string" },
    personas: { type: "string" },
    random: { type: "string" },
    goal: { type: "string" },
    model: { type: "string", default: "sonnet" },
    steps: { type: "string" },
    minutes: { type: "string" },
    headed: { type: "boolean", default: false },
    throttle: { type: "boolean", default: false }, // persona network speed; against a production-like build only
    admin: { type: "boolean", default: false }, // testers may call ask_admin; an admin agent sets up their account
    "admin-minutes": { type: "string", default: "10" },
    json: { type: "boolean", default: false },
    "second-language": { type: "string" }, // e.g. ar; "none" for English only (overrides app.yaml)
    help: { type: "boolean", short: "h", default: false },
  },
});
if (o.help) {
  console.log(HELP);
  process.exit(0);
}

// With --json, stdout carries only the summary; everything for people goes to stderr.
const say = (msg: string) => (o.json ? console.error(msg) : console.log(msg));
const die = (msg: string, code = 1): never => {
  console.error(msg);
  if (o.json) console.log(JSON.stringify({ ok: false, exit: code, error: msg }));
  process.exit(code);
};

const appId = o.app ?? positionals[0] ?? "app";
let app: ReturnType<typeof loadApp>;
try {
  app = loadApp(appId);
} catch (e) {
  die(e instanceof ConfigError ? `Your settings need a fix:\n${e.message}` : String(e));
}
const cfg = app!.config;
if (!existsSync(app!.dir) && appId !== "app") say(`No folder apps/${appId}/ yet: using general settings. Create it with: bun run init ${appId}`);
setProdDomains(cfg.prod_domains);

const url = o.url ?? cfg.url;
if (!url) die(`Which address? Give --url http://localhost:<port>, or save url: in apps/${appId}/app.yaml (bun run init ${appId}).`);
if (!isDevUrl(url!)) die(`Refusing to start: ${url} is not a local dev URL (localhost, 127.0.0.1, [::1], *.localhost, *.test).`, 2);
const res = await fetch(url!, { redirect: "manual" }).catch(() => die(`Nothing answers at ${url}: start the app's dev server first.`));
const to = res.headers.get("location");
if (to && !isDevUrl(new URL(to, url))) die(`Refusing to start: ${url} redirects to ${to}, which is not a local dev URL.`, 2);

// Subscription only: refuse before starting anything if the CLI would bill per token.
const problem = subscriptionProblem();
if (problem) die(`Refusing to start: ${problem}.`, 2);

let admin: AdminSetup | undefined;
if (o.admin) {
  if (!existsSync(app!.adminLoginFile)) die(`--admin needs a dev admin login in ${app!.adminLoginFile}: { "phone": "…", "password": "…" } of an admin that exists only in your dev database.`);
  if (!existsSync(app!.adminPersonaFile)) die(`--admin needs the admin persona ${app!.adminPersonaFile} (see apps/example/admin.yaml).`);
  admin = { minutes: Number(o["admin-minutes"]), steps: 40 };
}

let all: ReturnType<typeof listPersonas> = [];
try {
  all = listPersonas(app!.personasDir);
} catch (e) {
  die(e instanceof ConfigError ? `A tester file needs a fix:\n${e.message}` : String(e));
}
const wanted = o.personas ? o.personas.split(",") : !o.random && cfg.personas ? cfg.personas : undefined;
const chosen = wanted
  ? wanted.map((id) => all.find((p) => p.id === id.trim()) ?? die(`Unknown tester "${id}". Known: ${all.map((p) => p.id).join(", ")}`))
  : all.sort(() => Math.random() - 0.5).slice(0, Number(o.random ?? 3));
const goal = o.goal ?? cfg.goal;
const l2 = lang2(o["second-language"] ?? cfg.second_language);
const steps = Number(o.steps ?? cfg.steps ?? 60);
const minutes = Number(o.minutes ?? cfg.minutes ?? (o.admin ? 25 : 15));

const stamp = new Date().toISOString().slice(0, 16).replace("T", "-").replace(":", "");
const runDir = join(ROOT, "runs", appId, stamp);
say(`${chosen.length} tester${chosen.length > 1 ? "s" : ""} on ${url}${goal ? ` · goal: ${goal}` : ""}${l2 ? ` · English + ${l2.name}` : ""}\nRun folder: ${runDir}\n`);

// --- live progress: one line per tester, redrawn on a terminal, printed on change otherwise ----------------------
function status(id: string) {
  const p = testerProgress(runDir, id);
  const icon = p.state === "goal done" ? "✓ " : p.state === "gave up" || p.state.startsWith("stopped") ? "✗ " : "";
  return `step ${p.steps}/${steps} · ${p.findings} finding${p.findings === 1 ? "" : "s"} · ${icon}${p.state}`;
}
const tty = process.stderr.isTTY && !o.json;
let drawn = 0;
const last = new Map<string, string>();
const tick = () => {
  const rows = chosen.map((p) => `  ${p.id.padEnd(22)} ${status(p.id)}`);
  if (tty) {
    if (drawn) process.stderr.write(`\x1b[${drawn}A`);
    process.stderr.write(rows.map((r) => `\x1b[2K${r}\n`).join(""));
    drawn = rows.length;
  } else
    // Without a terminal (logs, agents): a line when the state or the findings change, or every 5 steps.
    chosen.forEach((p, i) => {
      const t = testerProgress(runDir, p.id);
      const key = `${t.state}|${t.findings}|${Math.floor(t.steps / 5)}`;
      if (last.get(p.id) !== key) (last.set(p.id, key), say(rows[i]));
    });
};
const timer = setInterval(tick, 2000);

await Promise.all(
  chosen.map(async (persona) => {
    const env: Record<string, string> = {};
    if (o.headed) env.UX_HEADED = "1";
    if (o.throttle) env.UX_THROTTLE = "1";
    await runAgent({ app: app!, lang2: l2, persona, url: url!, dir: join(runDir, persona.id), goal, model: o.model!, steps, minutes, env, admin });
  }),
);
clearInterval(timer);
tick();

say("\nWriting the report…");
const out = await makeReport(runDir, o.model);
say(`\nReport: ${out.html}\nTo watch it with its videos: bun run view`);
if (o.json) console.log(JSON.stringify(out.summary, null, 1));
process.exit(out.summary.testers.some((t) => t.stopped_by_guard) ? 3 : 0);

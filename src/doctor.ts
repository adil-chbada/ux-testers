#!/usr/bin/env bun
// Is everything ready? Each check says what it found and, when something is wrong, the exact fix.
//   bun run doctor [app]        bun run doctor [app] --json      (exit 1 when something blocks a run)
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { subscriptionProblem } from "./agent";
import { ConfigError, loadApp, ROOT } from "./app";
import { isDevUrl, setProdDomains } from "./guard";
import { listPersonas, loadPersona } from "./persona";

export type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string };

export async function doctor(appId?: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: Check["status"], detail: string, fix?: string) => out.push({ name, status, detail, fix });

  const [maj, min] = Bun.version.split(".").map(Number);
  if (maj > 1 || (maj === 1 && min >= 2)) add("Bun", "ok", `Bun ${Bun.version}`);
  else add("Bun", "fail", `Bun ${Bun.version} is too old`, "bun upgrade");

  if (existsSync(join(ROOT, "node_modules", "playwright"))) add("Packages", "ok", "installed");
  else add("Packages", "fail", "not installed", `cd ${ROOT} && bun install`);

  try {
    const { chromium } = await import("playwright");
    const b = await chromium.launch();
    await b.close();
    add("Browser", "ok", "Chromium starts");
  } catch (e) {
    add("Browser", "fail", `Chromium does not start: ${(e as Error).message.split("\n")[0]}`, `cd ${ROOT} && bunx playwright install chromium`);
  }

  if (!Bun.which("claude")) add("Claude CLI", "fail", "not installed", "Install Claude Code: https://docs.claude.com/en/docs/claude-code");
  else {
    const p = subscriptionProblem();
    if (p) add("Claude CLI", "fail", p, "claude auth login   (run it yourself, in a terminal)");
    else add("Claude CLI", "ok", "signed in with a Claude subscription");
  }

  if (Bun.which("ffmpeg")) add("ffmpeg", "ok", "videos will also be saved as mp4 (phones)");
  else add("ffmpeg", "warn", "not installed: videos stay .webm, which iPhones do not play", "install ffmpeg (e.g. sudo apt install ffmpeg, brew install ffmpeg)");

  if (appId) {
    try {
      const app = loadApp(appId);
      const c = app.config;
      add("App settings", existsSync(app.dir) ? "ok" : "warn", existsSync(app.dir) ? `apps/${appId}/app.yaml is valid` : `no apps/${appId}/ folder: general settings`, existsSync(app.dir) ? undefined : `bun run init ${appId}`);
      if (!c.prod_domains.length) add("Production domains", "warn", "none listed: only non-local addresses are blocked", `add prod_domains: [yourapp.com] to apps/${appId}/app.yaml`);
      else add("Production domains", "ok", c.prod_domains.join(", "));
      setProdDomains(c.prod_domains);
      const testers = listPersonas(app.personasDir);
      add("Testers", "ok", `${testers.length} in ${app.personasDir.replace(ROOT + "/", "")}`);
      if (!c.url) add("App address", "warn", "no url: in app.yaml", `add url: http://localhost:<port> to apps/${appId}/app.yaml, or pass --url`);
      else if (!isDevUrl(c.url)) add("App address", "fail", `${c.url} is not a local address`, "use localhost, 127.0.0.1, *.localhost or *.test");
      else {
        const res = await fetch(c.url, { redirect: "manual", signal: AbortSignal.timeout(5000) }).catch(() => null);
        if (res) add("App address", "ok", `${c.url} answers (${res.status})`);
        else add("App address", "fail", `nothing answers at ${c.url}`, "start the app's dev server" + (existsSync(join(app.dir, "README.md")) ? ` (see apps/${appId}/README.md)` : ""));
      }
      if (existsSync(app.adminPersonaFile) || existsSync(app.adminLoginFile)) {
        const ok = existsSync(app.adminLoginFile) && existsSync(app.adminPersonaFile);
        if (ok) loadPersona(app.adminPersonaFile);
        if (ok) JSON.parse(readFileSync(app.adminLoginFile, "utf8"));
        add("Admin (--admin)", ok ? "ok" : "warn", ok ? "admin persona and dev login found" : "needs both admin.yaml and admin.local.json", ok ? undefined : `see apps/example/ and the README's "Testers that need an account"`);
      }
    } catch (e) {
      add("App settings", "fail", e instanceof ConfigError ? e.message : String(e), `fix the file named above (apps/example/app.yaml explains every setting)`);
    }
  }
  return out;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const appId = args.find((a) => !a.startsWith("--"));
  const checks = await doctor(appId);
  const failed = checks.some((c) => c.status === "fail");
  if (json) console.log(JSON.stringify({ ready: !failed, checks }, null, 1));
  else {
    const icon = { ok: "✓", warn: "!", fail: "✗" };
    for (const c of checks) console.log(`${icon[c.status]} ${c.name.padEnd(19)} ${c.detail}${c.fix ? `\n  ${"".padEnd(19)} → ${c.fix}` : ""}`);
    console.log(failed ? "\nNot ready yet: do the steps marked →, then run this again." : `\nReady.${appId ? ` Run: bun run ux ${appId}` : " Next: bun run init <app>"}`);
  }
  process.exit(failed ? 1 : 0);
}

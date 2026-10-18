#!/usr/bin/env bun
// Creates apps/<app>/ for a new app: asks a few questions (or takes them as flags, for scripts and AI agents).
//   bun run init <app>
//   bun run init <app> --name "My App" --url http://localhost:3000 --prod myapp.com,api.myapp.com [--goal "…"] [--team "…"] [--admin] --yes
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { APPS_DIR, ConfigError, loadApp } from "./app";
import { isDevUrl } from "./guard";

const { values: o, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: "string" },
    url: { type: "string" },
    prod: { type: "string" },
    team: { type: "string" },
    goal: { type: "string" },
    admin: { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
    force: { type: "boolean", default: false },
    dir: { type: "string" }, // where app folders live (tests)
  },
});

const fail = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const id = positionals[0] ?? fail("Which app? bun run init <app>   (a short name like my-shop: letters, digits, dashes)");
if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) fail(`"${id}" is not a usable name: use lowercase letters, digits and dashes, like my-shop.`);
const appsDir = o.dir ?? APPS_DIR;
const dir = join(appsDir, id);
if (existsSync(join(dir, "app.yaml")) && !o.force) fail(`apps/${id}/app.yaml already exists. Edit it, or run again with --force to replace it.`);

// Ask only what is missing, only when a person is there to answer.
const interactive = process.stdin.isTTY && !o.yes;
const ask = (question: string, fallback: string) => {
  if (!interactive) return fallback;
  const a = prompt(`${question}${fallback ? ` [${fallback}]` : ""}:`);
  return a?.trim() || fallback;
};
const name = o.name ?? ask("App name (what testers call it)", id);
let url = o.url ?? ask("Its local address while you test (empty if you will pass --url each time)", "http://localhost:3000");
while (url && !isDevUrl(url)) {
  if (!interactive) fail(`${url} is not a local address (localhost, 127.0.0.1, *.localhost, *.test).`);
  url = ask(`${url} is not a local address. Local address`, "http://localhost:3000");
}
const prod = (o.prod ?? ask("Production domains, comma-separated (never reachable during tests)", ""))
  .split(",")
  .map((d) => d.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
  .filter(Boolean);
const team = o.team ?? ask("Who answers new users (for --admin)", `the ${name} team`);
const goal = o.goal ?? ask("Default task for testers (empty = each tester's own goal)", "");
const admin = o.admin || (interactive && /^y/i.test(ask("Do new users need a team member to create or approve their account? (y/N)", "n")));

const q = (s: string) => JSON.stringify(s);
const yaml = [
  `# Settings for ${name}. Every setting is explained in apps/example/app.yaml.`,
  `name: ${q(name)}`,
  url ? `url: ${q(url)}` : `# url: "http://localhost:3000"`,
  goal ? `goal: ${q(goal)}` : `# goal: "Create an account and invite a teammate"`,
  `# personas: [retiree-low-tech, power-user-pro]     # default testers; else 3 at random`,
  `team: ${q(team)}`,
  `prod_domains: [${prod.map(q).join(", ")}]`,
  `timezone: UTC`,
  `phone_format: "555#######"`,
  ...(admin ? [`admin:`, `  start_path: /admin`, `  signin_path: /login`] : [`# admin: { start_path: /admin, signin_path: /login }   # for --admin`]),
  "",
].join("\n");

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "app.yaml"), yaml);
if (!existsSync(join(dir, "README.md")))
  writeFileSync(
    join(dir, "README.md"),
    `# ${name} in ux-testers\n\nNotes for whoever runs tests on this app (people and AI agents read this first):\n\n- How to start its dev server: …\n- Test accounts or data it needs: …\n- Anything testers should not touch: …\n`,
  );
if (admin) {
  const ex = join(APPS_DIR, "example");
  for (const f of ["admin.yaml", "scripted-admin.ts"]) if (!existsSync(join(dir, f))) copyFileSync(join(ex, f), join(dir, f));
}

try {
  loadApp(id, dir);
} catch (e) {
  fail(e instanceof ConfigError ? `The settings need a fix:\n${e.message}` : String(e));
}
console.log(`Created apps/${id}/ (app.yaml, README.md${admin ? ", admin.yaml, scripted-admin.ts" : ""}).`);
if (!prod.length) console.log(`! No production domains: add them to apps/${id}/app.yaml (prod_domains) so a test can never reach them.`);
if (admin) console.log(`! For --admin: put { "phone": "…", "password": "…" } of a DEV-ONLY admin in apps/${id}/admin.local.json, and adapt scripted-admin.ts.`);
console.log(`Next: bun run doctor ${id}${url ? `, then: bun run ux ${id}` : ""}`);

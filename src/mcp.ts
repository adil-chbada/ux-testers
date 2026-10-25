#!/usr/bin/env bun
// ux-testers as an MCP server, for AI agents and MCP clients (Claude Code, Claude Desktop…):
//   claude mcp add --scope user ux-testers -- bun /path/to/ux-testers/src/mcp.ts
// Tools: doctor, list_apps, list_testers, start_test (returns at once; a run takes minutes), test_status, get_results.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { listApps, loadApp, ROOT } from "./app";
import { doctor } from "./doctor";
import { listPersonas } from "./persona";
import { runProgress } from "./progress";
import { traits } from "./report";

const server = new McpServer({ name: "ux-testers", version: "1.0.0" });
const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });
const runsRoot = join(ROOT, "runs");
/** run_dir must be a run folder inside runs/: never read files elsewhere. */
const runDirOf = (p: string) => {
  const d = resolve(ROOT, p);
  if (!d.startsWith(runsRoot + "/") || !existsSync(d)) throw new Error(`not a run folder: ${p}`);
  return d;
};

server.registerTool(
  "doctor",
  { description: "Check that everything needed to run test users is ready (Bun, browser, Claude CLI on a subscription, the app's settings and dev server). Each problem comes with its fix.", inputSchema: { app: z.string().optional().describe("app folder name in apps/") } },
  async ({ app }) => {
    const checks = await doctor(app);
    return json({ ready: !checks.some((c) => c.status === "fail"), checks });
  },
);

server.registerTool("list_apps", { description: "The apps that have a settings folder (apps/<app>/), with their saved address and default testers.", inputSchema: {} }, async () =>
  json(
    listApps().map((id) => {
      try {
        const a = loadApp(id);
        return { id, name: a.config.name, url: a.config.url, default_testers: a.config.personas, goal: a.config.goal, readme: existsSync(join(a.dir, "README.md")) ? join(a.dir, "README.md") : undefined, admin: existsSync(a.adminLoginFile) };
      } catch (e) {
        return { id, error: (e as Error).message };
      }
    }),
  ),
);

server.registerTool("list_testers", { description: "The test users (personas) available for an app: id, name, profile, default goal.", inputSchema: { app: z.string() } }, async ({ app }) =>
  json(listPersonas(loadApp(app).personasDir).map((p) => ({ id: p.id, name: p.name, profile: traits(p), goal: p.goal }))),
);

server.registerTool(
  "start_test",
  {
    description:
      "Start test users on an app running on a LOCAL dev server. Returns at once with the run folder; a run takes 2 to 30 minutes, so check test_status every minute or two, then call get_results. Never point it at production (it refuses).",
    inputSchema: {
      app: z.string().describe("app folder name in apps/ (settings, testers); unknown names use general settings"),
      url: z.string().optional().describe("local address, e.g. http://localhost:3000 (default: the url in the app's settings)"),
      testers: z.array(z.string()).optional().describe("tester ids (see list_testers); default: the app's default testers, else 3 at random"),
      random: z.number().int().min(1).max(8).optional().describe("this many random testers instead"),
      goal: z.string().optional().describe("one task for every tester"),
      minutes: z.number().positive().max(60).optional(),
      admin: z.boolean().optional().describe("testers may ask a team member to create their account (needs the app's admin files)"),
      account: z.boolean().optional().describe("every tester starts with a ready account made in the dev database (needs the app's scripted-admin.ts and admin.local.json)"),
    },
  },
  async (a) => {
    const args = [process.execPath, join(ROOT, "src", "run.ts"), a.app, "--json"];
    if (a.url) args.push("--url", a.url);
    if (a.testers?.length) args.push("--personas", a.testers.join(","));
    if (a.random) args.push("--random", String(a.random));
    if (a.goal) args.push("--goal", a.goal);
    if (a.minutes) args.push("--minutes", String(a.minutes));
    if (a.admin) args.push("--admin");
    if (a.account) args.push("--account");
    const jobs = join(runsRoot, "_jobs");
    mkdirSync(jobs, { recursive: true });
    const job = `${a.app}-${Date.now()}`;
    const log = join(jobs, `${job}.log`);
    const proc = Bun.spawn(args, { cwd: ROOT, stdout: Bun.file(join(jobs, `${job}.json`)), stderr: Bun.file(log), stdin: "ignore" });
    proc.unref();
    // Wait until the run has a folder, or has already been refused.
    for (let i = 0; i < 60; i++) {
      await Bun.sleep(500);
      const text = existsSync(log) ? readFileSync(log, "utf8") : "";
      const folder = text.match(/Run folder: (.+)/)?.[1]?.trim();
      if (folder) return json({ started: true, run_dir: folder, log, next: "call test_status with run_dir in a minute or two" });
      if (proc.exitCode !== null) return json({ started: false, exit: proc.exitCode, reason: text.trim().slice(-1500) });
    }
    return json({ started: "unknown", log, next: "read the log; the run may still be starting" });
  },
);

server.registerTool(
  "test_status",
  { description: "How a run started with start_test is going: each tester's steps, findings and state. finished: true means the report is ready (get_results).", inputSchema: { run_dir: z.string() } },
  async ({ run_dir }) => {
    const d = runDirOf(run_dir);
    const p = runProgress(d);
    return json(p.finished ? { ...p, summary: JSON.parse(readFileSync(join(d, "summary.json"), "utf8")) } : p);
  },
);

server.registerTool(
  "get_results",
  { description: "The results of a finished run: the summary (goals, verdicts, finding counts, file paths) and the findings text. Point people to report_html: it plays each finding's moment in the video.", inputSchema: { run_dir: z.string() } },
  async ({ run_dir }) => {
    const d = runDirOf(run_dir);
    if (!existsSync(join(d, "summary.json"))) return json({ finished: false, next: "the run is not finished; call test_status" });
    const summary = JSON.parse(readFileSync(join(d, "summary.json"), "utf8"));
    const findings = existsSync(join(d, "findings.md")) ? readFileSync(join(d, "findings.md"), "utf8").slice(0, 20_000) : "";
    return json({ finished: true, summary, findings_md: findings });
  },
);

await server.connect(new StdioServerTransport());

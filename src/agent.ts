// Starts one tester: a `claude -p` process with no built-in tools, none of the owner's settings, hooks, plugins or
// project files, and the browser MCP server as its only toolbox. Writes transcript.jsonl, tools.json and meta.json.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakePhone, type App } from "./app";
import type { Lang2 } from "./lang";
import { systemPrompt, type Persona, type TestIdentity } from "./persona";

export const MCP_SCRIPT = join(import.meta.dir, "browser-mcp.ts");

// Owner rule (2026-10-17): no usage that is billed per token. Every claude process gets an env without API keys or
// cloud-provider switches, so the CLI can only use the signed-in Claude subscription.
const PAID_AUTH = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
export function subscriptionEnv(): Record<string, string> {
  const env = { ...process.env } as Record<string, string>;
  for (const k of PAID_AUTH) delete env[k];
  // A browser server takes its UX_* settings from its own mcp.json only: inherited ones once gave the admin agent
  // the tester's ask_admin, and it called a second admin agent.
  for (const k of Object.keys(env)) if (k.startsWith("UX_")) delete env[k];
  return env;
}

/** null when the CLI is signed in with a Claude subscription, otherwise why not. */
export function subscriptionProblem(): string | null {
  const r = Bun.spawnSync(["claude", "auth", "status"], { env: subscriptionEnv(), cwd: "/tmp" });
  let s: { loggedIn?: boolean; authMethod?: string; subscriptionType?: string };
  try {
    s = JSON.parse(r.stdout.toString());
  } catch {
    return `could not read "claude auth status" (${r.stderr.toString().slice(0, 160)})`;
  }
  if (!s.loggedIn) return "the Claude CLI is not signed in: run claude auth login";
  if (s.authMethod !== "claude.ai" || !s.subscriptionType) return `the Claude CLI is signed in with "${s.authMethod}", not a Claude subscription; refusing so nothing is billed per token`;
  return null;
}

export function claudeArgs(o: { prompt: string; system: string; mcpConfig: string; model: string }) {
  return [
    "claude", "-p", o.prompt,
    "--system-prompt", o.system,
    "--tools", "", // no Bash, Read, Edit, WebFetch… at all
    "--strict-mcp-config", "--mcp-config", o.mcpConfig,
    "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }),
    "--allowedTools", "mcp__ux",
    "--disable-slash-commands", "--no-session-persistence",
    "--output-format", "stream-json", "--verbose",
    "--model", o.model,
  ];
}

export function mcpConfig(dir: string, url: string, steps: number, minutes: number, extra: Record<string, string> = {}) {
  const env: Record<string, string> = { UX_OUT: dir, UX_URL: url, UX_STEPS: String(steps), UX_MINUTES: String(minutes), ...extra };
  return { mcpServers: { ux: { command: process.execPath, args: [MCP_SCRIPT], env } } };
}

export function testIdentity(p: Persona, phoneFormat = "555#######"): TestIdentity {
  const tag = crypto.randomUUID().slice(0, 6);
  return { first_name: p.name.split(",")[0].trim(), phone: fakePhone(phoneFormat), email: `${p.id}.${tag}@example.test`, password: `UxTest-${tag}!` };
}

/** The admin agent testers can call (ask_admin): its time and steps per request (its files are in the app folder). */
export type AdminSetup = { minutes: number; steps: number };

export type AgentRun = {
  app: App; // the app under test (apps/<app>/)
  lang2?: Lang2; // the optional second language of thoughts and findings
  persona: Persona;
  url: string;
  dir: string;
  goal?: string;
  model: string;
  steps: number;
  minutes: number;
  env?: Record<string, string>; // extra browser-server settings (UX_HEADED, UX_THROTTLE, UX_ROLE…)
  admin?: AdminSetup; // testers only: lets them call ask_admin
  system?: string; // replaces the tester prompt (the admin agent)
  prompt?: string;
  who?: TestIdentity; // the admin agent works for someone else's identity; with account, the identity the account was made for
  account?: string; // --account: the sign-in message of the account made for this tester (shown in its prompt)
};

export async function runAgent(r: AgentRun) {
  mkdirSync(r.dir, { recursive: true });
  const who = r.who ?? testIdentity(r.persona, r.app.config.phone_format);
  const goal = r.goal ?? r.persona.goal;
  writeFileSync(join(r.dir, "persona.json"), JSON.stringify({ ...r.persona, goal, test_identity: who }, null, 1));
  const env: Record<string, string> = { UX_APP: r.app.id, UX_APP_DIR: r.app.dir, UX_LANG2: r.lang2?.code ?? "", ...r.env };
  if (r.admin) Object.assign(env, { UX_MODEL: r.model, UX_ADMIN: JSON.stringify(r.admin) });
  const cfg = join(r.dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify(mcpConfig(r.dir, r.url, r.steps, r.minutes, env)));

  const cwd = mkdtempSync(join(tmpdir(), "ux-tester-")); // empty folder: nothing of ours to find
  const t0 = Date.now();
  const system = r.system ?? systemPrompt(r.persona, who, goal, r.admin ? r.app.config.team : undefined, r.lang2, r.account);
  const prompt = r.prompt ?? `The app is open in front of you at ${r.url}. Start your visit: call look.`;
  const visit = async (model: string) => {
    const proc = Bun.spawn(claudeArgs({ prompt, system, mcpConfig: cfg, model }), {
      cwd,
      // ask_admin waits for a whole admin visit; the CLI's MCP call timeout must outlast it.
      env: { ...subscriptionEnv(), MCP_TOOL_TIMEOUT: String(((r.admin?.minutes ?? 0) + 5) * 60_000) },
      stdout: "pipe",
      stderr: "pipe",
    });
    // A tester may wait for up to two admin visits on top of its own time.
    const timer = setTimeout(() => proc.kill(), (r.minutes + 2 * (r.admin?.minutes ?? 0) + 3) * 60_000);
    const guard = setInterval(() => existsSync(join(r.dir, "guard.json")) && proc.kill(), 1000);
    let meta: Record<string, unknown> = {};
    let refused = false;
    let buf = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      appendFileSync(join(r.dir, "transcript.jsonl"), chunk);
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop()!;
      for (const line of lines) {
        try {
          const ev = JSON.parse(line);
          if (ev.type === "system" && ev.subtype === "init") writeFileSync(join(r.dir, "tools.json"), JSON.stringify(ev.tools, null, 1));
          if (ev.type === "result") {
            meta = { cost_usd: ev.total_cost_usd, turns: ev.num_turns, is_error: ev.is_error, model };
            refused = ev.is_error && /safeguards flagged/i.test(String(ev.result));
          }
        } catch {}
      }
    }
    appendFileSync(join(r.dir, "claude.stderr.log"), await new Response(proc.stderr).text());
    const exit = await proc.exited;
    clearTimeout(timer);
    clearInterval(guard);
    return { meta: { ...meta, exit }, refused };
  };

  // The model's safeguards refuse a normal first message at random with these browser tools (2026-10-18: the same
  // one-line prompt passed and was refused on repeat, about half the time; --fallback-model does not cover it).
  // Each try is independent, so retry: the chosen model twice, then the fallback. Still on the subscription.
  const tries = [r.model, r.model, process.env.UX_FALLBACK_MODEL ?? "opus"];
  let { meta, refused } = await visit(tries[0]);
  let spent = Number(meta.cost_usd ?? 0);
  for (let i = 1; refused && i < tries.length; i++) {
    appendFileSync(join(r.dir, "claude.stderr.log"), `\n[ux-testers] try ${i} was refused by the model's safeguards; try ${i + 1} with ${tries[i]}\n`);
    ({ meta, refused } = await visit(tries[i]));
    spent += Number(meta.cost_usd ?? 0);
    meta = { ...meta, cost_usd: spent, refused_tries: i };
  }
  rmSync(cwd, { recursive: true, force: true });
  meta = { ...meta, duration_s: Math.round((Date.now() - t0) / 1000), guard: existsSync(join(r.dir, "guard.json")) };
  writeFileSync(join(r.dir, "meta.json"), JSON.stringify(meta, null, 1));
  return meta;
}

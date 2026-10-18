#!/usr/bin/env bun
// Merges every tester of one run into report.md: goals and verdicts, issues ranked by how many personas hit them,
// patterns by persona trait, issues by page, errors and guard stops. One tool-less `claude -p` call groups the notes
// into issues; everything else is counted from the files.
//   bun run report runs/<app>/<date-time>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { subscriptionEnv } from "./agent";
import { lang2 } from "./lang";
import { FINDING_KINDS, kindLabel, type FindingKind } from "./overlay";
import type { Persona } from "./persona";
import { writeHtml } from "./report-html";

/** l2/l2_lang: the second-language text and its code, when one was set; ar: the same, in runs from before 2026-10-18. */
type Note = { persona: string; step: number; kind: string; url: string; target?: string; en: string; l2?: string; l2_lang?: string; ar?: string; shot?: string };
const second = (n: Note) => n.l2 ?? n.ar;
const secondLang = (n: Note) => n.l2_lang ?? (n.ar ? "ar" : undefined);
const rtlOf = (code?: string) => !!lang2(code)?.rtl;
const l2line = (text: string | undefined, code?: string) => (text ? (rtlOf(code) ? `<span dir="rtl">${text}</span>` : text) : "");
type Step = { step: number; url: string; action: string; target?: string; input?: string; result: string };
type Agent = {
  id: string;
  persona: Persona;
  steps: Step[];
  notes: Note[];
  errors: { type: string; url: string; text: string }[];
  finish?: { goal_done: boolean; quit_reason?: string; would_sign_up: string; why: string; summary: string; steps: number };
  guard?: { url: string; reason: string };
  meta?: { cost_usd?: number; duration_s?: number; exit?: number };
};
type Issue = { title: string; severity: 1 | 2 | 3; pages: string[]; note_refs: string[]; repro: string[]; fix_idea?: string };
type Merged = { issues: Issue[]; by_trait: { finding: string; personas: string[] }[] };

const jsonl = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const json = (f: string) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : undefined);
const path = (u: string) => {
  try {
    const x = new URL(u);
    return x.pathname + x.hash;
  } catch {
    return u;
  }
};
const cell = (s: unknown) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
export const traits = (p: Persona) => `${p.tech.level} tech, reads ${p.languages.reads.join("/")}, ${p.tech.device}, ${p.business.trade}`;

function load(dir: string): Agent {
  return {
    id: basename(dir),
    persona: json(join(dir, "persona.json")),
    steps: jsonl(join(dir, "steps.jsonl")),
    notes: jsonl(join(dir, "notes.jsonl")).map((n: Note & { evidence?: string }) => ({ ...n, shot: n.evidence ?? n.shot })),
    errors: jsonl(join(dir, "errors.jsonl")),
    finish: json(join(dir, "finish.json")),
    guard: json(join(dir, "guard.json")),
    meta: json(join(dir, "meta.json")),
  };
}

const SCHEMA = {
  type: "object",
  required: ["issues", "by_trait"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "severity", "pages", "note_refs", "repro"],
        properties: {
          title: { type: "string" },
          severity: { type: "integer", enum: [1, 2, 3] },
          pages: { type: "array", items: { type: "string" } },
          note_refs: { type: "array", items: { type: "string" } },
          repro: { type: "array", items: { type: "string" } },
          fix_idea: { type: "string" },
        },
      },
    },
    by_trait: { type: "array", items: { type: "object", required: ["finding", "personas"], properties: { finding: { type: "string" }, personas: { type: "array", items: { type: "string" } } } } },
  },
};

async function merge(agents: Agent[], model: string): Promise<Merged> {
  const notes = agents.flatMap((a) => a.notes.filter((x) => x.kind !== "praise").map((x, i) => ({ ref: `${a.id}#${i}`, persona: a.id, kind: x.kind, page: path(x.url), target: x.target, note: x.en })));
  if (!notes.length) return { issues: [], by_trait: [] };
  const people = agents.map((a) => ({ id: a.id, traits: traits(a.persona), goal: a.persona.goal, path: a.steps.map((s) => `${s.step} ${s.action} ${s.target ?? ""} @${path(s.url)}${s.result === "done" ? "" : " (" + s.result.slice(0, 60) + ")"}`) }));
  const prompt = `AI test users, each playing a persona, explored a web app and left UX notes. Merge the notes into distinct issues.
Two notes are one issue when they describe the same problem with the same feature. Every note belongs to exactly one issue.
severity: 3 = it blocks the goal, 2 = it slows down or confuses, 1 = cosmetic.
pages: the page paths involved. note_refs: the refs of the notes in the issue. repro: short steps to see it, taken from the testers' paths.
fix_idea: one sentence, only when the notes make it obvious.
by_trait: patterns that hold for 2 or more personas sharing a trait (tech level, language, device, trade), phrased with counts,
e.g. "3 of 4 low-tech personas never found the Share button". Count from the personas list. Leave it empty when there is no such pattern.

PERSONAS
${JSON.stringify(people)}

NOTES
${JSON.stringify(notes)}`;
  const proc = Bun.spawn(["claude", "-p", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--settings", JSON.stringify({ disableAllHooks: true }), "--no-session-persistence", "--output-format", "json", "--json-schema", JSON.stringify(SCHEMA), "--model", model], {
    stdin: new Blob([prompt]),
    env: subscriptionEnv(),
    stdout: "pipe",
    stderr: "pipe",
    cwd: "/tmp",
  });
  const raw = await new Response(proc.stdout).text();
  try {
    const ev = JSON.parse(raw);
    return ev.structured_output ?? JSON.parse(ev.result);
  } catch {
    console.error(`Could not group the notes (${(await new Response(proc.stderr).text()).slice(0, 300)}); listing them one by one.`);
    return { issues: notes.map((x) => ({ title: x.note.slice(0, 90), severity: 2, pages: [x.page], note_refs: [x.ref], repro: [] })), by_trait: [] };
  }
}

// Kinds from runs before 2026-10-18 map onto the owner's four (issue, bad UX, bad UI, smart idea).
const LEGACY_KIND: Record<string, FindingKind> = { bug: "issue", confusion: "bad_ux", friction: "bad_ux", suggestion: "idea" };
const ICON: Record<FindingKind, string> = { issue: "🔴", bad_ux: "🟠", bad_ui: "🟣", idea: "💡", language: "🔤", praise: "💚" };
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** findings.jsonl (one finding per line, for tools and trackers) and findings.md (by kind, for people). */
function writeFindings(runDir: string, app: string, agents: Agent[]) {
  const all = agents.flatMap((a) =>
    a.notes.map((n) => {
      const kind = (LEGACY_KIND[n.kind] ?? n.kind) as FindingKind;
      const s = (n as Note & { video_s?: number }).video_s;
      return {
        kind,
        label: kindLabel(kind, secondLang(n)),
        persona: a.id,
        who: a.persona.name,
        page: path(n.url),
        target: n.target,
        en: n.en,
        l2: second(n),
        l2_lang: secondLang(n),
        l2_rtl: rtlOf(secondLang(n)),
        screenshot: n.shot ? `${a.id}/${n.shot}` : undefined,
        video: `${a.id}/video.webm`,
        video_s: s,
        step: n.step,
      };
    }),
  );
  writeFileSync(join(runDir, "findings.jsonl"), all.map((f) => JSON.stringify(f)).join("\n") + (all.length ? "\n" : ""));
  const L = [`# Findings: ${app}, ${basename(runDir)} UTC`, "", `${all.length} findings from ${agents.length} visits. Times link into each visit's video.`, ""];
  for (const kind of Object.keys(FINDING_KINDS) as FindingKind[]) {
    const group = all.filter((f) => f.kind === kind);
    if (!group.length) continue;
    L.push(`## ${ICON[kind]} ${FINDING_KINDS[kind].label} (${group.length})`, "");
    for (const f of group) {
      const at = f.video_s != null ? ` · [▶ video at ${clock(f.video_s)}](${f.video}#t=${Math.floor(f.video_s)})` : "";
      L.push(`- **${f.who}** on \`${f.page}\`${f.target ? ` (${f.target})` : ""}: ${f.en}  `, ...(f.l2 ? [`  ${l2line(f.l2, f.l2_lang)}  `] : []), `  ${f.screenshot ? `[screenshot](${f.screenshot})` : ""}${at}`, "");
    }
  }
  writeFileSync(join(runDir, "findings.md"), L.join("\n"));
  return all;
}

export type Finding = ReturnType<typeof writeFindings>[number];

export async function makeReport(runDir: string, model = "sonnet") {
  runDir = resolve(runDir); // summary.json carries absolute paths for scripts and agents
  const agents = readdirSync(runDir)
    .map((d) => join(runDir, d))
    .filter((d) => existsSync(join(d, "persona.json")))
    .map(load);
  const merged = await merge(agents, model);
  const note = (ref: string) => {
    const [id, i] = ref.split("#");
    const a = agents.find((x) => x.id === id);
    return a && { a, n: a.notes.filter((x) => x.kind !== "praise")[Number(i)] };
  };
  const hitBy = (i: Issue) => [...new Set(i.note_refs.map((r) => r.split("#")[0]))];
  const issues = merged.issues.sort((x, y) => hitBy(y).length * y.severity - hitBy(x).length * x.severity);
  const N = agents.length;
  const cost = agents.reduce((s, a) => s + (a.meta?.cost_usd ?? 0), 0);
  const app = basename(join(runDir, ".."));
  const L: string[] = [];

  L.push(`# UX test run: ${app}, ${basename(runDir)} UTC`, "");
  const testers = agents.filter((a) => !/-admin-\d+$/.test(a.id)); // <tester>-admin-<n> folders are admin-agent visits
  const visits = N - testers.length ? ` + ${N - testers.length} admin-agent visit(s)` : "";
  L.push(`${testers.length} testers${visits} on ${testers[0]?.steps[0]?.url ?? "?"} · usage ≈ $${cost.toFixed(2)} at API prices (covered by the Claude subscription, not billed) · longest visit ${Math.max(0, ...agents.map((a) => a.meta?.duration_s ?? 0))} s`);
  L.push(`Each tester's folder holds \`video.webm\` (with the tester's thoughts on screen), \`trace.zip\` (\`bunx playwright show-trace <id>/trace.zip\`), \`shots/\`, \`steps.jsonl\` and \`notes.jsonl\`.`, "");

  L.push("## Goals and verdicts", "", "| Persona | Profile | Goal | Done | Steps | Gave up / stopped | Would sign up | Why |", "|---|---|---|---|---|---|---|---|");
  for (const a of agents) {
    const f = a.finish;
    const end = a.guard ? `STOPPED by guard: ${a.guard.reason}` : f ? (f.goal_done ? "" : f.quit_reason ?? "gave up") : "never called finish";
    L.push(`| ${a.id} | ${cell(traits(a.persona))} | ${cell(a.persona.goal)} | ${f?.goal_done ? "yes" : "no"} | ${a.steps.length} | ${cell(end)} | ${f?.would_sign_up ?? "?"} | ${cell(f?.why)} |`);
  }
  L.push("");

  L.push("## Top issues", "");
  if (!issues.length) L.push("No problems were noted.", "");
  issues.forEach((i, k) => {
    const who = hitBy(i);
    L.push(`### ${k + 1}. ${i.title}`, "", `Severity ${i.severity} of 3 · hit by ${who.length} of ${N} (${who.join(", ")}) · pages ${i.pages.join(", ")}`, "");
    const quotes = i.note_refs.map(note).filter(Boolean) as { a: Agent; n: Note }[];
    for (const { a, n } of quotes) L.push(`- **${a.id}** (${n.kind}, step ${n.step}${n.target ? `, ${n.target}` : ""}): ${n.en}${n.shot ? ` [screenshot](${a.id}/${n.shot})` : ""}`);
    const first = quotes.find((q) => q.n.shot);
    if (first) L.push("", `<img src="${first.a.id}/${first.n.shot}" width="280">`);
    if (i.repro.length) L.push("", "Steps to see it:", ...i.repro.map((s, j) => `${j + 1}. ${s}`));
    if (i.fix_idea) L.push("", `Fix idea: ${i.fix_idea}`);
    L.push("");
  });

  L.push("## Patterns by persona trait", "");
  L.push(...(merged.by_trait.length ? merged.by_trait.map((t) => `- ${t.finding} (${t.personas.join(", ")})`) : ["None found across 2 or more personas."]), "");

  L.push("## Issues by page", "");
  const pages = new Map<string, string[]>();
  issues.forEach((i, k) => i.pages.forEach((p) => pages.set(p, [...(pages.get(p) ?? []), `#${k + 1} ${i.title}`])));
  L.push(...([...pages].map(([p, t]) => `- \`${p}\`: ${t.join("; ")}`) || []), "");

  const praise = agents.flatMap((a) => a.notes.filter((n) => n.kind === "praise").map((n) => `- **${a.id}**: ${n.en}`));
  if (praise.length) L.push("## What they liked", "", ...praise, "");

  L.push("## Errors seen in the browser", "", "| Persona | console | page errors | HTTP ≥ 400 | failed requests | blocked |", "|---|---|---|---|---|---|");
  const count = (a: Agent, t: string) => a.errors.filter((e) => e.type === t).length;
  for (const a of agents) L.push(`| ${a.id} | ${count(a, "console")} | ${count(a, "pageerror")} | ${count(a, "http")} | ${count(a, "failed")} | ${count(a, "blocked")} |`);
  const top = new Map<string, number>();
  for (const e of agents.flatMap((a) => a.errors.filter((x) => x.type !== "blocked"))) {
    const k = `${e.type}: ${e.type === "http" || e.type === "failed" ? `${e.text} ${path(e.url)}` : e.text.slice(0, 160)}`;
    top.set(k, (top.get(k) ?? 0) + 1);
  }
  if (top.size) L.push("", "Most frequent:", ...[...top].sort((x, y) => y[1] - x[1]).slice(0, 8).map(([k, c]) => `- ${c}× ${cell(k)}`));
  const blocked = agents.flatMap((a) => a.errors.filter((e) => e.type === "blocked").map((e) => `- ${a.id}: ${e.text} ${e.url}`));
  if (blocked.length) L.push("", "Blocked by the dev-only guard:", ...[...new Set(blocked)]);
  L.push("");

  L.push("## Each visit", "");
  for (const a of agents) {
    L.push(`### ${a.persona.name} (${a.id})`, "", `${traits(a.persona)}. Goal: ${a.persona.goal}`, "", a.finish?.summary ?? "(no summary: the visit ended without finish)", "");
    for (const n of a.notes) L.push(`- step ${n.step}, ${n.kind} @\`${path(n.url)}\`: ${n.en}${second(n) ? `  \n  ${l2line(second(n), secondLang(n))}` : ""}`);
    L.push("");
  }

  const findings = writeFindings(runDir, app, agents);
  L.splice(3, 0, "Every finding, by kind, with its screenshot and the second it appears in the video: [findings.md](findings.md) (`findings.jsonl` for tools). The easiest view is [report.html](report.html).", "");
  const md = join(runDir, "report.md");
  writeFileSync(md, L.join("\n"));

  // Phones (Safari) do not play webm: an mp4 next to each video, when ffmpeg is installed.
  const ffmpeg = Bun.which("ffmpeg");
  for (const a of agents) {
    const webm = join(runDir, a.id, "video.webm");
    if (ffmpeg && existsSync(webm) && !existsSync(join(runDir, a.id, "video.mp4")))
      Bun.spawnSync([ffmpeg, "-v", "error", "-y", "-i", webm, "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(runDir, a.id, "video.mp4")]);
  }

  const summary = summarize(runDir, app, agents, cost);
  writeFileSync(join(runDir, "summary.json"), JSON.stringify(summary, null, 1));
  const html = writeHtml(runDir, {
    app,
    run: basename(runDir),
    summary,
    findings,
    issues: issues.map((i) => ({
      title: i.title,
      severity: i.severity,
      who: hitBy(i),
      pages: i.pages,
      repro: i.repro,
      fix_idea: i.fix_idea,
      quotes: (i.note_refs.map(note).filter(Boolean) as { a: Agent; n: Note }[]).map(({ a, n }) => ({ tester: a.id, kind: n.kind, text: n.en, shot: n.shot ? `${a.id}/${n.shot}` : undefined })),
    })),
    patterns: merged.by_trait,
  });
  return { md, html, findings: join(runDir, "findings.md"), summary };
}

export type Summary = ReturnType<typeof summarize>;

/** summary.json and the --json output: what a script or an AI agent needs to know about a run. */
function summarize(runDir: string, app: string, agents: Agent[], cost: number) {
  const file = (p: string) => (existsSync(join(runDir, p)) ? join(runDir, p) : undefined);
  const isAdmin = (a: Agent) => /-admin-\d+$/.test(a.id);
  const count = (a: Agent) => a.notes.reduce<Record<string, number>>((m, n) => ((m[LEGACY_KIND[n.kind] ?? n.kind] = (m[LEGACY_KIND[n.kind] ?? n.kind] ?? 0) + 1), m), {});
  const visit = (a: Agent) => ({
    id: a.id,
    name: a.persona.name,
    profile: traits(a.persona),
    goal: a.persona.goal,
    goal_done: a.finish?.goal_done ?? false,
    ended: a.guard ? "stopped: reached a production site" : a.finish ? (a.finish.goal_done ? "goal done" : `gave up: ${a.finish.quit_reason ?? ""}`.trim()) : "ended without finishing",
    would_sign_up: a.finish?.would_sign_up,
    why: a.finish?.why,
    steps: a.steps.length,
    findings: count(a),
    video: file(`${a.id}/video.mp4`) ?? file(`${a.id}/video.webm`),
    stopped_by_guard: !!a.guard,
  });
  const admins = existsSync(runDir) ? readdirSync(runDir).filter((d) => /-admin-\d+$/.test(d)) : [];
  return {
    ok: true as const,
    exit: agents.some((a) => a.guard) ? 3 : 0,
    app,
    run_dir: runDir,
    report_html: join(runDir, "report.html"),
    report_md: join(runDir, "report.md"),
    findings_md: join(runDir, "findings.md"),
    findings_jsonl: join(runDir, "findings.jsonl"),
    usage_usd_estimate: Math.round(cost * 100) / 100,
    testers: agents.filter((a) => !isAdmin(a)).map((a) => ({ ...visit(a), admin_visits: admins.filter((d) => d.startsWith(`${a.id}-admin-`)) })),
    admin_visits: admins.map((d) => {
      const a = agents.find((x) => x.id === d);
      return { id: d, for: d.replace(/-admin-\d+$/, ""), answered: existsSync(join(runDir, d, "reply.json")), scripted: existsSync(join(runDir, d, "scripted.json")), ...(a ? { goal_done: a.finish?.goal_done ?? false, findings: count(a), video: visit(a).video } : {}) };
    }),
  };
}

if (import.meta.main) {
  const dir = process.argv[2] ?? Bun.argv[2];
  if (!dir) {
    console.error("usage: bun run report runs/<app>/<date-time>");
    process.exit(1);
  }
  console.log((await makeReport(dir)).html);
}

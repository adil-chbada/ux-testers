#!/usr/bin/env bun
// One tester's browser as an MCP server (stdio), started by agent.ts through `claude --mcp-config`. It is the agent's
// only way to act, enforces the dev-only guard, and records the visit in UX_OUT: video.webm, trace.zip, shots/,
// steps.jsonl, notes.jsonl, errors.jsonl, finish.json, and guard.json when the guard stops the run.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { chromium, type Locator } from "playwright";
import { z } from "zod";
import { runAgent, type AdminSetup } from "./agent";
import { runScriptedAdmin } from "./scripted-admin";
import { loadApp } from "./app";
import { blockedHostRules, isDevUrl, isProdHost, setProdDomains } from "./guard";
import { lang2, WAITING_2 } from "./lang";
import { FINDING_KINDS, kindLabel, OVERLAY_HIDE_CSS, OVERLAY_INIT, type Chat, type Flag, type FindingKind, type Say } from "./overlay";
import { adminPrompt, browserOptions, loadPersona, networkOf, viewportOf, type AdminLogin, type Persona, type TestIdentity } from "./persona";

const OUT = process.env.UX_OUT!;
const START = process.env.UX_URL!;
const persona: Persona = JSON.parse(readFileSync(`${OUT}/persona.json`, "utf8"));
const MAX_STEPS = Number(process.env.UX_STEPS ?? 60);
let deadline = Date.now() + Number(process.env.UX_MINUTES ?? 15) * 60_000; // pushed back while waiting for the admin agent
const touch = persona.tech.device !== "pc";
// The app under test (apps/<app>/app.yaml): its production domains, timezone, team and admin paths.
const APP = loadApp(process.env.UX_APP ?? "app", process.env.UX_APP_DIR);
setProdDomains(APP.config.prod_domains);
const TEAM = APP.config.team;
const TEAM_LABEL = TEAM[0].toUpperCase() + TEAM.slice(1);
const ADMIN_START = APP.config.admin?.start_path ?? "/admin";
// The optional second language: UX_LANG2 (set by run.ts; "" means English only), else the app's setting.
const L2 = lang2(process.env.UX_LANG2 ?? APP.config.second_language);
/** The second-language twin of a field (thought_en → thought_ar), or undefined when English only. */
const k2 = (base: string) => (L2 ? `${base}_${L2.code}` : undefined);
const v2 = (a: Record<string, unknown>, base: string) => (L2 ? (a[`${base}_${L2.code}`] as string | undefined) : undefined);
const two = (en: string, l2?: string) => ({ en, l2, rtl: L2?.rtl });
if (!isDevUrl(START)) {
  console.error(`refusing to open ${START}: not a local dev URL`);
  process.exit(2);
}

mkdirSync(`${OUT}/shots`, { recursive: true });
const log = (file: string, row: object) => appendFileSync(`${OUT}/${file}`, JSON.stringify({ t: new Date().toISOString(), ...row }) + "\n");

const rules = blockedHostRules();
const browser = await chromium.launch({ headless: process.env.UX_HEADED !== "1", args: rules ? [`--host-resolver-rules=${rules}`] : [] });
const context = await browser.newContext({ ...browserOptions(persona, APP.config.timezone), recordVideo: { dir: `${OUT}/video-tmp`, size: viewportOf(persona) } });
await context.tracing.start({ screenshots: true, snapshots: true });
await context.addInitScript(OVERLAY_INIT);

// --- guard ---------------------------------------------------------------------------------------------------
let stopped = ""; // set once the run is over; every later tool call gets it back
const external: string[] = []; // links to other sites blocked during the current step
function trip(url: string, why: string) {
  if (stopped) return;
  stopped = `STOPPED: ${why} (${url}). The run is over; do not call any more tools.`;
  writeFileSync(`${OUT}/guard.json`, JSON.stringify({ t: new Date().toISOString(), url, reason: why }, null, 1));
  log("errors.jsonl", { type: "blocked", url, text: why });
  void finalize().then(() => process.exit(3));
}
await context.route("**/*", (route) => {
  const req = route.request();
  const u = new URL(req.url());
  if (u.protocol !== "http:" && u.protocol !== "https:") return route.continue();
  if (isProdHost(u.hostname)) {
    if (req.isNavigationRequest()) trip(req.url(), "the tester tried to open a production site");
    else log("errors.jsonl", { type: "blocked", url: req.url(), text: "request to a production host blocked" });
    return route.abort("blockedbyclient");
  }
  if (req.isNavigationRequest() && !isDevUrl(u)) {
    external.push(req.url());
    log("errors.jsonl", { type: "blocked", url: req.url(), text: "link to another website not followed" });
    // 204 keeps the browser on the current page; an abort left the tester on Chrome's error page.
    return route.fulfill({ status: 204, body: "" });
  }
  return route.continue();
});
// Routes do not see redirect hops; production hosts also fail at DNS (blockedHostRules), this stops the run.
context.on("request", (req) => {
  if (req.redirectedFrom() && req.isNavigationRequest() && isProdHost(new URL(req.url()).hostname)) trip(req.url(), "a redirect led to a production site");
});

const page = await context.newPage();
const videoStart = Date.now(); // the video starts with the page; findings record their second in it
context.on("page", (p) => {
  external.push(`a link tried to open a new tab ${p.url() === "about:blank" ? "" : p.url()}`.trim());
  setTimeout(() => void p.close().catch(() => {}), 1000); // shortcut: popups are closed, not followed; follow dev-URL popups if an app needs them
});
page.on("framenavigated", (f) => {
  if (f !== page.mainFrame() || !/^https?:/.test(f.url()) || isDevUrl(f.url())) return;
  external.push(f.url()); // a redirect to a non-production outside site: go back
  void page.goBack().catch(() => {});
});
// Opt-in (run.ts --throttle): a Vite dev server sends hundreds of modules and does not load at all on slow 3G.
const net = process.env.UX_THROTTLE === "1" && networkOf(persona);
if (net) await (await context.newCDPSession(page)).send("Network.emulateNetworkConditions", net);

page.on("console", (m) => m.type() === "error" && log("errors.jsonl", { type: "console", url: page.url(), text: m.text().slice(0, 500) }));
page.on("pageerror", (e) => log("errors.jsonl", { type: "pageerror", url: page.url(), text: String(e).slice(0, 500) }));
page.on("response", (r) => r.status() >= 400 && log("errors.jsonl", { type: "http", url: r.url(), text: `${r.status()} ${r.request().method()}` }));
page.on("requestfailed", (r) => {
  const why = r.failure()?.errorText ?? "";
  if (!why.includes("BLOCKED_BY_CLIENT")) log("errors.jsonl", { type: "failed", url: r.url(), text: why });
});
let dialog = "";
page.on("dialog", (d) => {
  dialog = `A ${d.type()} box said: "${d.message()}" (it was answered with OK).`;
  void d.accept().catch(() => {});
});

// --- recording -------------------------------------------------------------------------------------------------
let last: Say = { who: persona.name, step: 0, kind: "start", en: "" };
const show = () => page.evaluate((s) => (window as any).__uxSay?.(s), last).catch(() => {});
page.on("load", () => void show());
async function say(s: Say) {
  last = s;
  await show();
}
/** Shows a chat bubble or a finding banner in the video for `ms`, then hides it. */
async function flash(fn: "__uxChat" | "__uxFlag", value: Chat | Flag, ms: number) {
  await page.evaluate(([f, v]) => (window as any)[f as string]?.(v), [fn, value] as const).catch(() => {});
  await page.waitForTimeout(ms);
  await page.evaluate((f) => (window as any)[f]?.(null), fn).catch(() => {});
}
const videoAt = () => Math.round((Date.now() - videoStart) / 100) / 10;
const firstName = (p: { name: string }) => p.name.split(",")[0].trim();

let closing: Promise<void> | undefined;
function finalize() {
  return (closing ??= (async () => {
    const video = page.video();
    await context.tracing.stop({ path: `${OUT}/trace.zip` }).catch(() => {});
    await context.close().catch(() => {});
    await video?.saveAs(`${OUT}/video.webm`).catch(() => {});
    await browser.close().catch(() => {});
    rmSync(`${OUT}/video-tmp`, { recursive: true, force: true });
  })());
}
const quit = () => void finalize().then(() => process.exit(0));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(sig, quit);
process.stdin.on("end", quit);
setInterval(() => Date.now() > deadline + 120_000 && quit(), 10_000).unref();

async function observe(name: string) {
  // Flutter web keeps its accessibility tree off until its hidden "Enable accessibility" button is pressed, and
  // testers can only act through that tree. On phones Flutter only accepts a press at the button's centre (where a
  // screen reader taps), so a bare .click() at 0,0 is ignored.
  const flutter = await page
    .evaluate(() => {
      const placeholder = document.querySelector<HTMLElement>("flt-semantics-placeholder");
      if (!placeholder) return false;
      const r = placeholder.getBoundingClientRect();
      const at = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      placeholder.dispatchEvent(new MouseEvent("click", at));
      return true;
    })
    .catch(() => false);
  if (flutter) await page.waitForTimeout(500);
  const shot = `shots/${name}.jpg`;
  const jpg = await page
    .screenshot({ path: `${OUT}/${shot}`, type: "jpeg", quality: 60, scale: "css", style: OVERLAY_HIDE_CSS, timeout: 15_000 })
    .catch(() => null);
  const snap = await page
    .locator("body")
    .ariaSnapshot({ mode: "ai", timeout: 15_000 })
    .catch((e: Error) => `(the page could not be read: ${e.message.split("\n")[0]})`);
  return { shot: jpg ? shot : undefined, jpg, snap };
}

async function describe(loc: Locator, ref: string) {
  return loc
    .evaluate(
      (el) => {
        const name = (el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("title") || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80);
        return `${el.getAttribute("role") || el.tagName.toLowerCase()} "${name}"`;
      },
      null,
      { timeout: 3000 },
    )
    .catch(() => ref);
}

// A long page's full outline was cut at 15k characters and the forms further down (a call-back form low on a home
// page, an admin "create" dialog) were never listed; past that size only headings and things to act on are kept.
const OUTLINE_MAX = 15_000;
// A line is YAML-quoted when its text holds ": " (e.g. - 'textbox "Ex: Marjan Group" [ref=e684]'), hence the '?.
const ACTIONABLE = /^\s*- '?(button|link|textbox|combobox|checkbox|radio|searchbox|switch|tab|menuitem|option|heading|dialog|alertdialog|slider|spinbutton)\b.*\[ref=/;
function outline(snap: string): string {
  if (snap.length <= OUTLINE_MAX) return snap;
  const compact = snap.split("\n").filter((l) => ACTIONABLE.test(l)).map((l) => l.trimStart()).join("\n");
  const cut = compact.length > OUTLINE_MAX ? compact.slice(0, OUTLINE_MAX) + "\n… (more further down)" : compact;
  return `(A long page: only headings and the things you can act on are listed here; read the rest in the picture.)\n${cut}`;
}

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
let ready: Promise<void> = Promise.resolve(); // the first page load, started once claude is connected
let n = 0;
let shots = 0;

type Thought = { thought_en: string } & Record<string, unknown>;
async function step(action: string, a: Thought & { ref?: string }, input: string | undefined, act: (loc: Locator) => Promise<unknown>) {
  await ready;
  if (stopped) return text(stopped);
  if (n >= MAX_STEPS || Date.now() > deadline) return text("You are out of steps or time. Call finish now.");
  n++;
  await say({ who: persona.name, step: n, kind: action, ...two(a.thought_en, v2(a, "thought")) });
  const loc = page.locator(`aria-ref=${a.ref}`);
  const target = a.ref ? await describe(loc, a.ref) : undefined;
  dialog = "";
  external.length = 0;
  let result = "done";
  try {
    await act(loc);
    await page.waitForLoadState("load", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(800);
  } catch (e) {
    result = `failed: ${(e as Error).message.split("\n")[0]}`;
  }
  if (stopped) return text(stopped);
  const view = await observe(String(n).padStart(3, "0"));
  log("steps.jsonl", { persona: persona.id, step: n, url: page.url(), action, target, input, thought: { en: a.thought_en, l2: v2(a, "thought") }, result, shot: view.shot });
  const head = [
    `Result: ${result}`,
    dialog,
    ...external.map((u) => `Blocked, you stay in the app: ${u}`),
    `Page: ${await page.title().catch(() => "")} (${page.url()})`,
    `Steps used: ${n} of ${MAX_STEPS}`,
  ].filter(Boolean);
  const snap = outline(view.snap);
  return {
    content: [
      { type: "text" as const, text: `${head.join("\n")}\n\nThe picture is what is on your screen now. The page outline below also lists parts further down; act on an element with its ref=… value.\n\n${snap}` },
      ...(view.jpg ? [{ type: "image" as const, data: view.jpg.toString("base64"), mimeType: "image/jpeg" }] : []),
    ],
  };
}

// --- tools -------------------------------------------------------------------------------------------------------
const server = new McpServer({ name: "ux", version: "0.1.0" });
const thought = {
  thought_en: z.string().describe("In first person, as yourself: what you see, what you expect, why you do this. One or two short sentences, English."),
  ...(L2 ? { [k2("thought")!]: z.string().describe(`The same thought in ${L2.name}.`) } : {}),
};
const ref = z.string().describe("The ref=… value of the element, from the last page outline, e.g. e12");

server.registerTool("look", { description: "Look at the screen without doing anything.", inputSchema: thought }, (a) => step("look", a, undefined, async () => {}));

server.registerTool(
  "goto",
  { description: "Type an address into the browser bar. Only addresses of this app work. A person with low tech skills never does this.", inputSchema: { url: z.string(), ...thought } },
  (a) => {
    if (!isDevUrl(a.url)) {
      if (/^https?:/.test(a.url) && isProdHost(new URL(a.url).hostname)) trip(a.url, "the tester tried to open a production site");
      return text(stopped || `Blocked: ${a.url} is not part of this app. You stay where you are.`);
    }
    return step("goto", a, a.url, () => page.goto(a.url, { timeout: 30_000 }));
  },
);

server.registerTool("click", { description: touch ? "Tap an element with your finger." : "Click an element.", inputSchema: { ref, ...thought } }, (a) =>
  step(touch ? "tap" : "click", a, undefined, (loc) => (touch ? loc.tap({ timeout: 8000 }) : loc.click({ timeout: 8000 }))),
);

server.registerTool(
  "type",
  { description: "Type into a text field (what was in it is replaced). submit presses Enter afterwards.", inputSchema: { ref, text: z.string(), submit: z.boolean().default(false), ...thought } },
  (a) =>
    step("type", a, a.text, async (loc) => {
      await loc.fill("", { timeout: 8000 });
      await loc.pressSequentially(a.text, { delay: 35 });
      if (a.submit) await loc.press("Enter");
    }),
);

server.registerTool("choose", { description: "Choose an option in a drop-down list, by its visible label.", inputSchema: { ref, option: z.string(), ...thought } }, (a) =>
  step("choose", a, a.option, (loc) => loc.selectOption({ label: a.option }, { timeout: 8000 }).catch(() => loc.selectOption(a.option, { timeout: 8000 }))),
);

server.registerTool("press", { description: "Press a key, e.g. Enter, Escape, Tab, Backspace.", inputSchema: { key: z.string(), ...thought } }, (a) =>
  step("press", a, a.key, () => page.keyboard.press(a.key)),
);

server.registerTool("scroll", { description: "Scroll the page by most of a screen.", inputSchema: { direction: z.enum(["down", "up"]), ...thought } }, (a) =>
  step(`scroll ${a.direction}`, a, undefined, () => page.mouse.wheel(0, (a.direction === "down" ? 0.8 : -0.8) * viewportOf(persona).height)),
);

server.registerTool("back", { description: "Press the browser's back button.", inputSchema: thought }, (a) => step("back", a, undefined, () => page.goBack({ timeout: 15_000 })));

server.registerTool(
  "note",
  {
    description:
      "Report a finding to the app's makers, right when you notice it. kind: issue (something broken or wrong), bad_ux (confusing, slow, too many steps, a dead end), bad_ui (looks wrong: overlapping, cut-off or tiny text, poor contrast, misaligned, ugly), idea (a smart improvement you would want), language (text you cannot read or in the wrong language), praise (something you liked). Be specific: what you expected and what happened. Give ref when it is about one element. Does not use a step.",
    inputSchema: {
      kind: z.enum(Object.keys(FINDING_KINDS) as [FindingKind, ...FindingKind[]]),
      en: z.string().describe("The finding in English, first person"),
      ...(L2 ? { [L2.code]: z.string().describe(`The same finding in ${L2.name}`) } : {}),
      ref: z.string().optional().describe("The element it is about, if any"),
    },
  },
  async (a) => {
    if (stopped) return text(stopped);
    const k = ++shots;
    const name = `${String(n).padStart(3, "0")}-${k}`;
    const loc = a.ref ? page.locator(`aria-ref=${a.ref}`) : undefined;
    const target = loc ? await describe(loc, a.ref!) : undefined;
    const rect = loc ? ((await loc.boundingBox({ timeout: 2000 }).catch(() => null)) ?? undefined) : undefined;
    const at = videoAt();
    const second = L2 ? ((a as Record<string, unknown>)[L2.code] as string | undefined) : undefined;
    await say({ who: persona.name, step: n, kind: a.kind, ...two(a.en, second) });
    // The banner and the outline stay up 2.5 s in the video; the evidence shot is taken with them on screen.
    const shown = flash("__uxFlag", { kind: a.kind, label: kindLabel(a.kind, L2?.code), who: firstName(persona), ...two(a.en, second), rect }, 2500);
    await page.waitForTimeout(300);
    const evidence = `shots/finding-${name}.jpg`;
    await page.screenshot({ path: `${OUT}/${evidence}`, type: "jpeg", quality: 70, scale: "css", style: "#__ux_box,#__ux_chat{display:none!important}" }).catch(() => {});
    await shown;
    log("notes.jsonl", { persona: persona.id, step: n, kind: a.kind, label: kindLabel(a.kind, L2?.code), url: page.url(), target, en: a.en, l2: second, l2_lang: L2?.code, evidence, video_s: at });
    return text("Noted. Carry on.");
  },
);

server.registerTool(
  "finish",
  {
    description: "End your visit: when the goal is done, when you give up, or when you are out of steps.",
    inputSchema: {
      goal_done: z.boolean(),
      quit_reason: z.string().optional().describe("If you gave up: why, in your own words"),
      would_sign_up: z.enum(["yes", "no", "maybe"]).describe("Would you sign up for this app or pay for it?"),
      why: z.string().describe("Why, in one or two sentences, in your own words"),
      summary: z.string().describe("Your visit in three or four sentences: what you tried, what worked, what did not"),
      ...(L2 ? { [k2("why")!]: z.string().describe(`The why sentence in ${L2.name}`) } : {}),
    },
  },
  async (a) => {
    if (stopped) return text(stopped);
    writeFileSync(`${OUT}/finish.json`, JSON.stringify({ t: new Date().toISOString(), steps: n, ...a }, null, 1));
    await say({ who: persona.name, step: n, kind: "finish", ...two(`${a.goal_done ? "Goal done." : "I give up."} Sign up: ${a.would_sign_up}. ${a.why}`, v2(a, "why")) });
    await page.waitForTimeout(2500);
    stopped = "Your visit is finished. Thank you; stop now.";
    await finalize();
    return text(stopped);
  },
);

// --- admin agent ---------------------------------------------------------------------------------------------------
// UX_ROLE=admin: this browser belongs to the admin agent, who answers one visitor with reply.
// UX_INBOX: the visitor's message, shown as an incoming chat bubble when the admin's visit starts.
const INBOX: { from: string; text: string } | undefined = process.env.UX_INBOX ? JSON.parse(process.env.UX_INBOX) : undefined;
if (process.env.UX_ROLE === "admin") {
  server.registerTool(
    "reply",
    {
      description: "Send your answer to the visitor, as you would on WhatsApp: that the account is ready and how to sign in.",
      inputSchema: { message_en: z.string().describe("The message, English"), ...(L2 ? { [k2("message")!]: z.string().describe(`The same message, ${L2.name}`) } : {}) },
    },
    async (a) => {
      if (stopped) return text(stopped);
      writeFileSync(`${OUT}/reply.json`, JSON.stringify({ t: new Date().toISOString(), message_en: a.message_en, message_2: v2(a, "message"), lang: L2?.code }, null, 1));
      await say({ who: persona.name, step: n, kind: "reply", ...two(a.message_en, v2(a, "message")) });
      await flash("__uxChat", { from: firstName(persona), to: INBOX?.from ?? "visitor", text: a.message_en, l2: v2(a, "message"), rtl: L2?.rtl, dir: "out" }, 2500);
      return text("Sent. Now call finish.");
    },
  );
}

// UX_ADMIN (testers): ask_admin runs a whole admin-agent visit and returns its reply.
const ADMIN: AdminSetup | undefined = process.env.UX_ADMIN ? JSON.parse(process.env.UX_ADMIN) : undefined;
let asks = 0;
if (ADMIN) {
  server.registerTool(
    "ask_admin",
    {
      description:
        `Write to ${TEAM}, as you would in a chat, to ask for your account or for help. You wait until they answer (a few minutes). Does not use a step.`,
      inputSchema: { message: z.string().describe("Your message to the team, in your own words"), ...thought },
    },
    async (a) => {
      if (stopped) return text(stopped);
      if (asks >= 2) return text("You already wrote to the team twice. Carry on with what you have, or finish.");
      const k = ++asks;
      await say({ who: persona.name, step: n, kind: "ask the team", ...two(a.thought_en, v2(a, "thought")) });
      await flash("__uxChat", { from: firstName(persona), to: TEAM_LABEL, text: a.message, dir: "out" }, 2000);
      const who = (persona as Persona & { test_identity: TestIdentity }).test_identity;
      const admin = loadPersona(APP.adminPersonaFile);
      const login: AdminLogin = JSON.parse(readFileSync(APP.adminLoginFile, "utf8"));
      const origin = new URL(START).origin;
      const business = `${persona.business.trade} ${who.first_name} (test)`;
      const dir = join(dirname(OUT), `${persona.id}-admin-${k}`);
      const t0 = Date.now();
      await say({ who: persona.name, step: n, kind: "waiting", ...two(`Waiting for ${TEAM} to answer…`, L2 && WAITING_2[L2.code]) });
      await runAgent({
        persona: admin,
        url: `${origin}${ADMIN_START}`,
        dir,
        goal: `Set up ${who.first_name}'s account (${persona.id})`,
        model: process.env.UX_MODEL ?? "sonnet",
        steps: ADMIN.steps,
        minutes: ADMIN.minutes,
        who,
        system: adminPrompt(admin, login, a.message, who, origin, APP.config, business, L2),
        lang2: L2,
        prompt: `The admin screens are open in front of you at ${origin}${ADMIN_START}. Start: call look.`,
        app: APP,
        env: { UX_ROLE: "admin", UX_LANG2: L2?.code ?? "", UX_INBOX: JSON.stringify({ from: firstName(persona), text: a.message }), ...(process.env.UX_HEADED ? { UX_HEADED: "1" } : {}) },
      }).catch((e: Error) => log("errors.jsonl", { type: "admin", url: origin, text: e.message }));
      // No reply (the model refused to start the admin agent, or it failed): the scripted admin does the job.
      let scripted = false;
      if (!existsSync(`${dir}/reply.json`)) {
        mkdirSync(dir, { recursive: true });
        const calls: object[] = [];
        await runScriptedAdmin(APP.scriptedAdminFile, { origin, login, who, business, app: APP.config, lang2: L2, log: (row) => calls.push({ t: new Date().toISOString(), ...row }) })
          .then((r) => writeFileSync(`${dir}/reply.json`, JSON.stringify({ t: new Date().toISOString(), ...r, scripted: true }, null, 1)))
          .catch((e: Error) => log("errors.jsonl", { type: "admin", url: origin, text: `scripted admin: ${e.message}` }))
          .finally(() => writeFileSync(`${dir}/scripted.json`, JSON.stringify(calls, null, 1)));
        scripted = existsSync(`${dir}/reply.json`);
      }
      deadline += Date.now() - t0;
      const reply = existsSync(`${dir}/reply.json`) ? JSON.parse(readFileSync(`${dir}/reply.json`, "utf8")) : null;
      log("steps.jsonl", {
        persona: persona.id,
        step: n,
        url: page.url(),
        action: "ask_admin",
        input: a.message,
        thought: { en: a.thought_en, l2: v2(a, "thought") },
        result: reply ? `answered after ${Math.round((Date.now() - t0) / 1000)} s${scripted ? " (scripted admin)" : ""}` : "no answer",
        admin_run: basename(dir),
      });
      if (!reply) return text(`${TEAM_LABEL} did not answer. You can write once more, or finish.`);
      const reply2: string | undefined = reply.message_2 ?? reply.message_ar; // message_ar: replies saved before 2026-10-18
      await say({ who: TEAM_LABEL, step: n, kind: "reply", ...two(reply.message_en, reply2) });
      await flash("__uxChat", { from: TEAM_LABEL, to: firstName(persona), text: reply.message_en, l2: reply2, rtl: L2?.rtl, dir: "in" }, 3000);
      return text(`${TEAM_LABEL} answered:\n${reply.message_en}${reply2 ? `\n${reply2}` : ""}`);
    },
  );
}

// Connect first: claude gives up on a server that is slow to answer, and a dev page on slow 3G takes long.
const transport = new StdioServerTransport();
transport.onclose = quit;
await server.connect(transport);
ready = page.goto(START, { timeout: 120_000 }).then(
  () => (INBOX ? flash("__uxChat", { from: INBOX.from, to: firstName(persona), text: INBOX.text, dir: "in" }, 2500) : undefined),
  (e: Error) => log("errors.jsonl", { type: "failed", url: START, text: e.message.split("\n")[0] }),
);

// Persona files (<personas dir>/<id>.yaml): who the tester is, and how that turns into browser settings and prompts.
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import type { BrowserContextOptions } from "playwright";
import { z } from "zod";
import { ConfigError, explain, fill, ROOT, type AppConfig } from "./app";
import type { Lang2 } from "./lang";

export type Persona = {
  id: string;
  name: string; // "Maria, 58, Lisbon"
  languages: { speaks: string[]; reads: string[]; ui_choice: string; locale?: string }; // ui_choice: arabic|french|english or a locale like pt-PT
  tech: { level: "low" | "medium" | "high"; device: "android-budget" | "iphone" | "pc"; viewport?: string; network?: "slow-3g" | "3g" | "wifi"; habits: string };
  literacy?: string;
  accessibility?: string[];
  business: { trade: string; staff?: number | string; today?: string; customers?: string; revenue?: string }; // or, for a game, who the player is
  goal: string; // "explore freely" lets the agent roam
  pains: string[];
  doubts: string[];
  patience: "low" | "medium" | "high";
};

/** The general example testers; an app's own are in apps/<app>/personas/. */
export const PERSONA_DIR = join(import.meta.dir, "..", "personas");

const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  languages: z.object({ speaks: z.array(z.string()), reads: z.array(z.string()).min(1), ui_choice: z.string().min(2), locale: z.string().optional() }),
  tech: z.object({
    level: z.enum(["low", "medium", "high"]),
    device: z.enum(["android-budget", "iphone", "pc"]),
    viewport: z.string().regex(/^\d+x\d+$/, 'like "390x844"').optional(),
    network: z.enum(["slow-3g", "3g", "wifi"]).optional(),
    habits: z.string(),
  }),
  literacy: z.string().optional(),
  accessibility: z.array(z.string()).optional(),
  business: z.object({ trade: z.string().min(1) }).passthrough(),
  goal: z.string().min(1),
  pains: z.array(z.string()).default([]),
  doubts: z.array(z.string()).default([]),
  patience: z.enum(["low", "medium", "high"]),
});

export function loadPersona(path: string): Persona {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ConfigError(`${relative(ROOT, path)}: not valid YAML: ${(e as Error).message.split("\n")[0]}`);
  }
  const parsed = PersonaSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(explain(path, parsed.error));
  if (parsed.data.id !== basename(path, ".yaml") && basename(path) !== "admin.yaml")
    throw new ConfigError(`${relative(ROOT, path)}: id: must be "${basename(path, ".yaml")}", the file's name`);
  return parsed.data as Persona;
}

export function listPersonas(dir = PERSONA_DIR): Persona[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => loadPersona(join(dir, f)));
}

const LOCALE: Record<string, string> = { arabic: "ar", french: "fr", english: "en-US", spanish: "es", portuguese: "pt", german: "de" };
const UA = {
  "android-budget": "Mozilla/5.0 (Linux; Android 13; SM-A145F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
} as const;
const SIZE = { "android-budget": "360x780", iphone: "390x844", pc: "1366x768" } as const;

export function viewportOf(p: Persona) {
  const [width, height] = (p.tech.viewport ?? SIZE[p.tech.device]).split("x").map(Number);
  return { width, height };
}

export function browserOptions(p: Persona, timezone = "UTC"): BrowserContextOptions {
  const mobile = p.tech.device !== "pc";
  const choice = p.languages.ui_choice;
  return {
    viewport: viewportOf(p),
    locale: p.languages.locale ?? LOCALE[choice] ?? choice,
    timezoneId: timezone,
    ...(mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: UA[p.tech.device as keyof typeof UA] } : {}),
  };
}

/** Chrome DevTools network profile for the persona's connection, or null for full speed. */
export function networkOf(p: Persona) {
  const kbps = { "slow-3g": [400, 400], "3g": [1600, 150] }[p.tech.network ?? "wifi"];
  return kbps ? { offline: false, downloadThroughput: (kbps[0] * 1024) / 8, uploadThroughput: (kbps[0] * 1024) / 8, latency: kbps[1] } : null;
}

const SKILL = {
  low: "You only tap things that are clearly labelled with words you read. You do not guess what an icon without a label does, you never type addresses into the browser, you read slowly and you miss small text. Forms with many fields make you nervous.",
  medium: "You use apps every day. You try menus and icons that look common, but you give up on anything that looks technical.",
  high: "You are at ease with web apps: you scan quickly, try shortcuts, open menus and settings, and you notice slow pages and sloppy details.",
};
const PATIENCE = { low: 3, medium: 6, high: 10 };

export type TestIdentity = { first_name: string; phone: string; email: string; password: string };

const askAdmin = (team: string) => `
- ${team[0].toUpperCase()}${team.slice(1)}: when the app says someone will contact you, or you need an account, first ask
  through the app the way a real visitor would (for example a contact or request form, with your test identity). Then
  call ask_admin with a short message, as you would send in a chat. They answer with how to sign in; then carry on
  with your goal signed in. Call it at most twice.`;

/** The tester's prompt. team: who ask_admin reaches, only when --admin is on. */
/** How thoughts are written: English, plus the optional second language (thought_ar, …). */
function writing(l2: Lang2 | undefined, darija: boolean) {
  if (!l2) return "- Every action takes thought_en: in first person, as yourself, one or two short sentences on what you see, what you expect and why you do it. It is shown on screen and recorded.";
  return `- Every action takes thought_en and thought_${l2.code}: in first person, as yourself, one or two short sentences on what you see, what you expect and why you do it. thought_${l2.code} says the same thing in ${l2.name}${darija && l2.code === "ar" ? " (Darija in Arabic letters)" : ""}. Both are shown on screen and recorded.`;
}
const inLanguages = (l2?: Lang2) => (l2 ? `in English and ${l2.name}` : "in English");

export function systemPrompt(p: Persona, who: TestIdentity, goal = p.goal, team?: string, l2?: Lang2): string {
  const { goal: _g, id: _i, ...profile } = p;
  return `You are role-playing a real person who opens a web app for the first time. Stay in character the whole time.
You are not an AI assistant, you are not a developer and you know nothing about how the app is built.

WHO YOU ARE
${Bun.YAML.stringify(profile, null, 2)}

HOW YOU BEHAVE
- ${SKILL[p.tech.level]}
- You read only these languages: ${p.languages.reads.join(", ")}. When a screen or a word is in a language you do not read well, write a note with kind "language" and react as this person would (guess, hesitate or give up).
- Patience: after about ${PATIENCE[p.patience]} dead ends or confusing screens in a row you give up: call finish with goal_done false and say why.
- Think about your situation (${p.business.trade}), your pains and your doubts while you look around: does this app help you, would you trust it, would you pay for it or keep using it?

YOUR GOAL FOR THIS VISIT
${goal}

TOOLS AND RULES
- The browser tools are the only thing you can use. Start with look.
${writing(l2, p.languages.speaks.includes("darija"))}
- Use note the moment you find something: an issue (broken or wrong), bad UX (confusing, slow, a dead end), bad UI (looks wrong: overlap, cut or tiny text, poor contrast), a smart idea you would want, a language problem, or something you like. Say what you expected and what happened instead, ${inLanguages(l2)}, and give the element's ref when it is about one element.
- When a form asks for your details, use only this test identity, never anything else: first name ${who.first_name}, phone ${who.phone}, email ${who.email}, password ${who.password}. For a business or team name use "${p.business.trade} ${who.first_name} (test)".
- Never enter card or bank details. Links to other websites are blocked; you stay in the app.${team ? askAdmin(team) : ""}
- When your goal is done, or you give up, or you run out of steps, call finish.`;
}

export type AdminLogin = { phone: string; password: string };

const DEFAULT_JOB = `1. Sign in to the admin screens at {app_url}{start_path} with phone {admin_phone} and password {admin_password}.
2. Look for their request, if the app keeps one. Note whether it was easy to find.
3. Create their account with their phone {visitor_phone} and this password: {visitor_password} (a test value;
   normally you would choose one). Give it whatever access a new user should have.
4. Call reply with the message you would send them: that their account is ready, the sign-in address
   {app_url}{signin_path}, their phone and the password. {languages}.
5. Call finish: goal_done = the account works and the reply is sent; would_sign_up = would you be happy doing this
   job every day with these screens; why.`;

/** The admin agent: a team member who handles one visitor's request in the app's own admin screens. */
export function adminPrompt(p: Persona, login: AdminLogin, request: string, visitor: TestIdentity, appUrl: string, app: AppConfig, business: string, l2?: Lang2): string {
  const { goal: _g, id: _i, ...profile } = p;
  const job = fill(app.admin?.job ?? DEFAULT_JOB, {
    app_url: appUrl,
    start_path: app.admin?.start_path ?? "/admin",
    signin_path: app.admin?.signin_path ?? "/login",
    admin_phone: login.phone,
    admin_password: login.password,
    visitor_name: visitor.first_name,
    visitor_phone: visitor.phone,
    visitor_email: visitor.email,
    visitor_password: visitor.password,
    visitor_business: business,
    languages: l2 ? `English and ${l2.name}` : "English",
  });
  return `You are role-playing a member of ${app.team} at work. Stay in character. You use only what the admin screens
show you; you know nothing about how ${app.name} is built.

WHO YOU ARE
${Bun.YAML.stringify(profile, null, 2)}

A VISITOR WROTE TO THE TEAM
"${request}"
Their details: name ${visitor.first_name}, phone ${visitor.phone}, email ${visitor.email}.

YOUR JOB
${job}

RULES
${writing(l2, false)}
- Use note for every finding in the admin screens: issue, bad UX, bad UI, a smart idea, language; give the element's ref when it is about one element.
- Never delete, suspend or change any other account or data. Links to other websites are blocked.`;
}

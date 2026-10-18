// The no-AI admin. When the AI admin agent gives no reply (the model's safeguards refused to start it, or it failed),
// the app's own script (apps/<app>/scripted-admin.ts, default export) does the job through the app's dev API, so the
// tester still gets in. This file runs that script, only against a local dev address, and gives it a small API helper.
import { existsSync } from "node:fs";
import type { AppConfig } from "./app";
import type { Lang2 } from "./lang";
import { isDevUrl } from "./guard";
import type { AdminLogin, TestIdentity } from "./persona";

/** message_2: the same message in the second language, when one is set (ctx.lang2). */
export type Reply = { message_en: string; message_2?: string };
export type ScriptedAdminContext = {
  origin: string; // the app's local dev origin, e.g. http://localhost:3000
  login: AdminLogin; // the dev-only admin login (apps/<app>/admin.local.json)
  who: TestIdentity; // the tester's fake identity: the account to create
  business: string; // a name for the tester's business, team or profile
  app: AppConfig;
  lang2?: Lang2; // the second language, if any: also return message_2
  log: (row: object) => void; // each call, saved to <tester>-admin-<n>/scripted.json
};
export type ScriptedAdmin = (ctx: ScriptedAdminContext) => Promise<Reply>;

export async function runScriptedAdmin(file: string, ctx: ScriptedAdminContext): Promise<Reply> {
  if (!isDevUrl(ctx.origin)) throw new Error(`scripted admin refuses ${ctx.origin}: not a local dev URL`);
  if (!existsSync(file)) throw new Error(`no scripted admin for this app (${file})`);
  const script = (await import(file)).default as ScriptedAdmin;
  return script(ctx);
}

/** For app scripts: POST JSON to <origin><prefix><path> keeping cookies, with an optional double-submit CSRF header. */
export function devApi(ctx: Pick<ScriptedAdminContext, "origin" | "log">, opts: { prefix?: string; csrfCookie?: string; csrfHeader?: string } = {}) {
  if (!isDevUrl(ctx.origin)) throw new Error(`devApi refuses ${ctx.origin}: not a local dev URL`);
  const jar = new Map<string, string>();
  return async (step: string, path: string, body?: object) => {
    const csrf = opts.csrfCookie && jar.get(opts.csrfCookie);
    const res = await fetch(`${ctx.origin}${opts.prefix ?? ""}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(csrf ? { [opts.csrfHeader ?? "x-csrf-token"]: decodeURIComponent(csrf) } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [kv] = c.split(";");
      const i = kv.indexOf("=");
      jar.set(kv.slice(0, i).trim(), kv.slice(i + 1));
    }
    const json = (await res.json().catch(() => ({}))) as { data?: any; message?: string };
    ctx.log({ step, path, status: res.status, message: json.message });
    if (!res.ok) throw new Error(`${step}: HTTP ${res.status} ${json.message ?? ""}`.trim());
    return json;
  };
}

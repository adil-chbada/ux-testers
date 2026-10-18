// Everything specific to the app under test lives in apps/<app>/ (only apps/example/ is in git):
//   app.yaml            name, local URL, default testers and goal, team, production domains, timezone, admin settings
//   personas/*.yaml     its testers (else the general examples in personas/)
//   admin.yaml          the admin agent's persona            (for --admin)
//   admin.local.json    { "phone", "password" }: a DEV-ONLY admin login (for --admin)
//   scripted-admin.ts   default export: the no-AI admin's API calls (for --admin, when the AI admin gives no reply)
//   README.md           notes for running this app (dev server, setup)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";

const AppSchema = z
  .object({
    name: z.string().min(1).describe("what testers call your app"),
    url: z.url("a full local address like http://localhost:3000").optional(),
    personas: z.array(z.string()).optional().describe("default testers (file names), e.g. [retiree-low-tech, power-user-pro]"),
    goal: z.string().optional().describe("default task for every tester"),
    steps: z.number().int().positive().optional(),
    minutes: z.number().positive().optional(),
    team: z.string().min(1).describe('who testers reach with ask_admin, e.g. "the Acme team"'),
    prod_domains: z.array(z.string().regex(/^[a-z0-9.*-]+\.[a-z]{2,}$/i, "a domain like example.com")),
    timezone: z.string().min(1),
    phone_format: z.string().regex(/#/, "use # for each random digit, e.g. 555#######"),
    second_language: z.string().regex(/^[a-z]{2}$/, "a two-letter language code like ar, fr, es (or leave it out for English only)").optional(),
    admin: z
      .object({
        start_path: z.string().startsWith("/").default("/admin"),
        signin_path: z.string().startsWith("/").default("/login"),
        job: z.string().optional(),
      })
      .optional(),
  })
  .strict();

export type AppConfig = z.infer<typeof AppSchema>;

export const ROOT = join(import.meta.dir, "..");
export const APPS_DIR = join(ROOT, "apps");

const DEFAULTS = { team: "the team", prod_domains: [], timezone: "UTC", phone_format: "555#######" };

export type App = {
  id: string;
  dir: string;
  config: AppConfig;
  personasDir: string;
  adminPersonaFile: string;
  adminLoginFile: string;
  scriptedAdminFile: string;
};

/** A config mistake, said in words a non-developer can act on. */
export class ConfigError extends Error {}

/** Turns schema problems into "file: field: what is wrong" lines. */
export function explain(file: string, error: z.ZodError): string {
  return error.issues
    .map((i) => {
      const where = i.path.length ? i.path.join(".") : "(the file)";
      const what = i.code === "unrecognized_keys" ? `unknown setting${i.keys.length > 1 ? "s" : ""} ${i.keys.map((k) => `"${k}"`).join(", ")} (check the spelling)` : i.message;
      return `${relative(ROOT, file)}: ${where}: ${what}`;
    })
    .join("\n");
}

/** apps/<id>/, or any folder given as dir; a missing app.yaml means the general defaults. */
export function loadApp(id: string, dir = join(APPS_DIR, id)): App {
  const file = join(dir, "app.yaml");
  let raw: unknown = {};
  if (existsSync(file)) {
    try {
      raw = Bun.YAML.parse(readFileSync(file, "utf8")) ?? {};
    } catch (e) {
      throw new ConfigError(`${relative(ROOT, file)}: not valid YAML: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  const parsed = AppSchema.safeParse({ ...DEFAULTS, name: id, ...(raw as object) });
  if (!parsed.success) throw new ConfigError(explain(file, parsed.error));
  const own = join(dir, "personas");
  return {
    id,
    dir,
    config: parsed.data,
    personasDir: existsSync(own) ? own : join(ROOT, "personas"),
    adminPersonaFile: join(dir, "admin.yaml"),
    adminLoginFile: join(dir, "admin.local.json"),
    scriptedAdminFile: join(dir, "scripted-admin.ts"),
  };
}

/** The app folders in apps/ (the example included). */
export function listApps(): string[] {
  return existsSync(APPS_DIR) ? readdirSync(APPS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
}

/** Fills {placeholders} in a config text. */
export const fill = (text: string, values: Record<string, string>) => text.replace(/\{(\w+)\}/g, (m, k) => values[k] ?? m);

export function fakePhone(format: string): string {
  return format.replace(/#/g, () => String(crypto.getRandomValues(new Uint8Array(1))[0] % 10));
}

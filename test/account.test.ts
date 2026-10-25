// --account: the dev account made before a tester starts, and what the tester is told. No model is called.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApp } from "../src/app";
import { loadPersona, systemPrompt } from "../src/persona";
import { createAccount } from "../src/scripted-admin";

const who = { first_name: "Hassan", phone: "0612345678", email: "h@example.test", password: "UxTest-abc!" };

function appWithScript(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "ux-account-"));
  writeFileSync(join(dir, "app.yaml"), "name: Demo\nprod_domains: [demo.example]\n");
  writeFileSync(join(dir, "admin.local.json"), JSON.stringify({ phone: "0600000000", password: "dev-only" }));
  writeFileSync(join(dir, "scripted-admin.ts"), script);
  return { dir, app: loadApp("demo", dir) };
}

test("createAccount runs the app's script, saves account.json and returns the sign-in message", async () => {
  const { dir, app } = appWithScript(`export default async ({ who, business, origin, login }) =>
    ({ message_en: "Sign in at " + origin + "/login as " + who.phone + " (" + business + ", admin " + login.phone + ")" });`);
  const out = join(dir, "run", "hassan");
  const msg = await createAccount(app, "http://localhost:4229/", who, "signage workshop", undefined, out);
  expect(msg).toBe("Sign in at http://localhost:4229/login as 0612345678 (signage workshop Hassan (test), admin 0600000000)");
  expect(JSON.parse(readFileSync(join(out, "account.json"), "utf8")).business).toBe("signage workshop Hassan (test)");
});

test("createAccount refuses an address that is not local", async () => {
  const { dir, app } = appWithScript(`export default async () => ({ message_en: "should not run" });`);
  await expect(createAccount(app, "https://shop.example.com", who, "shop", undefined, join(dir, "x"))).rejects.toThrow("not a local dev URL");
});

test("the tester's prompt carries the account message only when there is one", () => {
  const persona = loadPersona(join(import.meta.dir, "..", "personas", "shop-owner-arabic.yaml"));
  const withIt = systemPrompt(persona, { ...who }, "make a quote", undefined, undefined, "Sign in at http://localhost:1/login");
  expect(withIt).toContain("YOUR ACCOUNT");
  expect(withIt).toContain("Sign in at http://localhost:1/login");
  expect(systemPrompt(persona, { ...who }, "make a quote")).not.toContain("YOUR ACCOUNT");
});

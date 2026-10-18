import { expect, test } from "bun:test";
import { testIdentity } from "../src/agent";
import { fill, loadApp } from "../src/app";
import { blockedHostRules, isDevUrl, isProdHost, setProdDomains } from "../src/guard";
import { lang2 } from "../src/lang";
import { adminPrompt, browserOptions, listPersonas, loadPersona, systemPrompt } from "../src/persona";
import { runScriptedAdmin } from "../src/scripted-admin";

setProdDomains(["prod.example.com", "example.org"]);

test("local dev hosts are allowed", () => {
  for (const u of ["http://localhost:3000/", "http://127.0.0.1:8080/api", "http://[::1]:8080", "http://shop.localhost:3000", "https://myapp.test"]) expect(isDevUrl(u)).toBe(true);
});

test("production, other sites and other schemes are refused", () => {
  for (const u of ["https://prod.example.com", "http://www.prod.example.com/x", "https://api.example.org", "http://localhost.example.org", "https://example.net", "https://wa.me/15550000000", "file:///etc/passwd", "javascript:alert(1)", "not a url"])
    expect(isDevUrl(u)).toBe(false);
  expect(isProdHost("PROD.EXAMPLE.COM.")).toBe(true);
  expect(isProdHost("notexample.org")).toBe(false);
  expect(blockedHostRules()).toContain("MAP *.example.org ~NOTFOUND");
});

test("no production domains means no DNS rules", () => {
  setProdDomains([]);
  expect(blockedHostRules()).toBe("");
  setProdDomains(["prod.example.com", "example.org"]);
});

test("the scripted admin refuses anything but a local dev address", async () => {
  const who = { first_name: "A", phone: "5550000000", email: "a@example.test", password: "x" };
  const ctx = { origin: "https://prod.example.com", login: { phone: "x", password: "y" }, who, business: "b", app: loadApp("example").config, log: () => {} };
  await expect(runScriptedAdmin("/nonexistent.ts", ctx)).rejects.toThrow("not a local dev URL");
});

test("an app without a folder gets general defaults; the example folder loads", () => {
  const none = loadApp("no-such-app");
  expect(none.config).toMatchObject({ name: "no-such-app", team: "the team", prod_domains: [], timezone: "UTC" });
  expect(none.personasDir).toEndWith("/personas");
  const ex = loadApp("example");
  expect(ex.config.prod_domains).toEqual(["example.com"]);
  expect(loadPersona(ex.adminPersonaFile).id).toBe("example-admin");
  expect(fill("{a} and {b} and {c}", { a: "1", b: "2" })).toBe("1 and 2 and {c}");
});

test("every example persona loads, maps to a browser and a prompt with the test identity", () => {
  const all = listPersonas();
  expect(all.length).toBeGreaterThanOrEqual(4);
  expect(new Set(all.map((p) => p.tech.level))).toEqual(new Set(["low", "medium", "high"]));
  for (const p of all) {
    const o = browserOptions(p, "Europe/London");
    expect(o.viewport!.width).toBeGreaterThan(300);
    expect(o.locale).toMatch(/^[a-z]{2}(-[A-Z]{2})?$/);
    expect(o.timezoneId).toBe("Europe/London");
    const who = testIdentity(p, "555#######");
    expect(who.email).toEndWith("@example.test");
    expect(who.phone).toMatch(/^555\d{7}$/);
    const prompt = systemPrompt(p, who);
    expect(prompt).toContain(who.password);
    expect(prompt).toContain(p.goal);
    expect(prompt).not.toContain("ask_admin");
    expect(systemPrompt(p, who, p.goal, "the Acme team")).toContain("The Acme team: when the app says");
    expect(prompt).not.toContain("thought_ar"); // English only by default
    const bilingual = systemPrompt(p, who, p.goal, undefined, lang2("ar"));
    expect(bilingual).toContain("thought_ar");
    expect(bilingual).toContain("in English and Arabic");
  }
});

test("the admin prompt is filled from the app's config", () => {
  const ex = loadApp("example");
  const who = { first_name: "Ana", phone: "5551234567", email: "ana@example.test", password: "UxTest-1!" };
  const prompt = adminPrompt(loadPersona(ex.adminPersonaFile), { phone: "5550000000", password: "dev-pw" }, "Hi, I need an account", who, "http://localhost:3000", ex.config, "Ana's team (test)");
  expect(prompt).toContain("a member of the Example App team");
  expect(prompt).toContain("http://localhost:3000/admin");
  expect(prompt).toContain("http://localhost:3000/login");
  expect(prompt).toContain("UxTest-1!");
  expect(prompt).not.toMatch(/\{[a-z_]+\}/);
});

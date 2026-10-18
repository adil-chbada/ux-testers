// Drives browser-mcp.ts the way claude does (MCP over stdio) against a tiny local site; no model is called,
// except the last test, which starts the real CLI only until it reports its tool list.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeArgs, MCP_SCRIPT, mcpConfig, subscriptionEnv, subscriptionProblem } from "../src/agent";
import { listPersonas } from "../src/persona";

setDefaultTimeout(60_000);

const site = Bun.serve({
  port: 0,
  fetch(req) {
    const u = new URL(req.url);
    if (u.pathname === "/to-prod") return Response.redirect("https://prod.example.com/pricing", 302);
    if (u.pathname === "/long")
      return new Response(
        `<!doctype html><title>Long</title><body>${"<p>Some long marketing text about the product. </p>".repeat(600)}
         <form><label>Votre nom <input name="name"></label><input placeholder="Ex: Marjan Group"><button>Envoyer</button></form></body>`,
        { headers: { "content-type": "text/html" } },
      );
    return new Response(
      `<!doctype html><html><head><title>Test shop</title></head><body><h1>Test shop</h1>
       <a href="https://wa.me/15550000000">WhatsApp us</a>
       <a href="/to-prod">See offers</a>
       <label>Name <input name="n"></label></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const URL0 = `http://localhost:${site.port}/`;
// A throwaway app folder whose production domain is prod.example.com.
const APP_DIR = mkdtempSync(join(tmpdir(), "ux-app-"));
writeFileSync(join(APP_DIR, "app.yaml"), "name: Test shop\nteam: the Test team\nprod_domains: [prod.example.com]\nsecond_language: ar\n");
afterAll(() => site.stop(true));

const persona = listPersonas().find((p) => p.tech.device === "pc")!;
const slowPhone = listPersonas().find((p) => p.tech.network === "slow-3g")!;
const thought = { thought_en: "I look around.", thought_ar: "كنشوف." };

async function open(p = persona, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ux-test-"));
  writeFileSync(join(dir, "persona.json"), JSON.stringify(p));
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [MCP_SCRIPT], env: { ...process.env, UX_OUT: dir, UX_URL: URL0, UX_APP: "test", UX_APP_DIR: APP_DIR, ...extra } as Record<string, string> }));
  const call = async (name: string, args: object) => {
    const r = (await client.callTool({ name, arguments: { ...thought, ...args } })) as { content: { type: string; text?: string }[] };
    return { text: r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n"), images: r.content.filter((c) => c.type === "image").length };
  };
  const refOf = (snapshot: string, name: string) => snapshot.match(new RegExp(`link "${name}".*?\\[ref=(\\w+)\\]`))![1];
  return { dir, client, call, refOf };
}

test("exposes only browser tools, at once, and taps on a phone persona", async () => {
  const t0 = Date.now();
  const { client, call, refOf } = await open(slowPhone);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(Date.now() - t0).toBeLessThan(10_000);
  expect(names).toEqual(["back", "choose", "click", "finish", "goto", "look", "note", "press", "scroll", "type"]);
  const look = await call("look", {});
  expect(look.text).toContain("Test shop");
  expect((await call("click", { ref: refOf(look.text, "WhatsApp us") })).text).toContain("Blocked"); // a tap on a touch device
  await client.close();
});

test("English only by default: no second-language fields; with second_language: ar they appear", async () => {
  const props = async (extra: Record<string, string>) => {
    const { client } = await open(persona, extra);
    const tools = (await client.listTools()).tools;
    await client.close();
    const keys = (name: string) => Object.keys((tools.find((t) => t.name === name)!.inputSchema as { properties: object }).properties);
    return { look: keys("look"), note: keys("note"), finish: keys("finish") };
  };
  const en = await props({ UX_LANG2: "" });
  expect(en.look).toEqual(["thought_en"]);
  expect(en.note).not.toContain("ar");
  expect(en.finish).not.toContain("why_ar");
  const ar = await props({ UX_LANG2: "ar" });
  expect(ar.look).toEqual(["thought_en", "thought_ar"]);
  expect(ar.note).toContain("ar");
  expect(ar.finish).toContain("why_ar");
  const fr = await props({ UX_LANG2: "fr" });
  expect(fr.look).toEqual(["thought_en", "thought_fr"]);
});

test("the admin agent gets reply; testers get ask_admin only when the admin is on", async () => {
  const adminSide = await open(persona, { UX_ROLE: "admin" });
  const adminTools = (await adminSide.client.listTools()).tools.map((t) => t.name);
  expect(adminTools).toContain("reply");
  expect(adminTools).not.toContain("ask_admin");
  await adminSide.call("reply", { message_en: "Your account is ready.", message_ar: "الحساب ديالك واجد." });
  expect(JSON.parse(readFileSync(join(adminSide.dir, "reply.json"), "utf8")).message_en).toBe("Your account is ready.");
  await adminSide.client.close();

  const tester = await open(persona, { UX_ADMIN: JSON.stringify({ minutes: 1, steps: 1 }) });
  const testerTools = (await tester.client.listTools()).tools.map((t) => t.name);
  expect(testerTools).toContain("ask_admin");
  expect(testerTools).not.toContain("reply");
  await tester.client.close();
});

test("on a long page the form at the bottom is still listed with its refs", async () => {
  const { client, call } = await open();
  const r = await call("goto", { url: `${URL0}long` });
  expect(r.text).toContain("A long page");
  expect(r.text).toMatch(/textbox "Votre nom" \[ref=\w+\]/);
  expect(r.text).toMatch(/button "Envoyer" \[ref=\w+\]/);
  expect(r.text).toMatch(/textbox "Ex: Marjan Group" \[ref=\w+\]/); // a quoted outline line
  await client.close();
});

test("records steps, notes and a video; outside links are blocked but the visit goes on", async () => {
  const { dir, client, call, refOf } = await open();
  const look = await call("look", {});
  expect(look.images).toBe(1);
  expect(look.text).toContain("Test shop");
  const wa = await call("click", { ref: refOf(look.text, "WhatsApp us") });
  expect(wa.text).toContain("Blocked, you stay in the app");
  expect(wa.text).toContain("Page: Test shop"); // still on the app, not Chrome's error page
  expect(existsSync(join(dir, "guard.json"))).toBe(false);
  await call("note", { kind: "bad_ux", en: "Where are the prices?", ar: "فين الأثمنة؟", ref: refOf(wa.text, "WhatsApp us") }); // refs from the latest outline
  const done = await call("finish", { goal_done: false, quit_reason: "test", would_sign_up: "maybe", why: "test", why_ar: "تجربة", summary: "test" });
  expect(done.text).toContain("finished");
  const steps = readFileSync(join(dir, "steps.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(steps.map((s) => s.action)).toEqual(["look", "click"]);
  expect(steps[1].thought).toEqual({ en: thought.thought_en, l2: thought.thought_ar });
  expect(existsSync(join(dir, steps[0].shot))).toBe(true);
  const finding = JSON.parse(readFileSync(join(dir, "notes.jsonl"), "utf8"));
  expect(finding.kind).toBe("bad_ux");
  expect(finding.label).toBe("Bad UX · تجربة صعيبة");
  expect(finding).toMatchObject({ en: "Where are the prices?", l2: "فين الأثمنة؟", l2_lang: "ar" });
  expect(finding.video_s).toBeGreaterThan(0);
  expect(finding.target).toContain("WhatsApp us");
  expect(existsSync(join(dir, finding.evidence))).toBe(true);
  expect(existsSync(join(dir, "finish.json"))).toBe(true);
  expect(existsSync(join(dir, "video.webm"))).toBe(true);
  expect(existsSync(join(dir, "trace.zip"))).toBe(true);
  await client.close();
});

test("a link that redirects to production stops the run", async () => {
  const { dir, client, call, refOf } = await open();
  const look = await call("look", {});
  const r = await call("click", { ref: refOf(look.text, "See offers") }).catch((e) => ({ text: String(e) }));
  expect(r.text).toMatch(/STOPPED|closed|Connection/i);
  await Bun.sleep(1500);
  expect(JSON.parse(readFileSync(join(dir, "guard.json"), "utf8")).url).toContain("prod.example.com");
  await client.close().catch(() => {});
});

test("typing a production address stops the run", async () => {
  const { dir, client, call } = await open();
  const r = await call("goto", { url: "https://prod.example.com/" });
  expect(r.text).toContain("STOPPED");
  await Bun.sleep(1500);
  expect(existsSync(join(dir, "guard.json"))).toBe(true);
  await client.close().catch(() => {});
});

test("the runner refuses a production URL before starting anything", async () => {
  const p = Bun.spawn([process.execPath, join(import.meta.dir, "../src/run.ts"), "--url", "https://example.com"], { stderr: "pipe" });
  expect(await p.exited).toBe(2);
  expect(await new Response(p.stderr).text()).toContain("not a local dev URL");
});

test("tester processes never get an API key or a cloud-provider switch", () => {
  process.env.ANTHROPIC_API_KEY = "sk-test-not-real";
  process.env.CLAUDE_CODE_USE_BEDROCK = "1";
  process.env.UX_ADMIN = "{}"; // a tester's setting must not reach the admin agent it starts
  try {
    const env = subscriptionEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.UX_ADMIN).toBeUndefined();
    expect(env.PATH).toBeTruthy();
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.UX_ADMIN;
  }
});

test.skipIf(!Bun.which("claude"))("this machine's CLI is on a Claude subscription", () => {
  expect(subscriptionProblem()).toBeNull();
});

test.skipIf(!Bun.which("claude"))("the real tester process has no file, shell or web tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ux-test-"));
  writeFileSync(join(dir, "persona.json"), JSON.stringify(persona));
  const cfg = join(dir, "mcp.json");
  writeFileSync(cfg, JSON.stringify(mcpConfig(dir, URL0, 5, 2, { UX_APP: "test", UX_APP_DIR: APP_DIR })));
  const p = Bun.spawn(claudeArgs({ prompt: "Reply with the word ok.", system: "You are a test.", mcpConfig: cfg, model: "haiku" }), { cwd: mkdtempSync(join(tmpdir(), "ux-cwd-")), env: subscriptionEnv(), stdout: "pipe", stderr: "ignore" });
  let init: { tools: string[]; mcp_servers: { name: string; status: string }[] } | undefined;
  let buf = "";
  for await (const chunk of p.stdout.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    const line = buf.split("\n").find((l) => l.includes('"subtype":"init"'));
    if (line) {
      init = JSON.parse(line);
      break;
    }
  }
  p.kill();
  expect(init!.mcp_servers).toMatchObject([{ name: "ux", status: "connected" }]);
  console.log("tester tools:", init!.tools.join(", "));
  expect(init!.tools.length).toBeGreaterThan(0);
  expect(init!.tools.filter((t) => !t.startsWith("mcp__ux__"))).toEqual([]);
});

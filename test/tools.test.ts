// init, doctor, the MCP server and the HTML report; no model is called.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApp } from "../src/app";
import { writeHtml } from "../src/report-html";
import { serveRuns } from "../src/view";

setDefaultTimeout(60_000);
const SRC = join(import.meta.dir, "..", "src");
const bun = (args: string[]) => Bun.spawnSync([process.execPath, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

test("init writes a valid app folder from flags, and refuses a production address", () => {
  const dir = mkdtempSync(join(tmpdir(), "ux-apps-"));
  const ok = bun([join(SRC, "init.ts"), "shop-demo", "--dir", dir, "--name", "Shop Demo", "--url", "http://localhost:3000", "--prod", "https://shopdemo.com/,api.shopdemo.com", "--admin", "--yes"]);
  expect(ok.exitCode).toBe(0);
  const app = loadApp("shop-demo", join(dir, "shop-demo"));
  expect(app.config).toMatchObject({ name: "Shop Demo", url: "http://localhost:3000", prod_domains: ["shopdemo.com", "api.shopdemo.com"], team: "the Shop Demo team" });
  expect(existsSync(app.adminPersonaFile)).toBe(true);
  const bad = bun([join(SRC, "init.ts"), "x", "--dir", dir, "--url", "https://shopdemo.com", "--yes"]);
  expect(bad.exitCode).toBe(1);
  expect(bad.stderr.toString()).toContain("not a local address");
});

test("doctor --json reports each check with a status", () => {
  const r = bun([join(SRC, "doctor.ts"), "example", "--json"]);
  const out = JSON.parse(r.stdout.toString());
  expect(typeof out.ready).toBe("boolean");
  const names = out.checks.map((c: { name: string }) => c.name);
  for (const n of ["Bun", "Packages", "Browser", "Claude CLI", "App settings", "Testers"]) expect(names).toContain(n);
  expect(out.checks.every((c: { status: string }) => ["ok", "warn", "fail"].includes(c.status))).toBe(true);
});

test("the MCP server offers the run tools and refuses folders outside runs/", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(SRC, "mcp.ts")] }));
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  expect(names).toEqual(["doctor", "get_results", "list_apps", "list_testers", "start_test", "test_status"]);
  const apps = JSON.parse(((await client.callTool({ name: "list_apps", arguments: {} })) as any).content[0].text);
  expect(apps.map((a: { id: string }) => a.id)).toContain("example");
  const bad = (await client.callTool({ name: "get_results", arguments: { run_dir: "/etc" } })) as { isError?: boolean; content: { text: string }[] };
  expect(bad.isError).toBe(true);
  expect(bad.content[0].text).toContain("not a run folder");
  await client.close();
});

test("bun run view serves a run with video seeking, and nothing outside runs/", async () => {
  // A throwaway runs folder in the system temp dir: the test never touches the real runs/.
  const root = mkdtempSync(join(tmpdir(), "ux-runs-"));
  mkdirSync(join(root, "app", "r1", "ana"), { recursive: true });
  writeFileSync(join(root, "app", "r1", "report.html"), "<p>report</p>");
  writeFileSync(join(root, "app", "r1", "ana", "video.mp4"), Buffer.from("0123456789"));
  const server = serveRuns(0, root);
  const base = `http://127.0.0.1:${server.port}/app/r1`;
  try {
    expect(await (await fetch(`${base}/report.html`)).text()).toBe("<p>report</p>");
    const part = await fetch(`${base}/ana/video.mp4`, { headers: { range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await part.text()).toBe("2345");
    expect((await fetch(`http://127.0.0.1:${server.port}/..%2F..%2Fpackage.json`)).status).toBe(403);
  } finally {
    server.stop(true);
    if (root.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

test("report.html carries the run's data and a player for each finding", () => {
  const dir = mkdtempSync(join(tmpdir(), "ux-run-"));
  mkdirSync(join(dir, "ana", "shots"), { recursive: true });
  writeFileSync(join(dir, "ana", "shots", "finding-001-1.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const summary: any = { ok: true, exit: 0, app: "demo", run_dir: dir, usage_usd_estimate: 0.3, testers: [{ id: "ana", name: "Ana", profile: "low tech", goal: "Buy", goal_done: true, ended: "goal done", would_sign_up: "yes", why: "easy", steps: 9, findings: { bad_ui: 1 }, video: join(dir, "ana", "video.mp4"), stopped_by_guard: false, admin_visits: [] }], admin_visits: [] };
  const findings: any = [{ kind: "bad_ui", label: "Bad UI", persona: "ana", who: "Ana", page: "/cart", en: "The <button> is tiny", ar: "صغير", screenshot: "ana/shots/finding-001-1.jpg", video: "ana/video.webm", video_s: 42, step: 3 }];
  const file = writeHtml(dir, { app: "demo", run: "2026-10-18-0000", summary, findings, issues: [], patterns: [] });
  const html = readFileSync(file, "utf8");
  expect(html).toContain('"video_s":42');
  expect(html).toContain('"ana":"ana/video.mp4"');
  expect(html).not.toContain("The <button> is tiny"); // escaped inside the JSON block
  expect(html).toContain('"screenshot":"data:image/jpeg;base64,/9j/2Q=="'); // embedded: shows even when sent alone
});

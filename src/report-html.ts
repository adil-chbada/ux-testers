// report.html: one page for people. Testers and their verdicts, every finding as a card with its screenshot and a
// button that plays the tester's video at that moment, filters by kind and tester, and the merged top issues.
// Self-contained (no network); videos and screenshots are linked from the run folder by relative paths.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { FINDING_KINDS } from "./overlay";
import type { Finding, Summary } from "./report";

export type HtmlIssue = { title: string; severity: number; who: string[]; pages: string[]; repro: string[]; fix_idea?: string; quotes: { tester: string; kind: string; text: string; shot?: string }[] };
export type HtmlData = { app: string; run: string; summary: Summary; findings: Finding[]; issues: HtmlIssue[]; patterns: { finding: string; personas: string[] }[] };

export function writeHtml(runDir: string, d: HtmlData): string {
  const rel = (p?: string) => (p ? relative(runDir, p) : undefined);
  const videos: Record<string, string | undefined> = {};
  for (const t of d.summary.testers) videos[t.id] = rel(t.video);
  for (const a of d.summary.admin_visits) if ("video" in a) videos[a.id] = rel(a.video as string | undefined);
  // Screenshots go inside the page, so it shows them anywhere (sent alone, opened in a preview); videos stay linked.
  const inline = (p?: string) => {
    const f = p && join(runDir, p);
    return f && existsSync(f) ? `data:image/jpeg;base64,${readFileSync(f).toString("base64")}` : p;
  };
  const findings = d.findings.map((f) => ({ ...f, screenshot: inline(f.screenshot) }));
  const data = { ...d, findings, videos, kinds: FINDING_KINDS };
  const file = join(runDir, "report.html");
  writeFileSync(file, PAGE.replace("__DATA__", () => JSON.stringify(data).replace(/</g, "\\u003c")).replace(/__TITLE__/g, () => `UX test · ${esc(d.app)}`));
  return file;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--soft:#5d5d58;--line:#e4e3de;--accent:#2563eb;--ok:#15803d;--bad:#b91c1c}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecebe6;--soft:#a3a29c;--line:#34332f;--accent:#7aa2ff;--ok:#4ade80;--bad:#f87171}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,"Noto Sans",sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 60px}h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px}
.sub{color:var(--soft);margin:0 0 16px}.stats{display:flex;flex-wrap:wrap;gap:10px}.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:10px 14px}
.stat b{display:block;font-size:22px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.who{font-weight:600}.muted{color:var(--soft);font-size:13px}.badge{display:inline-block;border-radius:999px;padding:1px 9px;font-size:12px;font-weight:600;border:1px solid var(--line)}
.ok{color:var(--ok)}.bad{color:var(--bad)}button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:5px 10px}
button:hover{border-color:var(--accent)}button.play{color:var(--accent);font-weight:600}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 12px}.chip{border-radius:999px;padding:4px 12px}.chip[aria-pressed=true]{background:var(--ink);color:var(--bg)}
select{font:inherit;padding:5px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink)}
.finding{border-left:5px solid var(--k);display:grid;grid-template-columns:1fr 200px;gap:12px}@media (max-width:640px){.finding{grid-template-columns:1fr}}
.finding .label{color:var(--k);font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:.04em}
.l2{font-family:"Noto Sans Arabic","Noto Naskh Arabic","Noto Sans",sans-serif;color:var(--soft);margin-top:4px}.l2[dir=rtl]{text-align:right}
.shot{width:100%;border-radius:8px;border:1px solid var(--line);cursor:zoom-in}.list{display:grid;gap:10px}
.issue h3{margin:0 0 4px;font-size:16px}.sev{font-size:12px;font-weight:700}ol{margin:6px 0;padding-left:20px}
dialog{border:none;border-radius:14px;padding:0;background:#000;max-width:min(96vw,1000px);width:auto}dialog::backdrop{background:rgba(0,0,0,.7)}
dialog video,dialog img{display:block;max-width:min(96vw,1000px);max-height:86vh}dialog .bar{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 10px;background:#111;color:#ddd;font-size:13px}
dialog .bar button{background:#222;color:#eee;border-color:#444}.empty{color:var(--soft);padding:12px 0}
</style></head><body><main id="app"></main>
<dialog id="viewer"><div class="bar"><span id="vtitle"></span><button id="vclose">Close ✕</button></div><div id="vbody"></div></dialog>
<script id="data" type="application/json">__DATA__</script>
<script>
const D = JSON.parse(document.getElementById("data").textContent);
const $ = (h) => { const t = document.createElement("template"); t.innerHTML = h.trim(); return t.content.firstChild; };
const e = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const clock = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
const S = D.summary, app = document.getElementById("app");
const total = D.findings.length, done = S.testers.filter((t) => t.goal_done).length;
app.append($('<header><h1>' + e(D.app) + ': UX test</h1><p class="sub">' + e(D.run) + ' UTC · usage ≈ $' + S.usage_usd_estimate.toFixed(2) + ' at API prices (covered by the subscription)</p>' +
  '<div class="stats"><div class="stat"><b>' + S.testers.length + '</b>testers</div><div class="stat"><b>' + done + ' / ' + S.testers.length + '</b>reached the goal</div>' +
  '<div class="stat"><b>' + total + '</b>findings</div><div class="stat"><b>' + D.issues.length + '</b>grouped issues</div></div></header>'));

// --- viewer: video at a moment, or a screenshot ---
const dlg = document.getElementById("viewer"), body = document.getElementById("vbody");
document.getElementById("vclose").onclick = () => dlg.close();
dlg.addEventListener("close", () => (body.innerHTML = ""));
function play(id, at, title) {
  const src = D.videos[id];
  if (!src) return alert("No video for this visit.");
  body.innerHTML = "";
  const v = $('<video controls autoplay playsinline></video>');
  const webm = src.replace(/\\.mp4$/, ".webm");
  if (src.endsWith(".mp4")) v.append($('<source src="' + src + '" type="video/mp4">'));
  const last = $('<source src="' + webm + '" type="video/webm">');
  // Videos are files next to this page: opened elsewhere (sent alone, a preview), say so instead of a blank player.
  last.addEventListener("error", () => { body.innerHTML = '<p style="color:#eee;padding:24px;max-width:520px">This page cannot reach the video from here. In the ux-testers folder run <b>bun run view</b>: it opens this report with its videos in your browser.</p>'; });
  v.append(last);
  v.addEventListener("loadedmetadata", () => (v.currentTime = Math.max(0, (at || 0) - 1)), { once: true });
  body.append(v); document.getElementById("vtitle").textContent = title; dlg.showModal();
}
function zoom(src, title) { body.innerHTML = ""; body.append($('<img src="' + src + '" alt="">')); document.getElementById("vtitle").textContent = title; dlg.showModal(); }
app.addEventListener("click", (ev) => { const b = ev.target.closest("[data-play],[data-zoom]"); if (!b) return;
  if (b.dataset.play) play(b.dataset.play, Number(b.dataset.at || 0), b.dataset.title || ""); else zoom(b.dataset.zoom === "self" ? b.src : b.dataset.zoom, b.dataset.title || ""); });

// --- testers ---
const testers = $('<section><h2>Testers</h2><div class="grid"></div></section>');
for (const t of S.testers) {
  const counts = Object.entries(t.findings).map(([k, n]) => '<span class="badge" style="color:' + (D.kinds[k]?.color || "inherit") + '">' + n + ' ' + e((D.kinds[k]?.label || k).split(" · ")[0]) + '</span>').join(" ");
  const admin = t.admin_visits.length ? '<div class="muted">Asked the team ' + t.admin_visits.length + '× ' + t.admin_visits.map((a) => '<button class="play" data-play="' + e(a) + '" data-title="' + e(a) + '">▶ admin visit</button>').join(" ") + '</div>' : "";
  testers.lastChild.append($('<div class="card"><div class="who">' + e(t.name) + '</div><div class="muted">' + e(t.profile) + '</div>' +
    '<p><b class="' + (t.goal_done ? "ok" : "bad") + '">' + (t.goal_done ? "✓ Goal done" : "✗ " + e(t.ended)) + '</b><br><span class="muted">Goal: ' + e(t.goal) + '</span></p>' +
    '<p>Would sign up: <b>' + e(t.would_sign_up ?? "?") + '</b>' + (t.why ? ' — ' + e(t.why) : "") + '</p><p>' + (counts || '<span class="muted">No findings</span>') + '</p>' + admin +
    '<button class="play" data-play="' + e(t.id) + '" data-title="' + e(t.name) + '">▶ Watch the visit</button></div>'));
}
app.append(testers);

// --- findings with filters ---
const sec = $('<section><h2>Findings</h2><div class="chips"></div><div class="list"></div></section>');
const chips = sec.querySelector(".chips"), list = sec.querySelector(".list");
let kind = "all", who = "all";
const kinds = ["all", ...Object.keys(D.kinds).filter((k) => D.findings.some((f) => f.kind === k))];
for (const k of kinds) {
  const n = k === "all" ? total : D.findings.filter((f) => f.kind === k).length;
  const c = $('<button class="chip" aria-pressed="' + (k === "all") + '">' + (k === "all" ? "All" : e(D.kinds[k].label.split(" · ")[0])) + ' (' + n + ')</button>');
  if (k !== "all") c.style.borderColor = D.kinds[k].color;
  c.onclick = () => { kind = k; chips.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", x === c)); render(); };
  chips.append(c);
}
const sel = $('<select aria-label="Tester"><option value="all">All testers</option>' + [...new Set(D.findings.map((f) => f.persona))].map((p) => '<option value="' + e(p) + '">' + e(p) + '</option>').join("") + '</select>');
sel.onchange = () => { who = sel.value; render(); };
chips.append(sel);
function render() {
  list.innerHTML = "";
  const rows = D.findings.filter((f) => (kind === "all" || f.kind === kind) && (who === "all" || f.persona === who));
  if (!rows.length) list.append($('<div class="empty">Nothing here.</div>'));
  for (const f of rows) {
    const k = D.kinds[f.kind] || { color: "#64748b", label: f.kind };
    const at = f.video_s != null ? '<button class="play" data-play="' + e(f.persona) + '" data-at="' + f.video_s + '" data-title="' + e(f.who) + ' · ' + clock(f.video_s) + '">▶ Play at ' + clock(f.video_s) + '</button>' : "";
    list.append($('<div class="card finding" style="--k:' + k.color + '"><div><div class="label">' + e(f.label || k.label) + '</div>' +
      '<div class="muted">' + e(f.who) + ' · <code>' + e(f.page) + '</code>' + (f.target ? ' · ' + e(f.target) : "") + '</div>' +
      '<p style="margin:6px 0 0">' + e(f.en) + '</p>' + (f.l2 ? '<div class="l2" dir="' + (f.l2_rtl ? "rtl" : "ltr") + '">' + e(f.l2) + '</div>' : "") + '<p>' + at + '</p></div>' +
      (f.screenshot ? '<img class="shot" loading="lazy" src="' + e(f.screenshot) + '" alt="Screenshot" data-zoom="self" data-title="' + e(f.who) + '">' : "<div></div>") + '</div>'));
  }
}
render();
app.append(sec);

// --- grouped issues and patterns ---
if (D.issues.length) {
  const iss = $('<section><h2>Top issues</h2><div class="list"></div></section>');
  D.issues.forEach((i, n) => iss.lastChild.append($('<div class="card issue"><h3>' + (n + 1) + '. ' + e(i.title) + '</h3>' +
    '<div class="sev">Severity ' + i.severity + ' of 3 · hit by ' + i.who.length + ' (' + e(i.who.join(", ")) + ')</div><div class="muted">' + e(i.pages.join(", ")) + '</div>' +
    (i.repro.length ? '<ol>' + i.repro.map((r) => '<li>' + e(r) + '</li>').join("") + '</ol>' : "") + (i.fix_idea ? '<p><b>Fix idea:</b> ' + e(i.fix_idea) + '</p>' : "") + '</div>')));
  app.append(iss);
}
if (D.patterns.length) app.append($('<section><h2>Patterns</h2><ul>' + D.patterns.map((p) => '<li>' + e(p.finding) + ' <span class="muted">(' + e(p.personas.join(", ")) + ')</span></li>').join("") + '</ul></section>'));
</script></body></html>`;

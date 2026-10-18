// What the recorded video shows on top of the app, in English (and the optional second language below it):
// - __uxSay: the box at the bottom with the tester's current thought;
// - __uxChat: a chat bubble when a tester and the admin agent message each other (shown, then hidden);
// - __uxFlag: a coloured banner at the top for a finding (issue, bad UX, bad UI, smart idea…), with the element it is
//   about outlined in the same colour.
// Each layer sits in a closed shadow root outside <body>, is aria-hidden and lets clicks through; OVERLAY_HIDE_CSS
// hides them in the agent's own screenshots, so they show only in the video and in the findings' evidence shots.
import { KIND_LABELS_2 } from "./lang";

/** l2: the same text in the second language, if any; rtl: write it right-to-left. */
export type Say = { who: string; step: number; kind: string; en: string; l2?: string; rtl?: boolean };
export type Chat = { from: string; to: string; text: string; l2?: string; rtl?: boolean; dir: "out" | "in" } | null;
export type Flag = { kind: string; label: string; who: string; en: string; l2?: string; rtl?: boolean; rect?: { x: number; y: number; width: number; height: number } } | null;

/** The kinds a tester can note, with their colour and English label. */
export const FINDING_KINDS = {
  issue: { color: "#dc2626", label: "Issue" },
  bad_ux: { color: "#d97706", label: "Bad UX" },
  bad_ui: { color: "#7c3aed", label: "Bad UI" },
  idea: { color: "#0284c7", label: "Smart idea" },
  language: { color: "#4f46e5", label: "Language" },
  praise: { color: "#16a34a", label: "Praise" },
} as const;
export type FindingKind = keyof typeof FINDING_KINDS;

/** "Bad UI", or "Bad UI · واجهة ماشي مزيانة" when the second language has a label for it. */
export function kindLabel(kind: string, l2code?: string): string {
  const en = FINDING_KINDS[kind as FindingKind]?.label ?? kind;
  const second = l2code ? KIND_LABELS_2[l2code]?.[kind] : undefined;
  return second ? `${en} · ${second}` : en;
}

export const OVERLAY_HIDE_CSS = "#__ux_box,#__ux_chat,#__ux_flag,#__ux_mark{display:none!important}";

export const OVERLAY_INIT = `(() => {
  const COLORS = ${JSON.stringify(Object.fromEntries(Object.entries(FINDING_KINDS).map(([k, v]) => [k, v.color])))};
  const L2FONT = '"Noto Sans Arabic","Noto Naskh Arabic","Noto Sans",sans-serif';
  const roots = {};
  // One fixed, click-through, aria-hidden layer per id; recreated if the page replaced it.
  const layer = (id, css, html) => {
    let host = document.getElementById(id);
    if (!host || !roots[id]) {
      host?.remove();
      host = document.createElement("div");
      host.id = id;
      host.setAttribute("aria-hidden", "true");
      host.style.cssText = "all:initial;position:fixed;z-index:2147483647;pointer-events:none;" + css;
      roots[id] = host.attachShadow({ mode: "closed" });
      roots[id].innerHTML = html;
      document.documentElement.appendChild(host);
    }
    return { host, root: roots[id] };
  };
  // The optional second-language line: shown only when there is text, right-to-left when needed.
  const second = (el, text, rtl) => {
    el.textContent = text || "";
    el.style.display = text ? "block" : "none";
    el.dir = rtl ? "rtl" : "ltr";
    el.style.textAlign = rtl ? "right" : "left";
  };

  window.__uxSay = (s) => {
    if (!document.documentElement) return;
    const { root } = layer("__ux_box", "left:0;right:0;bottom:8px;display:flex;justify-content:center", '<style>' +
      '.b{width:min(760px,calc(100vw - 16px));box-sizing:border-box;font:13px/1.45 system-ui,"Noto Sans",sans-serif;color:#fff;background:rgba(15,23,42,.9);border-left:4px solid var(--c,#94a3b8);border-radius:10px;padding:8px 10px;max-height:36vh;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.35)}' +
      '.h{font-size:11px;opacity:.75;margin-bottom:3px;letter-spacing:.03em}p{margin:0}' +
      '.l2{font-family:' + L2FONT + ';font-size:14px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.2)}' +
      '</style><div class="b"><div class="h"></div><p class="en" dir="ltr" lang="en"></p><p class="l2"></p></div>');
    root.querySelector(".b").style.setProperty("--c", COLORS[s.kind] || "#94a3b8");
    root.querySelector(".h").textContent = s.who + " · step " + s.step + " · " + s.kind;
    root.querySelector(".en").textContent = s.en;
    second(root.querySelector(".l2"), s.l2, s.rtl);
  };

  window.__uxChat = (c) => {
    if (!document.documentElement) return;
    const { host, root } = layer("__ux_chat", "top:12px;left:0;right:0;display:flex;justify-content:center", '<style>' +
      '.w{width:min(420px,calc(100vw - 24px));font:14px/1.45 system-ui,"Noto Sans",sans-serif;background:#efeae2;border-radius:14px;padding:8px;box-shadow:0 8px 28px rgba(0,0,0,.35)}' +
      '.t{font-size:12px;font-weight:600;color:#075e54;margin:0 4px 6px}' +
      '.m{max-width:85%;padding:7px 10px;border-radius:10px;color:#111;white-space:pre-wrap;word-break:break-word}' +
      '.out{margin-left:auto;background:#d9fdd3}.in{margin-right:auto;background:#fff}' +
      '.l2{font-family:' + L2FONT + ';margin-top:4px;padding-top:4px;border-top:1px solid rgba(0,0,0,.1)}' +
      '</style><div class="w"><div class="t"></div><div class="m"><div class="en" dir="auto"></div><div class="l2"></div></div></div>');
    host.style.display = c ? "flex" : "none";
    if (!c) return;
    root.querySelector(".t").textContent = "💬 " + c.from + " → " + c.to;
    root.querySelector(".m").className = "m " + c.dir;
    root.querySelector(".en").textContent = c.text;
    second(root.querySelector(".l2"), c.l2, c.rtl);
  };

  window.__uxFlag = (f) => {
    if (!document.documentElement) return;
    const { host, root } = layer("__ux_flag", "top:0;left:0;right:0;display:flex;justify-content:center", '<style>' +
      '.f{width:min(820px,100vw);box-sizing:border-box;font:14px/1.45 system-ui,"Noto Sans",sans-serif;color:#fff;background:var(--c);padding:10px 14px;border-radius:0 0 12px 12px;box-shadow:0 6px 24px rgba(0,0,0,.4)}' +
      '.k{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}p{margin:0}' +
      '.l2{font-family:' + L2FONT + ';font-size:15px;margin-top:5px;padding-top:5px;border-top:1px solid rgba(255,255,255,.35)}' +
      '</style><div class="f"><div class="k"></div><p class="en" dir="ltr" lang="en"></p><p class="l2"></p></div>');
    const mark = layer("__ux_mark", "", "").host;
    host.style.display = f ? "flex" : "none";
    mark.style.display = f && f.rect ? "block" : "none";
    if (!f) return;
    const color = COLORS[f.kind] || "#475569";
    root.querySelector(".f").style.setProperty("--c", color);
    root.querySelector(".k").textContent = f.label + " — " + f.who;
    root.querySelector(".en").textContent = f.en;
    second(root.querySelector(".l2"), f.l2, f.rtl);
    if (f.rect) {
      const r = f.rect;
      mark.style.cssText += ";left:" + (r.x - 4) + "px;top:" + (r.y - 4) + "px;width:" + (r.width + 8) + "px;height:" + (r.height + 8) + "px;" +
        "border:3px solid " + color + ";border-radius:8px;box-shadow:0 0 0 4px " + color + "55;box-sizing:border-box";
    }
  };
})()`;

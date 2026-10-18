#!/usr/bin/env bun
// Opens a run's report.html with its videos playable in any browser (also in app previews that cannot open the
// files next to a local page): serves the runs/ folder on this machine only, with video seeking.
//   bun run view                       the newest run
//   bun run view runs/my-app/<run>     a given run        [--port 4300] [--no-open]
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { ROOT } from "./app";

const RUNS = join(ROOT, "runs");

/** The newest run folder (one that has a report), or undefined. */
export function newestRun(): string | undefined {
  if (!existsSync(RUNS)) return;
  const runs = readdirSync(RUNS, { withFileTypes: true })
    .filter((a) => a.isDirectory() && !a.name.startsWith("_"))
    .flatMap((a) => readdirSync(join(RUNS, a.name)).map((r) => join(RUNS, a.name, r)))
    .filter((d) => existsSync(join(d, "report.html")));
  return runs.sort((x, y) => statSync(y).mtimeMs - statSync(x).mtimeMs)[0];
}

const TYPES: Record<string, string> = { html: "text/html; charset=utf-8", mp4: "video/mp4", webm: "video/webm", jpg: "image/jpeg", png: "image/png", md: "text/markdown; charset=utf-8", json: "application/json", jsonl: "application/json", zip: "application/zip" };

/** Serves a runs folder (runs/ by default) on 127.0.0.1 only; Range requests let the player jump to a finding's second. */
export function serveRuns(port = 0, root = RUNS) {
  return Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(req) {
      const path = decodeURIComponent(new URL(req.url).pathname);
      const file = resolve(root, "." + path);
      if (file !== root && !file.startsWith(root + sep)) return new Response("Forbidden", { status: 403 });
      if (!existsSync(file) || statSync(file).isDirectory()) return new Response("Not found", { status: 404 });
      const f = Bun.file(file);
      const type = TYPES[file.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";
      const range = req.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/);
      if (!range) return new Response(f, { headers: { "content-type": type, "accept-ranges": "bytes" } });
      const size = f.size;
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${size}` } });
      return new Response(f.slice(start, end + 1), {
        status: 206,
        headers: { "content-type": type, "accept-ranges": "bytes", "content-range": `bytes ${start}-${end}/${size}`, "content-length": String(end - start + 1) },
      });
    },
  });
}

if (import.meta.main) {
  const { values: o, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: "string", default: "0" }, "no-open": { type: "boolean", default: false } } });
  const run = positionals[0] ? resolve(positionals[0]) : newestRun();
  if (!run || !existsSync(join(run, "report.html"))) {
    console.error(run ? `No report.html in ${run}.` : "No run with a report yet: run bun run ux <app> first.");
    process.exit(1);
  }
  if (!run.startsWith(RUNS + sep)) {
    console.error(`${run} is not inside ${RUNS}.`);
    process.exit(1);
  }
  const server = serveRuns(Number(o.port));
  const url = `http://127.0.0.1:${server.port}/${relative(RUNS, run).split(sep).map(encodeURIComponent).join("/")}/report.html`;
  console.log(`Report with videos: ${url}\n(only on this computer; press Ctrl+C to stop)`);
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  if (!o["no-open"] && Bun.which(opener)) Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
}

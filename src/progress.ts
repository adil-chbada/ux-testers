// How a run is going, read from its folder: used by the live progress in run.ts and by the MCP server's test_status.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).length : 0);

export type TesterProgress = { id: string; steps: number; findings: number; state: "starting" | "working" | "waiting for the admin" | "goal done" | "gave up" | "stopped (production site)" };

export function testerProgress(runDir: string, id: string): TesterProgress {
  const d = join(runDir, id);
  const steps = lines(join(d, "steps.jsonl"));
  const findings = lines(join(d, "notes.jsonl"));
  if (existsSync(join(d, "guard.json"))) return { id, steps, findings, state: "stopped (production site)" };
  if (existsSync(join(d, "finish.json"))) {
    const done = JSON.parse(readFileSync(join(d, "finish.json"), "utf8")).goal_done;
    return { id, steps, findings, state: done ? "goal done" : "gave up" };
  }
  const waiting =
    existsSync(runDir) && readdirSync(runDir).some((x) => x.startsWith(`${id}-admin-`) && !existsSync(join(runDir, x, "reply.json")) && !existsSync(join(runDir, x, "meta.json")));
  return { id, steps, findings, state: waiting ? "waiting for the admin" : steps ? "working" : "starting" };
}

/** Every tester of a run (admin visits excluded), and whether the run has finished (summary.json written). */
export function runProgress(runDir: string) {
  const ids = existsSync(runDir)
    ? readdirSync(runDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !/-admin-\d+$/.test(e.name) && existsSync(join(runDir, e.name, "persona.json")))
        .map((e) => e.name)
    : [];
  return { finished: existsSync(join(runDir, "summary.json")), testers: ids.map((id) => testerProgress(runDir, id)) };
}

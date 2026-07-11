import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { FocusTask } from "./types.js";

const execFileAsync = promisify(execFile);

// Set LEDGER_BIN to the path of the built ledger CLI, or leave unset to disable
// project-list features (the service still works; /projects returns []).
// Read lazily (not cached in a module-level const): this module is imported by
// server.ts before server.ts's own process.loadEnvFile() call runs (ES module
// imports always execute before the importing file's top-level code, regardless
// of where in that file the loadEnvFile() call appears), so a const evaluated at
// import time would permanently miss a LEDGER_BIN set via .env.
function ledgerBin(): string {
  return process.env.LEDGER_BIN ?? "";
}

/** Subset of the `ledger status --json` project shape we use. */
interface LedgerProject {
  id: string;
  name: string;
  lastTouched?: string;
  lastTouchReason?: string;
  nextAction?: string;
  statusNote?: string;
}

export async function fetchProjects(): Promise<LedgerProject[]> {
  const bin = ledgerBin();
  if (!bin) return [];
  const { stdout } = await execFileAsync(bin, ["status", "--json"], {
    maxBuffer: 10 * 1024 * 1024,
  });
  const data: unknown = JSON.parse(stdout);
  return Array.isArray(data) ? (data as LedgerProject[]) : [];
}

/**
 * Most-recently-touched project. Ledger has NO "active"/"current" project state — "active"
 * there only means "not archived". So this is an explicit heuristic (opt in with --last),
 * never a silent default: for a focus session you should choose what you're focusing on.
 */
function pickMostRecent(projects: LedgerProject[]): LedgerProject | undefined {
  if (projects.length === 0) return undefined;
  return [...projects].sort((a, b) => {
    const ta = a.lastTouched ? Date.parse(a.lastTouched) : 0;
    const tb = b.lastTouched ? Date.parse(b.lastTouched) : 0;
    return tb - ta;
  })[0];
}

function formatProjectList(projects: LedgerProject[]): string {
  if (projects.length === 0) return "  (no projects found)";
  return projects
    .map((p) => `  ${p.id}  ${p.name}${p.nextAction?.trim() ? `  — ${p.nextAction.trim()}` : ""}`)
    .join("\n");
}

/** Default focus task from the active project's Next Action (the keystone integration). */
function taskFromProject(p: LedgerProject): FocusTask {
  if (p.nextAction?.trim()) {
    return {
      task: p.nextAction.trim(),
      source: "next-action",
      projectId: p.id,
      projectName: p.name,
    };
  }
  if (p.statusNote?.trim()) {
    return {
      task: `${p.name}: ${p.statusNote.trim()}`,
      source: "status-note",
      projectId: p.id,
      projectName: p.name,
    };
  }
  return { task: p.name, source: "project-name", projectId: p.id, projectName: p.name };
}

/**
 * Resolve the focus task. You must say what you're focusing on — there is no implicit
 * "active project" to fall back on. Precedence:
 *   explicit (--task)  →  a specific project (--project <id>)  →  --last (most recently touched).
 * With none of those, throws with the project list so you can choose.
 */
export async function resolveFocusTask(opts: {
  explicit?: string;
  projectId?: string;
  last?: boolean;
}): Promise<FocusTask> {
  if (opts.explicit?.trim()) {
    return { task: opts.explicit.trim(), source: "explicit" };
  }

  if (opts.projectId) {
    const projects = await fetchProjects();
    const project = projects.find((p) => p.id === opts.projectId);
    if (!project) {
      throw new Error(
        `No Ledger project with id "${opts.projectId}". Projects:\n${formatProjectList(projects)}`,
      );
    }
    return taskFromProject(project);
  }

  if (opts.last) {
    const project = pickMostRecent(await fetchProjects());
    if (!project) throw new Error("No Ledger projects found — pass --task \"...\" instead.");
    return taskFromProject(project);
  }

  const projects = await fetchProjects();
  throw new Error(
    "No focus task selected. Choose how to anchor this session:\n" +
      '  --task "..."     free-typed focus (for ad-hoc / untracked work)\n' +
      "  --project <id>   a tracked Ledger project (see below)\n" +
      "  --last           the most recently touched project\n\n" +
      `Projects:\n${formatProjectList(projects)}`,
  );
}

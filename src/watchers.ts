import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchProjects } from "./ledger.js";
import type { StopCondition, WorkBlock } from "./types.js";

const execFileAsync = promisify(execFile);
const execAsync = promisify(exec);

// The watcher subsystem (Epic B1): one evaluator per stop-condition on the ACTIVE block. Every
// evaluator obeys the same rules (design Appendix A):
//   - capture a BASELINE when the block activates (arm);
//   - report met only on an unambiguous FORWARD change from that baseline;
//   - on any error return false — fail open, never falsely complete;
//   - once met, stay met (a flapping signal can't un-complete a block).

export interface Evaluator {
  arm(block: WorkBlock, cond: StopCondition): Promise<void>;
  poll(): Promise<boolean>;
}

const GIT_TIMEOUT_MS = 10_000;

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

class GitEvaluator implements Evaluator {
  private cond!: Extract<StopCondition, { type: "git" }>;
  private baselineSha: string | null = null;
  private armedAt = "";
  private met = false;

  async arm(_block: WorkBlock, cond: StopCondition): Promise<void> {
    this.cond = cond as Extract<StopCondition, { type: "git" }>;
    this.armedAt = new Date().toISOString();
    this.met = false;
    if (this.cond.predicate.kind === "head-advanced") {
      try {
        this.baselineSha = await git(this.cond.repoPath, [
          "rev-parse",
          this.cond.predicate.ref ?? "origin/main",
        ]);
      } catch {
        this.baselineSha = null; // broken repo/ref → baseline unknown → can never fire (fail-open)
      }
    }
  }

  async poll(): Promise<boolean> {
    if (this.met) return true;
    try {
      const p = this.cond.predicate;
      if (p.kind === "head-advanced") {
        if (this.baselineSha == null) return false; // no baseline — refuse to guess
        const sha = await git(this.cond.repoPath, ["rev-parse", p.ref ?? "origin/main"]);
        this.met = sha !== this.baselineSha;
      } else if (p.kind === "merge-commit") {
        const out = await git(this.cond.repoPath, [
          "log",
          "--merges",
          `--since=${this.armedAt}`,
          "--format=%H",
          p.intoRef,
        ]);
        this.met = out.length > 0;
      } else if (p.kind === "message-match") {
        const out = await git(this.cond.repoPath, [
          "log",
          `--since=${this.armedAt}`,
          "--format=%s",
        ]);
        const re = new RegExp(p.regex);
        this.met = out.split("\n").some((s) => re.test(s));
      }
    } catch {
      return this.met; // evaluator error → no change (fail-open)
    }
    return this.met;
  }
}

class LedgerEvaluator implements Evaluator {
  private cond!: Extract<StopCondition, { type: "ledger" }>;
  private baseline: string | null = null;
  private met = false;

  async arm(_block: WorkBlock, cond: StopCondition): Promise<void> {
    this.cond = cond as Extract<StopCondition, { type: "ledger" }>;
    this.met = false;
    if (this.cond.from != null) {
      this.baseline = this.cond.from;
      return;
    }
    try {
      const project = (await fetchProjects()).find((p) => p.id === this.cond.projectId);
      this.baseline = project?.nextAction ?? null;
    } catch {
      this.baseline = null;
    }
  }

  async poll(): Promise<boolean> {
    if (this.met) return true;
    if (this.baseline == null) return false; // couldn't establish a baseline → never fire
    try {
      const project = (await fetchProjects()).find((p) => p.id === this.cond.projectId);
      // Advancing the project in Ledger IS the completion signal (keystone property).
      if (project && project.nextAction != null && project.nextAction !== this.baseline) {
        this.met = true;
      }
    } catch {
      return this.met;
    }
    return this.met;
  }
}

class CommandEvaluator implements Evaluator {
  private cond!: Extract<StopCondition, { type: "command" }>;
  private met = false;

  async arm(_block: WorkBlock, cond: StopCondition): Promise<void> {
    this.cond = cond as Extract<StopCondition, { type: "command" }>;
    this.met = false;
  }

  async poll(): Promise<boolean> {
    if (this.met) return true;
    // Runs an arbitrary shell — a foot-gun by design, so it is OFF unless explicitly enabled.
    if (!process.env.BRICK_ALLOW_COMMAND_CONDITIONS) return false;
    const expect = this.cond.expectExit ?? 0;
    try {
      await execAsync(this.cond.cmd, {
        cwd: this.cond.cwd,
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      });
      this.met = expect === 0;
    } catch (e) {
      const code = (e as { code?: number }).code;
      this.met = typeof code === "number" && code === expect;
    }
    return this.met;
  }
}

/** Manual conditions have no poller — `met` flips via POST /plan/block/complete. */
class ManualEvaluator implements Evaluator {
  private cond!: StopCondition;
  async arm(_block: WorkBlock, cond: StopCondition): Promise<void> {
    this.cond = cond;
  }
  async poll(): Promise<boolean> {
    return this.cond.met === true;
  }
}

export function makeEvaluator(cond: StopCondition): Evaluator {
  switch (cond.type) {
    case "git":
      return new GitEvaluator();
    case "ledger":
      return new LedgerEvaluator();
    case "command":
      return new CommandEvaluator();
    case "manual":
      return new ManualEvaluator();
  }
}

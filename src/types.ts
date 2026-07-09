// `ask` (Epic 0.1) is a third outcome: the focus is too vague to judge the page against, so brick
// routes to the clarify overlay instead of hard-blocking — distinct from a confident `block`.
export type Decision = "allow" | "block" | "ask";

/** The raw verdict the model produces. */
export interface Verdict {
  decision: Decision;
  reason: string;
  /** 0.0–1.0 certainty in the decision. */
  confidence: number;
}

/** Where the focus task came from. */
export type FocusSource =
  | "next-action" // the active Ledger project's Next Action (the keystone)
  | "status-note" // fell back to the project's status note
  | "project-name" // fell back to just the project name
  | "explicit"; // user passed --task

export interface FocusTask {
  task: string;
  source: FocusSource;
  projectId?: string;
  projectName?: string;
}

export interface AdjudicationInput {
  focus: FocusTask;
  url: string;
  title?: string;
  /** Optional project context from the Memory Hub (Phase-2 fast-follow grounding). */
  grounding?: string;
  /** Per-request model override (R2 — configurable from the options page). Falls back to
   *  BRICK_MODEL, then the active provider's default. */
  model?: string;
}

export interface AdjudicationResult extends Verdict {
  focus: FocusTask;
  url: string;
  title?: string;
  model: string;
  latencyMs: number;
  /** True if a low-confidence block was downgraded to allow (conservative-allow). */
  downgraded: boolean;
  /** True when the allow is a FAIL-OPEN from a provider/network error, not a model verdict —
   *  callers must not treat it as a judged allow (review fix: outage observability). */
  providerError?: boolean;
}

// ---------- Workload / day-plan layer (Epic A) ----------
// Ledger-native in shape (see WORKLOAD_DESIGN.md §3/§7): the local JSON store mirrors the eventual
// Ledger object exactly, so Epic D is a backend swap, not a schema migration.

export interface Step {
  id: string;
  label: string;
  done: boolean;
}

export type GitPredicate =
  | { kind: "head-advanced"; ref?: string } // e.g. origin/main moved
  | { kind: "merge-commit"; intoRef: string } // a merge landed on <ref>
  | { kind: "message-match"; regex: string }; // commit subject matches

/** Structural only in Epic A — evaluators arrive with Epic B. `manual` is always available. */
export type StopCondition =
  | { type: "git"; repoPath: string; predicate: GitPredicate; met: boolean; metAt?: string }
  | {
      type: "ledger";
      projectId: string;
      on: "next-action-change";
      from?: string;
      met: boolean;
      metAt?: string;
    }
  | { type: "command"; cmd: string; cwd?: string; expectExit?: number; met: boolean; metAt?: string }
  | { type: "manual"; met: boolean; metAt?: string };

export interface RepeatSpec {
  mode: "requeue"; // on complete, drop a fresh copy at the queue tail
  maxPerDay?: number; // safety cap on total spawned copies
}

/** What actually advances the queue (§12). Behavior lands in Epic B; Epic A stores the field. */
export type SwapMode = "condition" | "time" | "first" | "both";

export type BlockStatus = "pending" | "active" | "done" | "skipped";

export interface WorkBlock {
  id: string;
  focus: FocusTask; // REUSED — ties to a Ledger project or an explicit task
  budgetMinutes?: number; // attention allocation; advisory in Epic A
  stopConditions?: StopCondition[];
  completionPolicy?: "any" | "all"; // when >1 condition (default "any")
  steps?: Step[]; // optional intra-block checklist
  repeat?: RepeatSpec;
  swapMode?: SwapMode; // default derived: both present → "first"; else the one present
  /** Per-block override of the global advance-mode setting (§8.1). */
  advanceMode?: "auto" | "manual";
  /** Set when a swap trigger fired but the queue is waiting for your tap (manual mode, or a
   *  time-driven nudge, or after an undo). The popup's "advance now" lights up on it. */
  ready?: boolean;
  /** PERSISTED per-trigger dedup (review fix): the condition trigger fired (auto-advanced, went
   *  manual-ready, or was held by an undo) — it won't fire again for this block instance. */
  conditionFiredAt?: string;
  /** PERSISTED: the time (budget) trigger fired its nudge. Independent of the condition trigger,
   *  so a budget expiry never disarms a later "done when I push". */
  timeFiredAt?: string;
  status: BlockStatus;
  startedAt?: string;
  completedAt?: string;
  actualMinutes?: number; // measured, for end-of-day review
}

export interface WorkloadPlan {
  id: string; // e.g. plan_<ts>
  label?: string; // "Sunday", "deep-work AM", …
  blocks: WorkBlock[]; // ORDERED; the queue
  activeBlockId?: string;
  createdAt: string;
  /** Pomodoro settings for the plan's sessions — persisted so a restart re-anchors correctly. */
  pomodoro?: { workMinutes?: number; breakMinutes?: number };
}

// ---------- Workflow templates (Epic T) ----------
// A saved, parameterized plan skeleton — "alternate X and Y in 2h blocks until end of day" — that
// expands into a concrete WorkloadPlan at launch by binding slots to projects/tasks (§13).

export interface Slot {
  key: string; // "A", "B", …
  label: string; // human name shown at binding time
  defaultProjectId?: string;
}

export type FocusRef = { slot: string } | { projectId: string } | { task: string };

/** A block skeleton. DIVERGENCE from the design's strict Omit<WorkBlock,…>: `steps` are stored as
 *  labels (fresh Step objects are minted per expansion) — a template never carries done-state. */
export interface TemplateBlock {
  focusRef: FocusRef;
  budgetMinutes?: number;
  steps?: string[];
  repeat?: RepeatSpec;
  swapMode?: SwapMode;
  stopConditions?: StopCondition[]; // carried through save/relaunch; met flags reset per expansion
  advanceMode?: "auto" | "manual";
  completionPolicy?: "any" | "all";
  onActivate?: { bunch?: string }; // integration seam with Bunch — stored, not yet acted on
}

export interface WorkflowTemplate {
  id: string;
  name: string; // "alternating deep work"
  slots?: Slot[]; // named placeholders bound at launch; zero slots = pre-bound
  blocks: TemplateBlock[]; // the ordered pattern (may reference slots)
  pattern?: { repeat: number | "until-end-of-day" };
  createdAt: string;
}

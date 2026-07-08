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
}

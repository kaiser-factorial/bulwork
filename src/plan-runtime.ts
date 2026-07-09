import { randomUUID } from "node:crypto";
import { loadSettings } from "./config-store.js";
import { LocalPlanStore, advancePlan } from "./plan-store.js";
import type { PlanStore } from "./plan-store.js";
import { endSession, startSession } from "./session.js";
import { makeEvaluator } from "./watchers.js";
import type { Evaluator } from "./watchers.js";
import type { FocusTask, Step, SwapMode, WorkBlock, WorkloadPlan } from "./types.js";

// PlanRuntime (Epic A3): owns the queue; the ACTIVE BLOCK delegates to the existing single-focus
// FocusSession — so the adjudicator, tiers, learned decisions, and Pomodoro all keep working
// unchanged, anchored to whichever block is live. Budgets are advisory in Epic A (reported, never
// enforced); swap policy/watchers arrive with Epic B.

/** Budget escalation (Epic C1, §6): T-minus heads-up → T-0 nudge → grace re-nudge. Never a wall —
 *  levels drive notifications, the queue still only moves per the swap policy. */
export type EscalationLevel = "none" | "t-minus" | "t-0" | "grace";

const TMINUS_MIN = Number(process.env.BRICK_TMINUS_MIN ?? "5"); // heads-up this long before budget end
const GRACE_MIN = Number(process.env.BRICK_GRACE_MIN ?? "5"); // T-0 → grace re-nudge after this long over

export function escalationFor(elapsedMinutes: number, budgetMinutes?: number): EscalationLevel {
  if (budgetMinutes == null) return "none";
  const remaining = budgetMinutes - elapsedMinutes;
  if (remaining > TMINUS_MIN) return "none";
  if (remaining > 0) return "t-minus";
  if (elapsedMinutes < budgetMinutes + GRACE_MIN) return "t-0";
  return "grace";
}

export interface PlanView extends WorkloadPlan {
  stateVersion: number;
  /** Advisory budget readout for the active block (Epic A): elapsed vs budget, minutes. */
  active?: {
    blockId: string;
    elapsedMinutes: number;
    budgetMinutes?: number;
    remainingMinutes?: number;
    overBudget: boolean;
    /** Escalation level for the active block's budget (Epic C1). */
    escalation: EscalationLevel;
  };
  /** Present while an auto-advance can still be reverted (Epic B3). */
  undo?: { fromBlockId: string; availableUntil: string };
}

// ---------- swap policy (Epic B2, §12) ----------

/** PURE combinator: what actually advances the queue, given the two booleans. */
export function decideSwap(mode: SwapMode, conditionMet: boolean, timeUp: boolean): boolean {
  switch (mode) {
    case "condition":
      return conditionMet;
    case "time":
      return timeUp;
    case "first":
      return conditionMet || timeUp;
    case "both":
      return conditionMet && timeUp;
  }
}

/** Default mode when the block doesn't say (§12): condition-preferred, time as a backstop. */
export function deriveSwapMode(block: WorkBlock): SwapMode {
  if (block.swapMode) return block.swapMode;
  const hasConds = Boolean(block.stopConditions?.length || block.steps?.length);
  const hasBudget = block.budgetMinutes != null;
  if (hasConds && hasBudget) return "first";
  if (hasBudget) return "time";
  return "condition"; // conditions only — or neither, in which case nothing ever auto-fires
}

/** Completion per Appendix A: stepsGate && policy(conditions). Neither present → never. */
export function conditionsSatisfied(block: WorkBlock): boolean {
  const steps = block.steps ?? [];
  const conds = block.stopConditions ?? [];
  if (!steps.length && !conds.length) return false;
  const stepsGate = steps.every((s) => s.done);
  if (!conds.length) return stepsGate;
  const policy = block.completionPolicy ?? "any";
  const condsMet = policy === "all" ? conds.every((c) => c.met) : conds.some((c) => c.met);
  return stepsGate && condsMet;
}

export interface StartBlockInput {
  focus: FocusTask;
  budgetMinutes?: number;
  steps?: string[]; // labels; ids are assigned
  repeat?: WorkBlock["repeat"];
  swapMode?: WorkBlock["swapMode"];
  stopConditions?: WorkBlock["stopConditions"]; // Epic B — met flags are forced false at start
  advanceMode?: WorkBlock["advanceMode"]; // per-block override (§8.1)
  completionPolicy?: WorkBlock["completionPolicy"]; // any|all over multiple conditions
}

/** ONE block constructor for every creation path (startPlan, insert, from-template) — review fix:
 *  the insert path had drifted and silently dropped stopConditions/advanceMode. */
function mintBlock(input: StartBlockInput, id: string, status: WorkBlock["status"]): WorkBlock {
  return {
    id,
    focus: input.focus,
    budgetMinutes: input.budgetMinutes,
    steps: (input.steps ?? []).map((label, j) => ({ id: `step_${j}`, label, done: false })),
    repeat: input.repeat,
    swapMode: input.swapMode,
    stopConditions: input.stopConditions?.map((c) => ({ ...c, met: false, metAt: undefined })),
    advanceMode: input.advanceMode,
    completionPolicy: input.completionPolicy,
    status,
    startedAt: status === "active" ? new Date().toISOString() : undefined,
  };
}

let store: PlanStore = new LocalPlanStore();
let current: WorkloadPlan | null = null;
let stateVersion = 0; // monotonic per process; bumps on every plan mutation
let pomodoro: { workMinutes?: number; breakMinutes?: number } = {};

// ---------- watcher loop state (Epic B1/B3) ----------
const WATCH_INTERVAL_MS = Math.max(100, Number(process.env.BRICK_WATCH_INTERVAL_MS ?? "30000"));
let evaluators: Array<{ index: number; ev: Evaluator }> = []; // for the active block's conditions
let watchTimer: NodeJS.Timeout | null = null;
let tickInFlight = false;
// Swap-fire dedup is PERSISTED on the block (conditionFiredAt / timeFiredAt) — review fix: the old
// in-memory Set both disarmed the condition trigger after a mere time-nudge and evaporated on
// restart, letting an undone block auto-re-advance.
let undoState: { snapshot: WorkloadPlan; fromBlockId: string; deadline: number } | null = null;

async function armWatchers(block: WorkBlock): Promise<void> {
  evaluators = [];
  for (const [index, cond] of (block.stopConditions ?? []).entries()) {
    const ev = makeEvaluator(cond);
    try {
      await ev.arm(block, cond);
    } catch {
      /* arm failure → the evaluator simply never fires (fail-open) */
    }
    evaluators.push({ index, ev });
  }
  ensureLoop();
}

function ensureLoop(): void {
  if (watchTimer || !current?.activeBlockId) return;
  watchTimer = setInterval(() => {
    void watchTick();
  }, WATCH_INTERVAL_MS);
  watchTimer.unref(); // never keep the process alive just to watch
}

function stopLoop(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
  evaluators = [];
}

async function watchTick(): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const block = activeBlock();
    if (!current || !block) {
      stopLoop();
      return;
    }

    // Expire a lapsed undo window (the advance is committed).
    if (undoState && Date.now() > undoState.deadline) undoState = null;

    // Escalation clock (C1): bump stateVersion when the level transitions.
    checkEscalationTransition(block);

    // Poll the active block's evaluators; sync met flags into the plan (persist on change).
    let changed = false;
    for (const { index, ev } of evaluators) {
      const cond = block.stopConditions?.[index];
      if (!cond || cond.met) continue;
      let met = false;
      try {
        met = await ev.poll();
      } catch {
        met = false; // fail-open
      }
      if (met) {
        cond.met = true;
        cond.metAt = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) {
      bump();
      await persist();
    }

    // Swap decision (B2) + how it lands (B3). Dedup is PER TRIGGER and persisted: a time nudge
    // must never disarm a later condition fire, and a fired/held trigger survives restarts.
    const conditionMet = conditionsSatisfied(block);
    const elapsed = block.startedAt
      ? (Date.now() - new Date(block.startedAt).getTime()) / 60000
      : 0;
    const timeUp = block.budgetMinutes != null && elapsed >= block.budgetMinutes;
    const mode = deriveSwapMode(block);

    // Condition trigger — live in condition/first/both modes, once per block instance.
    const conditionFires =
      !block.conditionFiredAt &&
      mode !== "time" &&
      decideSwap(mode, conditionMet, timeUp) &&
      conditionMet &&
      (mode !== "both" || timeUp);
    if (conditionFires) {
      block.conditionFiredAt = new Date().toISOString();
      const settings = await loadSettings();
      const effective = block.advanceMode ?? settings.advanceMode ?? "auto";
      if (effective === "auto") {
        // Auto-advance with an undo window. The snapshot is taken AFTER stamping the fire flag,
        // so an undo restores a block whose condition trigger is already consumed — the hold now
        // survives restarts (the flag is persisted with the plan).
        const windowSec = settings.undoWindowSec ?? 30;
        await persist();
        const snapshot = JSON.parse(JSON.stringify(current)) as WorkloadPlan;
        const fromBlockId = block.id;
        await advanceBlock(block.id, "done");
        undoState = { snapshot, fromBlockId, deadline: Date.now() + windowSec * 1000 };
        bump();
        return;
      }
      // Manual: mark ready, light up "advance now" — nothing moves until the tap.
      block.ready = true;
      bump();
      await persist();
      return;
    }

    // Time trigger (§12): the clock running out is expected — nudge, never silently flip.
    // Independent of the condition trigger; Epic C layers the escalation sequence on the flag.
    if (timeUp && !block.timeFiredAt && (mode === "time" || mode === "first")) {
      block.timeFiredAt = new Date().toISOString();
      block.ready = true;
      bump();
      await persist();
    }
  } finally {
    tickInFlight = false;
  }
}

/** Revert the last auto-advance within its undo window (Epic B3). The restored block is marked
 *  `ready` and won't auto-fire again — you said "not done", so the queue waits for your tap. The
 *  hold is PERSISTED: the snapshot was taken after `conditionFiredAt` was stamped, so it survives
 *  service restarts (review fix). */
export async function undoAdvance(): Promise<PlanView | null> {
  if (!undoState || Date.now() > undoState.deadline) {
    undoState = null;
    throw new Error("nothing to undo (no auto-advance within the undo window)");
  }
  const { snapshot, fromBlockId } = undoState;
  undoState = null;
  current = snapshot;
  const block = current.blocks.find((b) => b.id === fromBlockId);
  if (block) {
    block.ready = true; // advance stays one tap away; conditionFiredAt already set in the snapshot
  }
  bump();
  await persist();
  if (block) {
    await anchorSession(block);
    await armWatchers(block);
  }
  return planView();
}

/** Swap the backing store (Epic D drops in a LedgerPlanStore here). */
export function usePlanStore(s: PlanStore): void {
  store = s;
}

const bump = (): void => {
  stateVersion += 1;
};

async function persist(): Promise<void> {
  if (current) await store.save(current);
}

/** Anchor the single-focus session to a block (start/advance both come through here). */
async function anchorSession(block: WorkBlock): Promise<void> {
  await endSession(); // no-op when nothing is running
  await startSession({ focus: block.focus, ...pomodoro });
}

export function getPlan(): WorkloadPlan | null {
  return current;
}

export function activeBlock(): WorkBlock | null {
  if (!current?.activeBlockId) return null;
  return current.blocks.find((b) => b.id === current!.activeBlockId) ?? null;
}

export function planView(): PlanView | null {
  if (!current) return null;
  const view: PlanView = { ...current, stateVersion };
  if (undoState && Date.now() <= undoState.deadline) {
    view.undo = {
      fromBlockId: undoState.fromBlockId,
      availableUntil: new Date(undoState.deadline).toISOString(),
    };
  }
  const block = activeBlock();
  if (block?.startedAt) {
    const elapsed = Math.max(0, (Date.now() - new Date(block.startedAt).getTime()) / 60000);
    view.active = {
      blockId: block.id,
      elapsedMinutes: Math.round(elapsed * 10) / 10,
      budgetMinutes: block.budgetMinutes,
      remainingMinutes:
        block.budgetMinutes != null
          ? Math.round((block.budgetMinutes - elapsed) * 10) / 10
          : undefined,
      overBudget: block.budgetMinutes != null && elapsed > block.budgetMinutes,
      escalation: escalationFor(elapsed, block.budgetMinutes),
    };
  }
  return view;
}

// stateVersion bumps on escalation-level transitions too (C1 AC), so clients can diff a single
// number for "anything changed". Tracked per block; checked by the watcher tick.
let lastEscalation: { blockId: string; level: EscalationLevel } | null = null;

function checkEscalationTransition(block: WorkBlock): void {
  if (!block.startedAt) return;
  const elapsed = (Date.now() - new Date(block.startedAt).getTime()) / 60000;
  const level = escalationFor(elapsed, block.budgetMinutes);
  if (!lastEscalation || lastEscalation.blockId !== block.id || lastEscalation.level !== level) {
    lastEscalation = { blockId: block.id, level };
    bump();
  }
}

export function getStateVersion(): number {
  return stateVersion;
}

/** Re-hydrate a persisted plan on service start (best-effort; the queue survives restarts). Also
 *  re-anchors the FocusSession (review fix: without it, adjudication 500s after a restart and a
 *  per-call task could steer the focus) and restores the plan's pomodoro settings. */
export async function restorePlan(): Promise<void> {
  const saved = await store.load();
  if (saved?.activeBlockId) {
    current = saved;
    pomodoro = { ...saved.pomodoro };
    bump();
    const block = activeBlock();
    if (block) {
      await anchorSession(block); // the session is in-memory only — a restart must re-anchor it
      await armWatchers(block); // fresh baselines
    }
  }
}

export async function startPlan(opts: {
  label?: string;
  blocks: StartBlockInput[];
  workMinutes?: number;
  breakMinutes?: number;
}): Promise<PlanView> {
  if (!opts.blocks.length) throw new Error("a plan needs at least one block");
  pomodoro = { workMinutes: opts.workMinutes, breakMinutes: opts.breakMinutes };
  const now = new Date().toISOString();
  const blocks: WorkBlock[] = opts.blocks.map((b, i) =>
    mintBlock(b, `blk_${i}_${randomUUID().slice(0, 8)}`, i === 0 ? "active" : "pending"),
  );
  current = {
    id: `plan_${Date.now().toString(36)}`,
    label: opts.label,
    blocks,
    activeBlockId: blocks[0].id,
    createdAt: now,
    pomodoro, // persisted so a restart re-anchors with the right work/break minutes
  };
  undoState = null;
  bump();
  await persist();
  await anchorSession(blocks[0]);
  await armWatchers(blocks[0]);
  return planView()!;
}

export async function advanceBlock(
  blockId: string | undefined,
  how: "done" | "skipped",
): Promise<PlanView | null> {
  if (!current) throw new Error("no active plan");
  const id = blockId ?? current.activeBlockId;
  if (!id) throw new Error("no active block");
  // Review fix: only the ACTIVE block may be advanced — advancing a pending block would strand
  // the active one in status "active" forever (two actives, broken accounting).
  if (id !== current.activeBlockId) {
    throw new Error(`block ${id} is not the active block — only the active block can be advanced`);
  }
  undoState = null; // a fresh advance supersedes any pending undo (the auto path re-arms it after)
  current = advancePlan(current, id, how);
  bump();
  await persist();
  const next = activeBlock();
  if (next) {
    await anchorSession(next);
    await armWatchers(next);
    return planView();
  }
  // Queue exhausted — the plan is over.
  stopLoop();
  await endSession();
  const finished = planView();
  current = null;
  return finished;
}

/** The `manual` stop-condition fallback: mark it met, then advance as done. */
export async function completeBlock(blockId?: string): Promise<PlanView | null> {
  const block = blockId
    ? current?.blocks.find((b) => b.id === blockId)
    : activeBlock();
  if (current && block) {
    for (const c of block.stopConditions ?? []) {
      if (c.type === "manual" && !c.met) {
        c.met = true;
        c.metAt = new Date().toISOString();
      }
    }
  }
  return advanceBlock(block?.id, "done");
}

export async function toggleStep(blockId: string | undefined, stepId: string): Promise<PlanView> {
  if (!current) throw new Error("no active plan");
  const block = blockId
    ? current.blocks.find((b) => b.id === blockId)
    : activeBlock();
  const step: Step | undefined = block?.steps?.find((s) => s.id === stepId);
  if (!block || !step) throw new Error("unknown block or step");
  step.done = !step.done;
  bump();
  await persist();
  return planView()!;
}

/** Fluid edits (Epic A4 /plan/reorder): reorder pending blocks, drop one, extend a budget, or
 *  insert an ad-hoc block at the tail. Active/done blocks keep their position. */
export async function editPlan(edit: {
  order?: string[];
  drop?: string;
  budget?: { blockId: string; budgetMinutes: number };
  insert?: StartBlockInput;
}): Promise<PlanView> {
  if (!current) throw new Error("no active plan");

  if (edit.drop) {
    const b = current.blocks.find((x) => x.id === edit.drop);
    if (b?.status === "active") throw new Error("cannot drop the active block — advance it instead");
    current.blocks = current.blocks.filter((x) => x.id !== edit.drop);
  }
  if (edit.budget) {
    // Review fix: reject non-finite/absent minutes instead of coercing to a surprise 1-minute
    // budget (or NaN, which read as instant "grace" escalation).
    if (!Number.isFinite(edit.budget.budgetMinutes) || edit.budget.budgetMinutes <= 0) {
      throw new Error("budget edit needs a positive budgetMinutes number");
    }
    const b = current.blocks.find((x) => x.id === edit.budget!.blockId);
    if (b) b.budgetMinutes = Math.max(1, Math.round(edit.budget.budgetMinutes));
  }
  if (edit.insert) {
    // Shared constructor (review fix) — the old inline copy dropped stopConditions/advanceMode.
    current.blocks.push(mintBlock(edit.insert, `blk_i_${randomUUID().slice(0, 8)}`, "pending"));
  }
  if (edit.order?.length) {
    // Reorder only the pending tail; settled blocks (done/skipped/active) keep their position.
    const settled = current.blocks.filter((b) => b.status !== "pending");
    const pending = current.blocks.filter((b) => b.status === "pending");
    const byId = new Map(pending.map((b) => [b.id, b]));
    const reordered = edit.order.map((id) => byId.get(id)).filter((b): b is WorkBlock => !!b);
    const leftover = pending.filter((b) => !edit.order!.includes(b.id));
    current.blocks = [...settled, ...reordered, ...leftover];
  }
  bump();
  await persist();
  return planView()!;
}

/** End the plan outright: remaining pending blocks are skipped; the session ends. */
export async function endPlan(): Promise<PlanView | null> {
  if (!current) return null;
  stopLoop();
  undoState = null;
  const now = new Date().toISOString();
  for (const b of current.blocks) {
    if (b.status === "pending") b.status = "skipped";
    if (b.status === "active") {
      b.status = "skipped";
      b.completedAt = now;
    }
  }
  current.activeBlockId = undefined;
  bump();
  await persist();
  await endSession();
  const finished = planView();
  current = null;
  return finished;
}

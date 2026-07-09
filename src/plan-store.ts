import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { WorkBlock, WorkloadPlan } from "./types.js";

// The plan store (Epic A2). `PlanStore` is the seam Epic D swaps a Ledger-backed implementation
// into; `LocalPlanStore` persists the identical Ledger-native shape to `.data/plan.json`.
// Conventions match config-store.ts: missing/invalid file → null, never a throw.

export interface PlanStore {
  load(): Promise<WorkloadPlan | null>;
  save(p: WorkloadPlan): Promise<void>;
  advance(blockId: string, how: "done" | "skipped"): Promise<WorkloadPlan>;
  clear(): Promise<void>;
}

const DATA_DIR =
  process.env.BRICK_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const PLAN_PATH = join(DATA_DIR, "plan.json");

function isPlan(v: unknown): v is WorkloadPlan {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === "string" && Array.isArray(p.blocks) && typeof p.createdAt === "string";
}

/** Count all copies of a repeating block already in the queue (original + requeued clones). */
function copiesOf(plan: WorkloadPlan, block: WorkBlock): number {
  const key = block.id.replace(/~\d+$/, ""); // clones are id~1, id~2, …
  return plan.blocks.filter((b) => b.id === key || b.id.startsWith(`${key}~`)).length;
}

/** PURE queue-advance (Epic A2/A3): finish the given block, honour `repeat.requeue` (respecting
 *  `maxPerDay`), and activate the next pending block — or end the plan when none remain
 *  (`activeBlockId` cleared). Returns a new plan object; never mutates the input. */
export function advancePlan(
  plan: WorkloadPlan,
  blockId: string,
  how: "done" | "skipped",
  now: Date = new Date(),
): WorkloadPlan {
  const blocks = plan.blocks.map((b) => ({ ...b, steps: b.steps?.map((s) => ({ ...s })) }));
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx === -1) return { ...plan, blocks };
  const block = blocks[idx];

  block.status = how;
  block.completedAt = now.toISOString();
  if (block.startedAt) {
    block.actualMinutes = Math.max(
      0,
      Math.round((now.getTime() - new Date(block.startedAt).getTime()) / 60000),
    );
  }

  const next: WorkloadPlan = { ...plan, blocks };

  // A completed (not skipped) repeating block re-enqueues a clean copy at the tail.
  if (how === "done" && block.repeat?.mode === "requeue") {
    const cap = block.repeat.maxPerDay ?? Infinity;
    if (copiesOf(next, block) < cap) {
      const baseId = block.id.replace(/~\d+$/, "");
      const gen = (block.id.match(/~(\d+)$/)?.[1] ?? "0") as string;
      blocks.push({
        ...block,
        id: `${baseId}~${Number(gen) + 1}`,
        status: "pending",
        startedAt: undefined,
        completedAt: undefined,
        actualMinutes: undefined,
        ready: undefined,
        conditionFiredAt: undefined, // a fresh copy gets fresh triggers (review fix)
        timeFiredAt: undefined,
        steps: block.steps?.map((s) => ({ ...s, done: false })),
        stopConditions: block.stopConditions?.map((c) => ({ ...c, met: false, metAt: undefined })),
      });
    }
  }

  const upcoming = blocks.find((b) => b.status === "pending");
  if (upcoming) {
    upcoming.status = "active";
    upcoming.startedAt = now.toISOString();
    next.activeBlockId = upcoming.id;
  } else {
    next.activeBlockId = undefined; // queue exhausted — the plan is over
  }
  return next;
}

export class LocalPlanStore implements PlanStore {
  async load(): Promise<WorkloadPlan | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(PLAN_PATH, "utf8"));
      if (isPlan(parsed)) return parsed;
    } catch {
      /* no/invalid file → null */
    }
    return null;
  }

  async save(p: WorkloadPlan): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(PLAN_PATH, JSON.stringify(p, null, 2), "utf8");
  }

  async advance(blockId: string, how: "done" | "skipped"): Promise<WorkloadPlan> {
    const plan = await this.load();
    if (!plan) throw new Error("no active plan");
    const next = advancePlan(plan, blockId, how);
    await this.save(next);
    return next;
  }

  async clear(): Promise<void> {
    try {
      await unlink(PLAN_PATH);
    } catch {
      /* may not exist — fine */
    }
  }
}

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type {
  FocusRef,
  Slot,
  TemplateBlock,
  WorkloadPlan,
  WorkflowTemplate,
} from "./types.js";

// Workflow templates (Epic T): CRUD over `.data/templates.json` behind a TemplateStore interface
// (mirrors PlanStore — local now, Ledger-native later), plus the two pure workhorses:
// expandTemplate (slot binding + pattern expansion + day-boundary stop) and liftPlanToTemplate
// ("save current plan as template", optionally parameterizing projects into slots).

export interface TemplateStore {
  list(): Promise<WorkflowTemplate[]>;
  get(id: string): Promise<WorkflowTemplate | null>;
  save(t: WorkflowTemplate): Promise<WorkflowTemplate>;
  remove(id: string): Promise<boolean>;
}

const DATA_DIR =
  process.env.BRICK_DATA_DIR ?? fileURLToPath(new URL("../.data/", import.meta.url));
const TEMPLATES_PATH = join(DATA_DIR, "templates.json");
const MAX_TEMPLATES = 100;

function isTemplate(v: unknown): v is WorkflowTemplate {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return typeof t.id === "string" && typeof t.name === "string" && Array.isArray(t.blocks);
}

export class LocalTemplateStore implements TemplateStore {
  async list(): Promise<WorkflowTemplate[]> {
    try {
      const parsed: unknown = JSON.parse(await readFile(TEMPLATES_PATH, "utf8"));
      if (Array.isArray(parsed)) return parsed.filter(isTemplate);
    } catch {
      /* no/invalid file → empty */
    }
    return [];
  }

  async get(id: string): Promise<WorkflowTemplate | null> {
    return (await this.list()).find((t) => t.id === id) ?? null;
  }

  async save(t: WorkflowTemplate): Promise<WorkflowTemplate> {
    const list = (await this.list()).filter((x) => x.id !== t.id);
    list.push(t);
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(TEMPLATES_PATH, JSON.stringify(list.slice(-MAX_TEMPLATES), null, 2), "utf8");
    return t;
  }

  async remove(id: string): Promise<boolean> {
    const list = await this.list();
    const kept = list.filter((t) => t.id !== id);
    if (kept.length === list.length) return false;
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(TEMPLATES_PATH, JSON.stringify(kept, null, 2), "utf8");
    return true;
  }
}

/** A binding maps a slot key to a concrete target. */
export type SlotBinding = { projectId: string } | { task: string };

export interface ExpandedBlock {
  focusRef: FocusRef; // fully bound: {projectId} or {task}, never {slot}
  budgetMinutes?: number;
  steps?: string[];
  repeat?: TemplateBlock["repeat"];
  swapMode?: TemplateBlock["swapMode"];
  stopConditions?: TemplateBlock["stopConditions"]; // review fix: carried through expansion
  advanceMode?: TemplateBlock["advanceMode"];
  completionPolicy?: TemplateBlock["completionPolicy"];
}

const EXPANSION_CAP = 48; // hard ceiling on generated blocks (runaway guard)

/** PURE expansion (Epic T2): bind slots, then expand the pattern — a number repeats it exactly
 *  N times; "until-end-of-day" repeats whole patterns while the next repetition's total budget
 *  still fits before local midnight (always at least one). Throws on an unbound slot, and on
 *  until-end-of-day when any block lacks a budget (the boundary is otherwise incomputable). */
export function expandTemplate(
  tpl: WorkflowTemplate,
  bindings: Record<string, SlotBinding> = {},
  now: Date = new Date(),
): ExpandedBlock[] {
  const bind = (ref: FocusRef): FocusRef => {
    if (!("slot" in ref)) return ref;
    const slot = tpl.slots?.find((s) => s.key === ref.slot);
    const bound = bindings[ref.slot] ?? (slot?.defaultProjectId ? { projectId: slot.defaultProjectId } : undefined);
    if (!bound) throw new Error(`slot "${ref.slot}" is unbound (no binding, no default)`);
    return bound;
  };

  const one: ExpandedBlock[] = tpl.blocks.map((b) => ({
    focusRef: bind(b.focusRef),
    budgetMinutes: b.budgetMinutes,
    steps: b.steps ? [...b.steps] : undefined,
    repeat: b.repeat,
    swapMode: b.swapMode,
    // Each expansion gets its own fresh (unmet) copy — a stop condition is per-block-instance.
    stopConditions: b.stopConditions?.map((c) => ({ ...c, met: false, metAt: undefined })),
    advanceMode: b.advanceMode,
    completionPolicy: b.completionPolicy,
  }));
  if (!one.length) throw new Error("template has no blocks");

  // Deep-clone per repetition — review fix: `{...b}` alone shares the stopConditions ARRAY
  // reference across every repeated instance, so marking one instance's condition met would leak
  // into every other copy of that block in the expanded plan.
  const cloneOne = (): ExpandedBlock[] =>
    one.map((b) => ({ ...b, stopConditions: b.stopConditions?.map((c) => ({ ...c })) }));

  const repeat = tpl.pattern?.repeat ?? 1;
  if (repeat === "until-end-of-day") {
    if (one.some((b) => b.budgetMinutes == null)) {
      throw new Error("until-end-of-day needs a budget on every block");
    }
    const patternMinutes = one.reduce((sum, b) => sum + (b.budgetMinutes ?? 0), 0);
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    const remaining = (midnight.getTime() - now.getTime()) / 60000;
    const reps = Math.max(1, Math.floor(remaining / patternMinutes));
    const out: ExpandedBlock[] = [];
    for (let i = 0; i < reps && out.length < EXPANSION_CAP; i += 1) out.push(...cloneOne());
    return out.slice(0, EXPANSION_CAP);
  }

  const reps = Math.max(1, Math.min(Math.round(repeat), Math.floor(EXPANSION_CAP / one.length) || 1));
  const out: ExpandedBlock[] = [];
  for (let i = 0; i < reps; i += 1) out.push(...cloneOne());
  return out.slice(0, EXPANSION_CAP);
}

/** PURE "save current plan as template" (Epic T3): strip runtime fields. With `parameterize`,
 *  distinct projects are lifted into slots (A, B, …) so the shape is re-bindable; explicit tasks
 *  always stay pre-bound (there is nothing meaningful to parameterize). */
export function liftPlanToTemplate(
  plan: WorkloadPlan,
  name: string,
  parameterize = false,
  now: Date = new Date(),
): WorkflowTemplate {
  const slots: Slot[] = [];
  const slotByProject = new Map<string, string>();
  const keyFor = (projectId: string, label: string): string => {
    let key = slotByProject.get(projectId);
    if (!key) {
      key = String.fromCharCode(65 + slots.length); // A, B, C…
      slots.push({ key, label, defaultProjectId: projectId });
      slotByProject.set(projectId, key);
    }
    return key;
  };

  const blocks: TemplateBlock[] = plan.blocks
    .filter((b) => !/~\d+$/.test(b.id)) // drop requeued clones — the repeat spec regenerates them
    .map((b) => ({
      focusRef:
        b.focus.projectId && parameterize
          ? { slot: keyFor(b.focus.projectId, b.focus.projectName ?? b.focus.projectId) }
          : b.focus.projectId
            ? { projectId: b.focus.projectId }
            : { task: b.focus.task },
      budgetMinutes: b.budgetMinutes,
      steps: b.steps?.map((s) => s.label),
      repeat: b.repeat,
      swapMode: b.swapMode,
      // Review fix: carry stop conditions/advance mode/policy through save-as-template — they
      // were silently dropped before, so a relaunched template lost all its watchers.
      stopConditions: b.stopConditions?.map((c) => ({ ...c, met: false, metAt: undefined })),
      advanceMode: b.advanceMode,
      completionPolicy: b.completionPolicy,
    }));

  return {
    id: `tpl_${now.getTime().toString(36)}`,
    name,
    slots: slots.length ? slots : undefined,
    blocks,
    createdAt: now.toISOString(),
  };
}

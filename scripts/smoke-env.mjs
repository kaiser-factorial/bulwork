// Smoke pre-setup: MUST be the first import in smoke.mjs. Creates a fake `ledger` binary (prints a
// canned `status --json` payload from a state file we can rewrite mid-test) and points LEDGER_BIN
// at it BEFORE any dist/ module loads — ledger.js freezes LEDGER_BIN at import time.
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "brick-fakeledger-"));
const stateFile = join(dir, "state.json");

export function setLedgerProjects(projects) {
  writeFileSync(stateFile, JSON.stringify(projects, null, 2));
}

setLedgerProjects([{ id: "p1", name: "Proj One", nextAction: "step A" }]);

const bin = join(dir, "ledger");
writeFileSync(bin, `#!/bin/sh\ncat "${stateFile}"\n`);
chmodSync(bin, 0o755);
process.env.LEDGER_BIN = bin;

export const FAKE_LEDGER = { bin, stateFile, dir };

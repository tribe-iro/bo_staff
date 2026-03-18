import test from "node:test";
import assert from "node:assert/strict";
import { listConformanceContracts } from "../../src/conformance/matrix.ts";
import { CAPABILITY_NAMES } from "../../src/core/index.ts";
import { resolveCapabilityOutcomes } from "../../src/compat/conformance.ts";

test("conformance matrix is defined for both backends", () => {
  const contracts = listConformanceContracts();
  assert.deepEqual(
    contracts.map((contract) => contract.backend).sort(),
    ["claude", "codex"]
  );
  for (const contract of contracts) {
    assert.equal(contract.supported_performance_tiers.includes("balanced"), true);
    assert.equal(typeof contract.capabilities.structured_artifacts.delivery_mode, "string");
  }
});

test("capability resolution returns a total descriptive map for claude", () => {
  const resolved = resolveCapabilityOutcomes({ backend: "claude" });

  assert.deepEqual(Object.keys(resolved.outcomes), [...CAPABILITY_NAMES]);
  assert.equal(resolved.outcomes.interactive_control_gates.status, "degraded");
  assert.equal(resolved.diagnostics.interactive_control_gates.delivery_mode, "degraded");
});

test("codex capability resolution remains descriptive rather than request-driven", () => {
  const resolved = resolveCapabilityOutcomes({ backend: "codex" });

  assert.equal(resolved.outcomes.interactive_control_gates.status, "degraded");
  assert.equal(resolved.diagnostics.interactive_control_gates.delivery_mode, "degraded");
  assert.equal(resolved.outcomes.structured_artifacts.status, "satisfied");
});

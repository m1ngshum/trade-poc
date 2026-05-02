import { test } from "node:test";
import assert from "node:assert/strict";

import { CostTracker } from "../src/agent/cost-tracker.js";

test("accumulates same-day costs", () => {
  const c = new CostTracker(5);
  c.add(0.01);
  c.add(0.02);
  c.add(0.03);
  assert.ok(Math.abs(c.getSpentToday() - 0.06) < 1e-9);
  assert.equal(c.isExceeded(), false);
});

test("ignores undefined and non-positive costs", () => {
  const c = new CostTracker(5);
  c.add(undefined);
  c.add(0);
  c.add(-1);
  assert.equal(c.getSpentToday(), 0);
});

test("isExceeded fires once budget is consumed", () => {
  const c = new CostTracker(0.05);
  c.add(0.04);
  assert.equal(c.isExceeded(), false);
  c.add(0.02);
  assert.equal(c.isExceeded(), true);
});

test("resets at UTC date change", () => {
  let now = new Date("2026-05-02T23:59:00.000Z");
  const c = new CostTracker(5, () => now);
  c.add(1.5);
  assert.ok(Math.abs(c.getSpentToday() - 1.5) < 1e-9);
  now = new Date("2026-05-03T00:00:30.000Z");
  assert.equal(c.getSpentToday(), 0);
  assert.equal(c.isExceeded(), false);
});

test("budget of 0 disables the cap", () => {
  const c = new CostTracker(0);
  c.add(1_000_000);
  assert.equal(c.isExceeded(), false);
});

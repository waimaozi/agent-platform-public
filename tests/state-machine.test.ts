import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  getAllowedTransitions
} from "@agent-platform/core";

describe("task state machine", () => {
  it("allows the happy path transitions", () => {
    expect(canTransition("NEW", "INTAKE_NORMALIZED")).toBe(true);
    expect(canTransition("INTAKE_NORMALIZED", "PLANNING")).toBe(true);
    expect(canTransition("PLANNING", "AWAITING_APPROVAL")).toBe(true);
    expect(canTransition("AWAITING_APPROVAL", "RUNNING")).toBe(true);
    expect(canTransition("RUNNING", "VERIFYING")).toBe(true);
    expect(canTransition("VERIFYING", "COMPLETED")).toBe(true);
  });

  it("blocks invalid transitions", () => {
    expect(canTransition("NEW", "RUNNING")).toBe(false);
    expect(() => assertTransition("COMPLETED", "RUNNING")).toThrow(/Invalid task state transition/);
    expect(() => assertTransition("CANCELLED", "PLANNING")).toThrow(/Invalid task state transition/);
  });

  it("supports pause and resume from active states", () => {
    expect(getAllowedTransitions("PAUSED")).toEqual(
      expect.arrayContaining(["PLANNING", "RUNNING", "AWAITING_APPROVAL", "CANCELLED"])
    );
  });
});

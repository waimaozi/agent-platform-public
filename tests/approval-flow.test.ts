import { describe, expect, it } from "vitest";
import { resolveApprovalDecision } from "../apps/api/src/lib/approval-flow.js";

describe("approval flow", () => {
  it("resumes task on approve", () => {
    expect(
      resolveApprovalDecision({
        currentStatus: "pending",
        decision: "approve"
      })
    ).toEqual({
      approvalStatus: "approved",
      taskState: "RUNNING"
    });
  });

  it("cancels task on reject", () => {
    expect(
      resolveApprovalDecision({
        currentStatus: "pending",
        decision: "reject"
      })
    ).toEqual({
      approvalStatus: "rejected",
      taskState: "CANCELLED"
    });
  });

  it("does not reapply a decision once approval is closed", () => {
    expect(
      resolveApprovalDecision({
        currentStatus: "approved",
        decision: "reject"
      })
    ).toBeNull();
  });
});

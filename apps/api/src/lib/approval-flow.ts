export type ApprovalRuntimeStatus = "pending" | "approved" | "rejected" | "expired";
export type ApprovalRuntimeDecision = "approve" | "reject";
export type ApprovalRuntimeTaskState = "RUNNING" | "CANCELLED";

export interface ApprovalResolution {
  approvalStatus: Extract<ApprovalRuntimeStatus, "approved" | "rejected">;
  taskState: ApprovalRuntimeTaskState;
}

export function resolveApprovalDecision(input: {
  currentStatus: ApprovalRuntimeStatus;
  decision: ApprovalRuntimeDecision;
}): ApprovalResolution | null {
  if (input.currentStatus !== "pending") {
    return null;
  }

  return {
    approvalStatus: input.decision === "approve" ? "approved" : "rejected",
    taskState: input.decision === "approve" ? "RUNNING" : "CANCELLED"
  };
}

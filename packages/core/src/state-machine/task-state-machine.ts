import { TaskState } from "@agent-platform/contracts";

const transitions: Record<TaskState, TaskState[]> = {
  NEW: ["INTAKE_NORMALIZED", "CANCELLED"],
  INTAKE_NORMALIZED: ["PLANNING", "CANCELLED", "FAILED", "PAUSED"],
  PLANNING: ["AWAITING_APPROVAL", "RUNNING", "FAILED", "PAUSED", "CANCELLED"],
  AWAITING_APPROVAL: ["RUNNING", "CANCELLED", "FAILED", "PAUSED"],
  RUNNING: ["VERIFYING", "AWAITING_HUMAN", "COMPLETED", "FAILED", "PAUSED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "FAILED", "AWAITING_HUMAN", "RUNNING", "PAUSED"],
  AWAITING_HUMAN: ["RUNNING", "CANCELLED", "FAILED", "PAUSED"],
  COMPLETED: [],
  FAILED: ["PLANNING"],
  CANCELLED: [],
  PAUSED: ["PLANNING", "RUNNING", "AWAITING_APPROVAL", "CANCELLED"]
};

export function canTransition(from: TaskState, to: TaskState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: TaskState, to: TaskState): void {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid task state transition: ${from} -> ${to}`);
  }
}

export function getAllowedTransitions(from: TaskState): TaskState[] {
  return [...transitions[from]];
}

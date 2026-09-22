export type FailureDisposition = "group" | "batch";

export interface FailureDetails {
  code: string;
  disposition: FailureDisposition;
  message: string;
}

export class WorkflowFailure extends Error {
  constructor(
    readonly code: string,
    readonly disposition: FailureDisposition,
    message: string,
  ) {
    super(message);
    this.name = "WorkflowFailure";
  }
}

export class BatchStoppingError extends WorkflowFailure {
  constructor(code: string, message: string) {
    super(code, "batch", message);
    this.name = "BatchStoppingError";
  }
}

export class GroupOperationError extends WorkflowFailure {
  constructor(code: string, message: string) {
    super(code, "group", message);
    this.name = "GroupOperationError";
  }
}

export class ResourceCleanupError extends Error {
  constructor(
    message: string,
    readonly requiresManualReview: boolean,
  ) {
    super(message);
    this.name = "ResourceCleanupError";
  }
}

export function failureDetails(error: unknown): FailureDetails {
  if (error instanceof WorkflowFailure) {
    return {
      code: error.code,
      disposition: error.disposition,
      message: error.message,
    };
  }
  return {
    code: "group-operation-failed",
    disposition: "group",
    message: error instanceof Error ? error.message : "发生未知错误",
  };
}

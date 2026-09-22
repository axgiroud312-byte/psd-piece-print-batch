import type { CancellationToken } from "./types";

export class OperationCancelledError extends Error {
  constructor(message = "用户已请求停止，将在安全边界结束当前组") {
    super(message);
    this.name = "OperationCancelledError";
  }
}

export class RunCancellation implements CancellationToken {
  private cancelled = false;

  get isCancellationRequested(): boolean {
    return this.cancelled;
  }

  cancel(): void {
    this.cancelled = true;
  }
}

export type TaskProgressStage = "created" | "plan-submitted" | "queued";

export function formatTaskProgress(taskId: string, stage: TaskProgressStage): string {
  return `run-id: ${taskId} ${stage}\n`;
}

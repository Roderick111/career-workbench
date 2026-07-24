import { db, id, now } from "./db";

export interface OperationHandle {
  id: string;
  requestId: string;
  startedAt: number;
}

export function logEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const record = { timestamp: now(), level, event, ...fields };
  const output = JSON.stringify(record);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}

export function beginOperation(
  userId: string,
  operation: string,
  requestId: string,
): OperationHandle | null {
  const operationId = id();
  const startedAt = Date.now();
  const result = db
    .query(
      `INSERT INTO operation_logs
        (id, request_id, user_id, operation, status, started_at)
       SELECT ?, ?, ?, ?, 'running', ?
       WHERE NOT EXISTS (
         SELECT 1 FROM operation_logs
         WHERE user_id = ? AND operation = ? AND status = 'running'
       )`,
    )
    .run(operationId, requestId, userId, operation, now(), userId, operation);
  if (result.changes !== 1) {
    logEvent("warn", "operation.rejected_duplicate", { requestId, userId, operation });
    return null;
  }
  logEvent("info", "operation.started", { requestId, operationId, userId, operation });
  return { id: operationId, requestId, startedAt };
}

export function updateOperationInput(
  handle: OperationHandle,
  input: { name?: string; bytes?: number; characters?: number },
): void {
  db.query(
    `UPDATE operation_logs
     SET input_name = ?, input_bytes = ?, input_characters = ?
     WHERE id = ? AND status = 'running'`,
  ).run(input.name ?? null, input.bytes ?? 0, input.characters ?? 0, handle.id);
  logEvent("info", "operation.input_ready", {
    requestId: handle.requestId,
    operationId: handle.id,
    inputName: input.name,
    inputBytes: input.bytes ?? 0,
    inputCharacters: input.characters ?? 0,
  });
}

export function finishOperation(
  handle: OperationHandle,
  status: "succeeded" | "failed",
  details: Record<string, unknown> = {},
  error?: unknown,
): void {
  const durationMs = Date.now() - handle.startedAt;
  const errorMessage = error instanceof Error ? error.message : error ? String(error) : null;
  db.query(
    `UPDATE operation_logs
     SET status = ?, details_json = ?, error = ?, completed_at = ?, duration_ms = ?
     WHERE id = ?`,
  ).run(status, JSON.stringify(details), errorMessage, now(), durationMs, handle.id);
  logEvent(status === "failed" ? "error" : "info", `operation.${status}`, {
    requestId: handle.requestId,
    operationId: handle.id,
    durationMs,
    ...details,
    ...(errorMessage ? { error: errorMessage } : {}),
  });
}

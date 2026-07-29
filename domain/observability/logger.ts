import { redactMetadata } from "./redaction.ts";

export type StructuredLogInput = {
  level?: "info" | "warn" | "error";
  event: string;
  action: string;
  result: "success" | "failure" | "denied";
  requestId: string;
  metadata?: unknown;
  occurredAt?: string;
};

export type StructuredLogEvent = {
  level: "info" | "warn" | "error";
  event: string;
  action: string;
  result: "success" | "failure" | "denied";
  requestId: string;
  occurredAt: string;
  metadata: Record<string, unknown>;
};

export function createStructuredLogEvent(
  input: StructuredLogInput,
  now: () => string = () => new Date().toISOString(),
): StructuredLogEvent {
  return {
    level: input.level ?? "info",
    event: input.event,
    action: input.action,
    result: input.result,
    requestId: input.requestId,
    occurredAt: input.occurredAt ?? now(),
    metadata: redactMetadata(input.metadata ?? {}),
  };
}

export function emitStructuredLog(
  input: StructuredLogInput,
  sink: (line: string) => void = (line) => console.log(line),
): StructuredLogEvent {
  const event = createStructuredLogEvent(input);
  sink(JSON.stringify(event));
  return event;
}

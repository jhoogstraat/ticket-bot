export interface StructuredLogger {
  info(event: string, attributes: Record<string, unknown>): void;
  error(event: string, attributes: Record<string, unknown>): void;
}
export const structuredLogger: StructuredLogger = {
  info: (event, attributes) => console.log(JSON.stringify({ level: "info", event, ...attributes })),
  error: (event, attributes) =>
    console.error(JSON.stringify({ level: "error", event, ...attributes })),
};

export interface TelemetryHooks {
  recordStageDuration(
    stage: string,
    milliseconds: number,
    attributes: Record<string, string | number>,
  ): void;
}
export const noOpTelemetry: TelemetryHooks = { recordStageDuration: () => undefined };

import { SpanStatusCode, trace, type Attributes } from '@opentelemetry/api';

export const TRACER_NAME = 'mcp-policy-proxy';

/** Names without the `mcp_policy.` prefix; undefined values are left out of the span. */
export type SpanFields = Record<string, string | number | boolean | undefined>;

function attributes(fields: SpanFields): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) out[`mcp_policy.${key}`] = value;
  }
  return out;
}

/**
 * Runs `fn` inside the span `mcp_policy.<name>`. `end` is read once `fn` has settled, so the
 * span can say how the work ended. A failure sets the error status with no message, because
 * an error's text can quote the call's arguments back.
 */
export function withSpan<T>(
  name: string,
  start: SpanFields,
  fn: () => T,
  end: () => { fields: SpanFields; failed?: boolean },
): T {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(`mcp_policy.${name}`, { attributes: attributes(start) }, (span) => {
    const finish = () => {
      try {
        const { fields, failed } = end();
        span.setAttributes(attributes(fields));
        if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
      } finally {
        span.end();
      }
    };
    let result: T;
    try {
      result = fn();
    } catch (e) {
      finish();
      throw e;
    }
    if (result instanceof Promise) return result.finally(finish) as T;
    finish();
    return result;
  });
}

/**
 * Sends spans to the OTLP endpoint named by the standard `OTEL_EXPORTER_OTLP_*` variables.
 * The SDK is loaded only here, so a proxy that does not export never pays for it.
 */
export async function registerOtlpExporter(): Promise<() => Promise<void>> {
  const [{ NodeTracerProvider, BatchSpanProcessor }, { OTLPTraceExporter }] = await Promise.all([
    import('@opentelemetry/sdk-trace-node'),
    import('@opentelemetry/exporter-trace-otlp-http'),
  ]);
  const provider = new NodeTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register();
  return () => provider.shutdown();
}

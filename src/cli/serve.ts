import { parseArgs } from 'node:util';
import type { CliIo } from '../cli.js';
import { registerOtlpExporter } from '../audit/otel.js';
import { loadConfig } from '../config/schema.js';
import { startFromConfig } from '../config/start.js';
import { messageOf } from '../util.js';

export function serveArgs(args: string[]): { config: string } | undefined {
  try {
    const { values } = parseArgs({ args, options: { config: { type: 'string' } }, strict: true });
    return values.config === undefined ? undefined : { config: values.config };
  } catch {
    return undefined;
  }
}

function untilSignal(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const stop = (signal: NodeJS.Signals) => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve(signal);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

export async function serve(file: string, io: CliIo): Promise<number> {
  const log = (line: string) => void io.stderr.write(`${line}\n`);
  let stopTracing: (() => Promise<void>) | undefined;
  let code = 0;
  try {
    const config = loadConfig(file);
    if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) stopTracing = await registerOtlpExporter();
    const running = await startFromConfig(config, { log });
    // stdout may be the MCP channel, so everything for the operator goes to stderr.
    log(running.url === undefined ? 'serving over stdio' : `listening on ${running.url}`);
    await untilSignal();
    await running.close();
  } catch (e) {
    log(`mcp-policy-proxy: ${messageOf(e)}`);
    code = 1;
  }
  try {
    // Flushes spans still waiting in the batch.
    await stopTracing?.();
  } catch (e) {
    // The proxy itself stopped cleanly; a collector that is down only loses those spans.
    log(`mcp-policy-proxy: could not export the last spans: ${messageOf(e)}`);
  }
  return code;
}

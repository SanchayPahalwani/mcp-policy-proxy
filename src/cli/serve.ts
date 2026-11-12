import { parseArgs } from 'node:util';
import type { CliIo } from '../cli.js';
import { registerOtlpExporter } from '../audit/otel.js';
import { loadConfig } from '../config/schema.js';
import { startFromConfig } from '../config/start.js';
import { codeOf, messageOf } from '../util.js';

export function serveArgs(args: string[]): { config: string } | 'help' | undefined {
  try {
    const { values } = parseArgs({
      args,
      options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    });
    if (values.help) return 'help';
    return values.config === undefined ? undefined : { config: values.config };
  } catch {
    return undefined;
  }
}

/** Listens from the moment it is called, so a signal sent during startup is not lost. */
function watchSignals(): { received: Promise<void>; dispose(): void } {
  let resolve: () => void = () => {};
  const received = new Promise<void>((r) => (resolve = r));
  const stop = () => {
    dispose();
    resolve();
  };
  const dispose = () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return { received, dispose };
}

export async function serve(file: string, io: CliIo): Promise<number> {
  const log = (line: string) => void io.stderr.write(`${line}\n`);
  const signals = watchSignals();
  let stopTracing: (() => Promise<void>) | undefined;
  let code = 0;
  try {
    const config = loadConfig(file);
    if (process.env['OTEL_EXPORTER_OTLP_ENDPOINT']) stopTracing = await registerOtlpExporter();
    const running = await startFromConfig(config, { log });
    // stdout may be the MCP channel, so everything for the operator goes to stderr.
    log(running.url === undefined ? 'serving over stdio' : `listening on ${running.url}`);
    // A signal that came while starting has already settled `received`, so this stops at once.
    await Promise.race([signals.received, running.closed]);
    await running.close();
  } catch (e) {
    log(`mcp-policy-proxy: ${messageOf(e)}`);
    code = 1;
  } finally {
    signals.dispose();
  }
  try {
    // Flushes spans still waiting in the batch.
    await stopTracing?.();
  } catch (e) {
    // The proxy itself stopped cleanly; a collector that is down only loses those spans.
    log(`mcp-policy-proxy: could not export the last spans${codeOf(e)}`);
  }
  return code;
}

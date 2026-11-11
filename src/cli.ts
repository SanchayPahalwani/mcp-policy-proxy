#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { registerOtlpExporter } from './audit/otel.js';
import { loadConfig, startFromConfig } from './config.js';

const USAGE = 'usage: mcp-policy-proxy serve --config <file>\n';

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

function serveArgs(args: string[]): { config: string } | undefined {
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

async function serve(file: string, io: CliIo): Promise<number> {
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

export async function main(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const [command, ...rest] = argv;
  const serveOptions = command === 'serve' ? serveArgs(rest) : undefined;
  if (!serveOptions) {
    io.stderr.write(USAGE);
    return 2;
  }
  return serve(serveOptions.config, io);
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    // The installed bin is a symlink to this file.
    return import.meta.url === pathToFileURL(realpathSync(script)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = await main(process.argv.slice(2));
}

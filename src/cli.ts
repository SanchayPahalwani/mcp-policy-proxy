#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { check } from './cli/check.js';
import { explain } from './cli/explain.js';
import { serve, serveArgs } from './cli/serve.js';
import { test } from './cli/test.js';
import { HelpRequested } from './cli/shared.js';
import { validate } from './cli/validate.js';
import { messageOf } from './util.js';

const USAGE = `usage: mcp-policy-proxy serve --config <file>
       mcp-policy-proxy check --policy <file> [--identity <name>] [--format text|json|github] <sessions...>
       mcp-policy-proxy test [--policy <file>] [--format text|json|github] <tests...>
       mcp-policy-proxy validate --policy <file> [--config <file>] [--format text|json|github]
       mcp-policy-proxy explain --policy <file> --identity <name> --tool <server__tool> [--args <json>] [--session <id>]
`;

export interface CliIo {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  /** Defaults to `process.env`; only `GITHUB_ACTIONS` is read. */
  env?: NodeJS.ProcessEnv;
}

const OFFLINE = { check, test, validate, explain };

export async function main(
  argv: string[],
  io: CliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (argv[0] === '--help' || argv[0] === '-h') {
    io.stdout.write(USAGE);
    return 0;
  }
  const [command, ...rest] = argv;
  if (command !== undefined && Object.hasOwn(OFFLINE, command)) {
    try {
      return OFFLINE[command as keyof typeof OFFLINE](rest, io);
    } catch (e) {
      if (e instanceof HelpRequested) {
        io.stdout.write(USAGE);
        return 0;
      }
      // Unreadable or malformed input, as opposed to a finding about it.
      io.stderr.write(`mcp-policy-proxy: ${messageOf(e)}\n`);
      return 2;
    }
  }
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

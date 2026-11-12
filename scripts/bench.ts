import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { BENCH_BEGIN, BENCH_END, replaceBlock } from '../eval/report.js';
import { fileAuditSink } from '../src/audit/log.js';
import { parsePolicy } from '../src/policy/load.js';
import { sha256Hex, staticTokenAuthenticator } from '../src/proxy/auth.js';
import { startHttpProxy } from '../src/proxy/http.js';
import { policyGate } from '../src/proxy/policy-gate.js';
import { Upstreams } from '../src/proxy/upstreams.js';

const WARMUP = 100;
const CALLS = 1000;
const TEXT = 'hello from the benchmark';
// Never a secret: the proxy listens on loopback for the length of the run.
const TOKEN = 'bench-token';
const RESULTS = fileURLToPath(new URL('../docs/results.md', import.meta.url));

// Shaped like the example policy: an allow rule for one identity with an argument constraint.
// No limits, since 1,100 calls would run past any realistic per-session cap.
const POLICY = `version: 1
rules:
  - id: bench-echo
    identities: [bench]
    server: bench
    tools: [echo]
    effect: allow
    when:
      - arg: text
        max_length: 120
`;

function echoServer(): Server {
  const server = new Server({ name: 'bench', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'echo',
        description: 'Returns its text',
        inputSchema: {
          type: 'object' as const,
          properties: { text: { type: 'string' } },
          required: ['text'],
        },
      },
    ],
  }));
  server.setRequestHandler('tools/call', async (req) => ({
    content: [{ type: 'text' as const, text: String(req.params.arguments?.['text'] ?? '') }],
  }));
  return server;
}

async function listen(http: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(0, '127.0.0.1', () => resolve());
  });
  return `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
}

async function connect(url: string, headers?: Record<string, string>): Promise<Client> {
  const client = new Client(
    { name: 'bench', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : {}),
  );
  return client;
}

/** Times each call; a call that comes back as an error would be timing a refusal, so it stops the run. */
async function measure(client: Client, name: string): Promise<number[]> {
  const call = async () => {
    const result = await client.callTool({ name, arguments: { text: TEXT } });
    const [block] = Array.isArray(result.content) ? result.content : [];
    if (result.isError || block?.type !== 'text' || block.text !== TEXT) {
      throw new Error(`${name} did not echo: ${JSON.stringify(result)}`);
    }
  };
  for (let i = 0; i < WARMUP; i++) await call();
  const times: number[] = [];
  for (let i = 0; i < CALLS; i++) {
    const start = performance.now();
    await call();
    times.push(performance.now() - start);
  }
  return times;
}

/** Nearest rank: the smallest sample with at least q of all samples at or below it. */
function percentile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

interface Row {
  path: string;
  p50: number;
  p95: number;
  p99: number;
}

function row(path: string, times: number[]): Row {
  const sorted = [...times].sort((a, b) => a - b);
  return {
    path,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

function render(direct: Row, proxied: Row): string {
  const ms = (n: number) => n.toFixed(2);
  const rows = [
    ['path', 'p50 ms', 'p95 ms', 'p99 ms'],
    ...[direct, proxied].map((r) => [r.path, ms(r.p50), ms(r.p95), ms(r.p99)]),
  ];
  const widths = rows[0]!.map((_, i) => Math.max(3, ...rows.map((r) => r[i]!.length)));
  const line = (cells: string[]) => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`;
  return [
    `Local loopback, synthetic. Measured ${new Date().toISOString().slice(0, 10)} with \`npm run bench\`.`,
    '',
    `- Node ${process.version}, ${process.platform}/${process.arch}, ${cpus()[0]?.model.trim() ?? 'unknown CPU'}`,
    `- One \`tools/call\` of an \`echo\` tool on a Streamable HTTP server at 127.0.0.1: ${WARMUP} warm-up calls, then ${CALLS.toLocaleString('en-US')} sequential calls per path`,
    '- Through the proxy: the policy gate with one allow rule and one argument constraint, and an audit log written to a file',
    '',
    line(rows[0]!),
    line(widths.map((w) => '-'.repeat(w))),
    ...rows.slice(1).map(line),
    '',
    `Added latency at p50: ${ms(proxied.p50 - direct.p50)} ms per call.`,
    '',
  ].join('\n');
}

async function bench(): Promise<string> {
  const closers: Array<() => Promise<void> | void> = [];
  const dir = mkdtempSync(join(tmpdir(), 'mcp-policy-proxy-bench-'));
  closers.push(() => rmSync(dir, { recursive: true, force: true }));
  try {
    const handler = createMcpHandler(() => echoServer());
    const nodeHandler = toNodeHandler(handler);
    const http = createServer((req, res) => void nodeHandler(req, res));
    const upstreamUrl = await listen(http);
    closers.push(async () => {
      await handler.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    });

    const audit = fileAuditSink(join(dir, 'audit.jsonl'));
    closers.push(() => audit.close());
    const upstreams = await Upstreams.connect([
      { name: 'bench', transport: 'http', url: upstreamUrl },
    ]);
    closers.push(() => upstreams.close());
    const proxy = await startHttpProxy({
      upstreams,
      gate: policyGate({ policy: parsePolicy(POLICY), audit }),
      authenticator: staticTokenAuthenticator([{ name: 'bench', token_sha256: sha256Hex(TOKEN) }]),
      host: '127.0.0.1',
      port: 0,
    });
    closers.push(() => proxy.close());

    const direct = await connect(upstreamUrl);
    closers.push(() => direct.close());
    const proxied = await connect(proxy.url, { authorization: `Bearer ${TOKEN}` });
    closers.push(() => proxied.close());

    const directRow = row('direct, client to server', await measure(direct, 'echo'));
    const proxiedRow = row('through the proxy', await measure(proxied, 'bench__echo'));
    return render(directRow, proxiedRow);
  } finally {
    for (const close of closers.reverse()) await close();
  }
}

async function main(argv: string[]): Promise<number> {
  const write = argv.length === 0;
  if (!write && !(argv.length === 1 && argv[0] === '--no-write')) {
    process.stderr.write('usage: tsx scripts/bench.ts [--no-write]\n');
    return 2;
  }
  const block = await bench();
  process.stdout.write(block);
  if (write) {
    writeFileSync(
      RESULTS,
      replaceBlock(readFileSync(RESULTS, 'utf8'), BENCH_BEGIN, BENCH_END, block),
    );
    process.stderr.write('updated docs/results.md\n');
  } else {
    process.stderr.write('not written: --no-write leaves docs/results.md as it was\n');
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));

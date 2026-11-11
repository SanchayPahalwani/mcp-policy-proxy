import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { fixedApprover } from '../../src/approval/types.js';
import { loadPolicy } from '../../src/policy/load.js';
import type { Caller } from '../../src/proxy/gate.js';
import { policyGate } from '../../src/proxy/policy-gate.js';
import type { UpstreamTool } from '../../src/proxy/upstreams.js';

const EXAMPLE = loadPolicy(fileURLToPath(new URL('../../examples/policy.yaml', import.meta.url)));
const WRITER: Caller = { identity: 'writer', session: 's1' };
const SECRET = 'secret-body';
const OK: CallToolResult = { content: [{ type: 'text', text: `echo ${SECRET}` }] };

let exporter: InMemorySpanExporter;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }),
  );
});

afterEach(() => {
  trace.disable();
  vi.restoreAllMocks();
});

const spans = () => exporter.getFinishedSpans();

function only(name: string): ReadableSpan {
  const named = spans().filter((s) => s.name === name);
  expect(named).toHaveLength(1);
  return named[0]!;
}

function expectNoArgumentText() {
  for (const span of spans()) {
    for (const value of Object.values(span.attributes)) {
      expect(String(value)).not.toContain(SECRET);
    }
  }
}

const tool = (server: string, name: string): UpstreamTool => ({
  server,
  tool: { name, inputSchema: { type: 'object' } },
});

describe('tool call spans', () => {
  it('describes an allowed call that was forwarded', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    const forward = vi.fn(async () => OK);
    await gate.callTool(
      WRITER,
      { server: 'docs', tool: 'create_draft', args: { title: 'notes', body: SECRET } },
      forward,
    );
    expect(forward).toHaveBeenCalledOnce();
    const span = only('mcp_policy.tool_call');
    expect(span.attributes).toEqual({
      'mcp_policy.identity': 'writer',
      'mcp_policy.session': 's1',
      'mcp_policy.server': 'docs',
      'mcp_policy.tool': 'create_draft',
      'mcp_policy.effect': 'allow',
      'mcp_policy.code': 'allowed',
      'mcp_policy.rule': 'writer-drafts',
      'mcp_policy.forwarded': true,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expectNoArgumentText();
  });

  it('describes a visible call refused for its arguments, without an error status', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    const forward = vi.fn(async () => OK);
    const result = await gate.callTool(
      WRITER,
      { server: 'docs', tool: 'update_draft', args: { id: 'd1', title: SECRET.repeat(20) } },
      forward,
    );
    expect(result.isError).toBe(true);
    expect(forward).not.toHaveBeenCalled();
    const span = only('mcp_policy.tool_call');
    expect(span.attributes).toMatchObject({
      'mcp_policy.effect': 'deny',
      'mcp_policy.code': 'constraint_failed',
      'mcp_policy.forwarded': false,
    });
    // Several rules can fail at once, so the engine names none, and neither does the span.
    expect(span.attributes).not.toHaveProperty('mcp_policy.rule');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expectNoArgumentText();
  });

  it('describes a call to a hidden tool, which the client sees as not found', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    await expect(
      gate.callTool(
        WRITER,
        { server: 'docs', tool: 'publish', args: { id: SECRET } },
        async () => OK,
      ),
    ).rejects.toThrow('not found');
    const span = only('mcp_policy.tool_call');
    expect(span.attributes).toMatchObject({
      'mcp_policy.tool': 'publish',
      'mcp_policy.effect': 'deny',
      'mcp_policy.code': 'denied_by_rule',
      'mcp_policy.rule': 'writers-never-publish',
      'mcp_policy.forwarded': false,
    });
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    expectNoArgumentText();
  });

  it('leaves out the rule when no rule matched', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    await expect(
      gate.callTool(WRITER, { server: 'docs', tool: 'nothing', args: {} }, async () => OK),
    ).rejects.toThrow('not found');
    const span = only('mcp_policy.tool_call');
    expect(span.attributes['mcp_policy.code']).toBe('no_matching_rule');
    expect(span.attributes).not.toHaveProperty('mcp_policy.rule');
  });

  it('carries the final code of an approval', async () => {
    const gate = policyGate({
      policy: EXAMPLE,
      approver: fixedApprover(() => ({ approved: true })),
    });
    const manager: Caller = { identity: 'release-manager', session: 's2' };
    await gate.callTool(
      manager,
      { server: 'docs', tool: 'publish', args: { id: 'd1' } },
      async () => OK,
    );
    expect(only('mcp_policy.tool_call').attributes).toMatchObject({
      'mcp_policy.effect': 'allow',
      'mcp_policy.code': 'approved',
      'mcp_policy.rule': 'release-publish',
      'mcp_policy.forwarded': true,
    });
  });

  it('carries the final code of a refused approval', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    const manager: Caller = { identity: 'release-manager', session: 's2' };
    await gate.callTool(
      manager,
      { server: 'docs', tool: 'publish', args: { id: 'd1' } },
      async () => OK,
    );
    expect(only('mcp_policy.tool_call').attributes).toMatchObject({
      'mcp_policy.effect': 'deny',
      'mcp_policy.code': 'approval_denied',
      'mcp_policy.forwarded': false,
    });
  });

  it('marks the span as an error when the upstream call fails, without its message', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    const result = await gate.callTool(
      WRITER,
      { server: 'docs', tool: 'get_draft', args: { id: SECRET } },
      async () => {
        throw new Error(`upstream choked on ${SECRET}`);
      },
    );
    expect(result.isError).toBe(true);
    const span = only('mcp_policy.tool_call');
    expect(span.attributes).toMatchObject({
      'mcp_policy.effect': 'allow',
      'mcp_policy.forwarded': true,
    });
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message ?? '').not.toContain(SECRET);
    expect(span.events).toEqual([]);
    expectNoArgumentText();
  });

  it('does not mark an upstream tool error result as a failed call', async () => {
    const gate = policyGate({ policy: EXAMPLE });
    await gate.callTool(
      WRITER,
      { server: 'docs', tool: 'get_draft', args: { id: 'd9' } },
      async () => ({
        isError: true,
        content: [{ type: 'text', text: 'No draft d9' }],
      }),
    );
    expect(only('mcp_policy.tool_call').status.code).toBe(SpanStatusCode.UNSET);
  });

  it('records a refusal caused by a throw as internal_error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gate = policyGate({
      policy: EXAMPLE,
      clock: () => {
        throw new Error('clock broke');
      },
    });
    const result = await gate.callTool(
      WRITER,
      { server: 'docs', tool: 'list_drafts', args: {} },
      async () => OK,
    );
    expect(result.isError).toBe(true);
    expect(only('mcp_policy.tool_call').attributes).toMatchObject({
      'mcp_policy.effect': 'deny',
      'mcp_policy.code': 'internal_error',
      'mcp_policy.forwarded': false,
    });
  });

  it('records a call refused because the audit write failed as audit_failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const gate = policyGate({
      policy: EXAMPLE,
      audit: {
        write: () => {
          throw new Error('disk full');
        },
      },
    });
    await gate.callTool(WRITER, { server: 'docs', tool: 'list_drafts', args: {} }, async () => OK);
    expect(only('mcp_policy.tool_call').attributes).toMatchObject({
      'mcp_policy.effect': 'deny',
      'mcp_policy.code': 'audit_failed',
      'mcp_policy.forwarded': false,
    });
  });
});

describe('tool list spans', () => {
  it('counts the tools listed and hidden', () => {
    const gate = policyGate({ policy: EXAMPLE });
    const shown = gate.filterTools(WRITER, [
      tool('docs', 'list_drafts'),
      tool('docs', 'create_draft'),
      tool('docs', 'publish'),
      tool('docs', 'delete_draft'),
    ]);
    expect(shown).toHaveLength(2);
    const span = only('mcp_policy.tools_list');
    expect(span.attributes).toEqual({
      'mcp_policy.identity': 'writer',
      'mcp_policy.session': 's1',
      'mcp_policy.tools_listed': 2,
      'mcp_policy.tools_hidden': 2,
    });
    expect(spans().map((s) => s.name)).toEqual(['mcp_policy.tools_list']);
  });
});

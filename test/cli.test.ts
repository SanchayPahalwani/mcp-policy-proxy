import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { main } from '../src/cli.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));
const POLICY = `${EXAMPLES}policy.yaml`;
const OK = `${EXAMPLES}sessions/ok.jsonl`;
const VIOLATION = `${EXAMPLES}sessions/violation.jsonl`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  dirs.push(dir);
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, done) {
      text += String(chunk);
      done();
    },
  });
  return { stream, text: () => text };
}

async function run(argv: string[], env: NodeJS.ProcessEnv = {}) {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout: stdout.stream, stderr: stderr.stream, env });
  return { code, out: stdout.text(), err: stderr.text() };
}

describe('check', () => {
  it('exits 0 for a clean session file', async () => {
    const r = await run(['check', '--policy', POLICY, OK]);
    expect(r).toEqual({
      code: 0,
      out: 'no violations in 6 call(s) across 1 file(s)\n',
      err: '',
    });
  });

  it('exits 1 and prints one line per violation', async () => {
    const r = await run(['check', '--policy', POLICY, VIOLATION]);
    expect(r.code).toBe(1);
    const lines = r.out.trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain(`${VIOLATION}:2 writer docs.publish denied_by_rule`);
    expect(lines[3]).toBe('3 violation(s) in 5 call(s) across 1 file(s)');
    expect(r.err).toBe('');
  });

  it('checks every file given, with limits per file', async () => {
    const r = await run(['check', '--policy', POLICY, OK, VIOLATION]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('3 violation(s) in 11 call(s) across 2 file(s)');
  });

  it('prints JSON that parses', async () => {
    const r = await run(['check', '--policy', POLICY, '--format', 'json', VIOLATION]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out).violations).toHaveLength(3);
  });

  it('defaults to GitHub annotations under GitHub Actions and to text otherwise', async () => {
    const gh = await run(['check', '--policy', POLICY, VIOLATION], { GITHUB_ACTIONS: 'true' });
    expect(gh.out.startsWith(`::error file=${VIOLATION},line=2,title=Policy violation::`)).toBe(
      true,
    );
    const plain = await run(['check', '--policy', POLICY, VIOLATION], { GITHUB_ACTIONS: 'false' });
    expect(plain.out.startsWith(`${VIOLATION}:2 `)).toBe(true);
  });

  it('uses --identity for lines that name none', async () => {
    const path = temp('x.jsonl', '{"ts":1,"server":"docs","tool":"list_drafts"}\n');
    expect((await run(['check', '--policy', POLICY, path])).code).toBe(2);
    expect((await run(['check', '--policy', POLICY, '--identity', 'writer', path])).code).toBe(0);
  });

  it('exits 2 for a missing sessions file', async () => {
    const r = await run(['check', '--policy', POLICY, '/no/such/sessions.jsonl']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/^mcp-policy-proxy: .*no such file/);
    expect(r.out).toBe('');
  });

  it('exits 2 with file:line for a bad line', async () => {
    const path = temp(
      'bad.jsonl',
      '{"ts":1,"identity":"writer","server":"docs","tool":"x"}\nnope\n',
    );
    const r = await run(['check', '--policy', POLICY, path]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`mcp-policy-proxy: ${path}:2: line is not valid JSON\n`);
  });

  it('exits 2 for a policy that does not load, and for missing arguments', async () => {
    const bad = temp('policy.yaml', 'version: 2\nrules: []\n');
    expect((await run(['check', '--policy', bad, OK])).code).toBe(2);
    expect((await run(['check', OK])).code).toBe(2);
    expect((await run(['check', '--policy', POLICY])).code).toBe(2);
    expect((await run(['check', '--policy', POLICY, '--format', 'xml', OK])).code).toBe(2);
  });
});

describe('test', () => {
  it('exits 0 when every case passes', async () => {
    const r = await run(['test', `${EXAMPLES}policy.test.yaml`]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\d+ policy test\(s\) passed\n$/);
  });

  it('exits 1 for a failing case and names it', async () => {
    const path = temp(
      'fail.test.yaml',
      `policy: ${POLICY}
cases:
  - name: writer publishing should be allowed
    call: { identity: writer, server: docs, tool: publish }
    expect: allow
`,
    );
    const r = await run(['test', path]);
    expect(r.code).toBe(1);
    expect(r.out).toContain(`${path}: writer publishing should be allowed:`);
    expect(r.out).toContain('1 of 1 policy test(s) failed');
  });

  it('notes a test file with no cases, without changing the exit code', async () => {
    const empty = temp('empty.test.yaml', `policy: ${POLICY}\ncases: []\n`);
    const r = await run(['test', empty, `${EXAMPLES}policy.test.yaml`]);
    expect(r.code).toBe(0);
    expect(r.err).toBe(`note: ${empty}: no cases\n`);
  });

  it('heads an invalid test file as a policy test file', async () => {
    const bad = temp('bad.test.yaml', `policy: ${POLICY}\ncases: [{ name: x }]\n`);
    const r = await run(['test', bad]);
    expect(r.code).toBe(2);
    expect(r.err.split('\n')[0]).toBe(`mcp-policy-proxy: Invalid policy test file ${bad}:`);
  });

  it('takes the policy from --policy and exits 2 for an unreadable test file', async () => {
    const path = temp(
      't.test.yaml',
      'cases:\n  - name: x\n    visible: { identity: writer, server: docs, tool: create_draft }\n    expect: true\n',
    );
    expect((await run(['test', '--policy', POLICY, path])).code).toBe(0);
    expect((await run(['test', path])).code).toBe(2);
    expect((await run(['test'])).code).toBe(2);
    expect((await run(['test', '/no/such.test.yaml'])).code).toBe(2);
  });
});

describe('validate', () => {
  it('exits 0 with no findings for the example policy against the example config', async () => {
    const r = await run([
      'validate',
      '--policy',
      POLICY,
      '--config',
      `${EXAMPLES}proxy.config.yaml`,
    ]);
    expect(r).toEqual({ code: 0, out: '0 error(s), 0 warning(s)\n', err: '' });
  });

  it('exits 0 and warns about rules for servers the config leaves out', async () => {
    const example = parse(readFileSync(`${EXAMPLES}proxy.config.yaml`, 'utf8'));
    delete example.upstreams.web;
    delete example.upstreams.mail;
    const config = temp('proxy.config.yaml', stringify(example));
    const r = await run(['validate', '--policy', POLICY, '--config', config]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      'warning: rule "fetch-docs-site": server "web" is not in the configuration',
    );
    expect(r.out.trimEnd().split('\n').at(-1)).toMatch(/^0 error\(s\), 2 warning\(s\)$/);
  });

  it('exits 0 with no config and no findings, noting what was not checked', async () => {
    const r = await run(['validate', '--policy', POLICY]);
    expect(r).toEqual({
      code: 0,
      out: '0 error(s), 0 warning(s)\n',
      err: 'note: no --config given, so identity and server names were not checked\n',
    });
  });

  it('exits 1 for a policy that constrains a redacted key', async () => {
    const path = temp(
      'p.yaml',
      `version: 1
rules:
  - id: by-token
    identities: [writer]
    server: docs
    tools: [create_draft]
    effect: allow
    when:
      - { arg: token, equals: abc }
`,
    );
    const r = await run(['validate', '--policy', path]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('error: rule "by-token": constraint on "token" uses a redacted key');
  });

  it('exits 1 when the policy does not parse and when the config is invalid', async () => {
    const bad = temp('bad.yaml', 'version: 2\nrules: []\n');
    const r = await run(['validate', '--policy', bad]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/^mcp-policy-proxy: Invalid policy:/);
    for (const text of ['listen: [', 'listen: { transport: carrier-pigeon }\n']) {
      const config = temp('proxy.config.yaml', text);
      const invalid = await run(['validate', '--policy', POLICY, '--config', config]);
      expect(invalid.code).toBe(1);
      expect(invalid.err).toMatch(/^mcp-policy-proxy: (Cannot read|Invalid) config/);
    }
  });

  it('exits 2 for a policy or config file that cannot be read', async () => {
    expect((await run(['validate', '--policy', '/no/such.yaml'])).code).toBe(2);
    expect((await run(['validate'])).code).toBe(2);
    const noConfig = await run(['validate', '--policy', POLICY, '--config', '/no/config.yaml']);
    expect(noConfig.code).toBe(2);
    expect(noConfig.err).toContain('/no/config.yaml');
    expect(noConfig.out).toBe('');
  });
});

describe('explain', () => {
  const explain = (identity: string, tool: string, extra: string[] = []) =>
    run(['explain', '--policy', POLICY, '--identity', identity, '--tool', tool, ...extra]);

  it('prints a denial with the rule and reason', async () => {
    const r = await explain('writer', 'docs__publish');
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      [
        'effect: deny',
        'code: denied_by_rule',
        'rule: writers-never-publish',
        'reason: rule "writers-never-publish" denies docs.publish for "writer": Publishing needs a release manager.',
        'visible: false',
        '',
      ].join('\n'),
    );
  });

  it('prints an allow, and "-" for an unset rule', async () => {
    const allowed = await explain('writer', 'docs__create_draft');
    expect(allowed.out).toBe(
      'effect: allow\ncode: allowed\nrule: writer-drafts\nreason: allowed by rule "writer-drafts"\nvisible: true\n',
    );
    const none = await explain('writer', 'docs__delete_draft');
    expect(none.out).toBe(
      'effect: deny\ncode: no_matching_rule\nrule: -\nreason: no rule allows "writer" to call docs.delete_draft\nvisible: false\n',
    );
  });

  it('applies --args', async () => {
    const r = await explain('writer', 'mail__send', ['--args', '{"to":"x@evil.test"}']);
    expect(r.out).toContain('code: constraint_failed');
    expect(r.out).toContain('visible: true');
  });

  it('exits 2 for a bad tool name, bad --args or a missing option', async () => {
    expect((await explain('writer', 'publish')).code).toBe(2);
    expect((await explain('writer', 'docs__publish', ['--args', '{nope'])).code).toBe(2);
    expect((await explain('writer', 'docs__publish', ['--args', '[1]'])).code).toBe(2);
    expect((await run(['explain', '--policy', POLICY, '--tool', 'docs__publish'])).code).toBe(2);
  });
});

describe('unexpected arguments and help', () => {
  it('rejects extra positionals in validate and explain', async () => {
    const bad = temp('bad.yaml', 'version: 2\nrules: []\n');
    const v = await run(['validate', '--policy', POLICY, bad]);
    expect(v.code).toBe(2);
    expect(v.out).toBe('');
    const e = await run([
      'explain',
      '--policy',
      POLICY,
      '--identity',
      'writer',
      '--tool',
      'docs__publish',
      'extra',
    ]);
    expect(e.code).toBe(2);
  });

  it('does not read -h or --help as help after "--" or as an option value', async () => {
    const bad = temp('bad.jsonl', 'nope\n');
    const afterDashes = await run(['check', '--policy', POLICY, '--', bad, '-h']);
    expect(afterDashes.code).toBe(2);
    expect(afterDashes.err).toContain(`${bad}:1:`);
    const asValue = await run(['check', '--policy', POLICY, '--identity', '-h', OK]);
    expect(asValue.out).not.toContain('usage:');
    expect(asValue.code).not.toBe(0);
    const test = await run(['test', '--policy', POLICY, '--', '--help']);
    expect(test.code).toBe(2);
    expect(test.out).toBe('');
  });

  it('prints usage to stdout and exits 0 for --help or -h as an option', async () => {
    for (const argv of [
      ['--help'],
      ['serve', '--help'],
      ['serve', '-h'],
      ['-h'],
      ['check', '--help'],
      ['check', '-h'],
      ['validate', '--policy', POLICY, '--help'],
    ]) {
      const r = await run(argv);
      expect(r.code).toBe(0);
      expect(r.out).toContain('usage: mcp-policy-proxy serve');
      expect(r.err).toBe('');
    }
  });

  it('notes a sessions file with no recorded calls, without changing the exit code', async () => {
    const path = temp('empty.jsonl', '{"type":"outcome","ts":1}\n');
    const r = await run(['check', '--policy', POLICY, path]);
    expect(r.code).toBe(0);
    expect(r.err).toBe(`note: ${path}: no recorded calls\n`);
  });

  it('exits 2 for a decision line the reader does not recognise', async () => {
    const path = temp('odd.jsonl', '{"type":"Decision","ts":1,"forwarded":true}\n');
    const r = await run(['check', '--policy', POLICY, path]);
    expect(r.code).toBe(2);
    expect(r.err).toContain(`${path}:1: unknown event type`);
  });
});

describe('main', () => {
  it('lists all five commands in the usage text', async () => {
    const r = await run([]);
    expect(r.code).toBe(2);
    for (const command of ['serve', 'check', 'test', 'validate', 'explain']) {
      expect(r.err).toContain(`mcp-policy-proxy ${command} `);
    }
  });
});

# mcp-policy-proxy

A system prompt can ask an agent never to publish, delete or email an outsider,
but it cannot make the agent comply: text the agent reads along the way can talk
it out of the request. This proxy sits between an MCP client and its MCP servers
and decides every tool call in code: may this identity call this tool, with these
arguments, given its limits? The rules come from one YAML policy file, and the
same file, run through the same engine, checks recorded agent sessions in CI, so
a rule holds in a live run and in an offline one. The motivating case is
[deploy-to-babou](https://github.com/SanchayPahalwani/deploy-to-babou), which
keeps a never-publish rule with a tool allowlist, a system prompt and a CI
assertion, and the CI assertion covers only offline runs. The check CI runs is
not a check that runs when a live call arrives, and an allowlist in one harness
governs which tools that agent is offered, with no identities, no argument
rules and no audit trail.

**Status:** Reference implementation. Not production software.

## Quick start

Needs Node 22 or later. After `npm install`, nothing here needs a model key or
any network beyond `127.0.0.1`.

```sh
npm install
npm run demo   # the proxy, three mock servers and a scripted approver, in one process
npm test
```

The demo prints eight steps: the filtered tool lists for two identities, a
draft created, a hidden tool called, an outside recipient refused, a limit
reached, an approved publish, the audit lines, and the offline check. Steps 3
to 5 look like this:

```
3. writer calls docs__publish, which a deny rule hides from it
   docs__publish -> protocol error -32602: Tool docs__publish not found

4. writer mails an address outside the team
   mail__send to someone@outside.test -> Denied by policy (constraint_failed): arguments rejected: rule "mail-team-only": to must equal "team@example.test"

5. writer mails the team three times (the rule allows 2 per session)
   mail 1 -> Sent to team@example.test
   mail 2 -> Sent to team@example.test
   mail 3 -> Denied by policy (limit_exceeded): rule "mail-team-only": limit of 2 calls per session reached
```

## The example policy

[`examples/policy.yaml`](examples/policy.yaml) is the policy the demo, the eval
and CI use. Two of its six rules:

```yaml
version: 1

rules:
  # Deny wins over every allow rule, so writers can never publish.
  - id: writers-never-publish
    identities: [writer]
    server: docs
    tools: [publish]
    effect: deny
    reason: Publishing needs a release manager.

  # Mail goes to the team address only: no other recipient, no cc, no bcc.
  - id: mail-team-only
    identities: [writer]
    server: mail
    tools: [send]
    effect: allow
    when:
      - arg: to
        equals: team@example.test
      - arg: cc
        absent: true
      - arg: bcc
        absent: true
    limits:
      per_session: 2
      per_minute: 2
```

How to read a policy:

- **Anything no rule allows is refused.** There is no default-allow setting.
  `delete_draft` appears in no rule, so nobody can call it.
- **A deny rule beats every allow rule, and rule order does not matter.** Each
  rule can be read on its own; adding an allow can never weaken a deny.
- **`server` and `tools` use the upstream's own names.** `tools` entries are
  globs where `*` is the only wildcard.
- **`when` constraints narrow an allow rule.** Operators: `equals`, `in`,
  `matches` (the whole string must match), `max_length`, `min`, `max`,
  `absent`. A missing argument fails unless the constraint says
  `optional: true`. A value whose parent on the path is not an object (say
  `to.address` when `to` is a string) fails even when optional. An empty array
  fails; a non-empty array passes only if every element passes. Deny rules take
  no constraints.
- **`limits` count forwarded calls** for each rule: per identity in a sliding
  minute, and per identity within one session. The limit of every rule that
  permits the call must hold; a rule whose constraints fail is dropped first,
  so its limit does not apply.
- **`effect: require_approval`** asks a human, out of band, before the call is
  forwarded. The `release-publish` rule does this for `release-manager`.

The full semantics, with the reasoning for each choice, are in
[`docs/design.md`](docs/design.md).

## Running the proxy

### The config file

The policy file holds rules only. Everything about one deployment lives in a
separate config file, [`examples/proxy.config.yaml`](examples/proxy.config.yaml):

```yaml
listen:
  { transport: http, host: 127.0.0.1, port: 8787, path: /mcp, session_header: x-agent-session }

identities:
  - { name: writer, token_env: WRITER_TOKEN }
  - { name: release-manager, token_env: RELEASE_MANAGER_TOKEN }

upstreams:
  docs: { transport: stdio, command: npx, args: [tsx, ../eval/servers/stdio.ts, docs] }
  web: { transport: stdio, command: npx, args: [tsx, ../eval/servers/stdio.ts, web] }
  mail: { transport: stdio, command: npx, args: [tsx, ../eval/servers/stdio.ts, mail] }

policy: ./policy.yaml
audit: { path: ./audit.jsonl }
approval: { type: cli, timeout_seconds: 55 }
```

- `identities` maps bearer tokens to identity names, by environment variable
  (`token_env`) or by SHA-256 digest (`token_sha256`). No token is ever written
  in the file.
- `upstreams` are stdio commands or Streamable HTTP URLs. The proxy connects to
  them with its own credentials (`pass_env`, `headers_env`; header values must
  be visible ASCII, spaces or tabs); the agent's token is never forwarded.
- `listen.host` must be a loopback address unless
  `listen.allow_non_loopback: true` is set, and then TLS belongs in front.
- `approval` is `cli` (a prompt on the proxy's terminal, HTTP only), `webhook`
  (a signed `POST`) or `deny`, the default. A webhook URL must be `https:`
  unless it is on `127.0.0.1`, `localhost` or `::1`: its answer is trusted on
  the strength of TLS alone, since answers are not signed. Relative paths are
  read from the config file's directory.

### Starting it

```sh
export WRITER_TOKEN=$(node -p "require('node:crypto').randomBytes(24).toString('base64url')")
export RELEASE_MANAGER_TOKEN=$(node -p "require('node:crypto').randomBytes(24).toString('base64url')")
npm run cli -- serve --config examples/proxy.config.yaml
```

It prints `listening on http://127.0.0.1:8787/mcp` and writes one JSON line per
listing, decision and outcome to `examples/audit.jsonl`. When `release-manager`
calls `docs__publish`, the terminal shows the call and a 4-character code;
typing the code approves it, anything else refuses it, and no answer within the
timeout refuses it too.

`npm run build` then `node dist/cli.js` runs the same CLI without `tsx`;
`npm run cli -- --help` lists every command.

### Connecting a client

Any MCP client that can send headers works unchanged. With the TypeScript SDK:

```ts
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'my-agent', version: '1.0.0' },
  { versionNegotiation: { mode: 'auto' } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:8787/mcp'), {
    requestInit: {
      headers: {
        authorization: `Bearer ${process.env.WRITER_TOKEN}`,
        'x-agent-session': 'run-42', // names the session that per_session limits count
      },
    },
  }),
);
const { tools } = await client.listTools(); // only what the policy could allow: mail__send, ...
await client.callTool({
  name: 'mail__send',
  arguments: { to: 'team@example.test', subject: 'Draft ready', body: 'See d1.' },
});
```

Tools are exposed as `<server>__<tool>`. A call to a tool the caller cannot see
gets the same `Tool <name> not found` error as a tool that does not exist; a
visible tool refused for its arguments, a limit or an approval returns a tool
result with `isError: true` and the reason. The proxy can also serve one agent
over stdio, with the identity fixed by `stdio_identity` in the config.

### Running it: two starts per stdio upstream

The proxy connects to each upstream with the SDK's automatic version
negotiation. For a stdio upstream that means the SDK starts the upstream command
twice at connect: a throwaway probe, then the real connection. A stdio server
that does something at startup (opens a file, logs in) does it twice.

## Checking recorded sessions in CI

The offline commands read the same policy file and run the same engine:

```sh
npm run cli -- validate --policy examples/policy.yaml --config examples/proxy.config.yaml
npm run cli -- test examples/policy.test.yaml
npm run cli -- check --policy examples/policy.yaml examples/sessions/violation.jsonl
npm run cli -- explain --policy examples/policy.yaml --identity writer --tool docs__publish --args '{"id":"d1"}'
```

- `validate` checks the schema and lints the policy (constraints on or under
  redacted keys, identities or servers missing from the config). Without
  `--config` it says on stderr that identity and server names were not checked.
- `test` runs [policy test files](examples/policy.test.yaml): example calls with
  the decision each must get, visibility expectations and call sequences for
  limits.
- `check` reads recorded sessions, one JSON line per call that ran:
  `{"ts": "2026-01-15T10:00:30Z", "session": "s1", "identity": "writer", "server": "docs", "tool": "publish", "args": {"id": "d1"}}`,
  or the proxy's own audit log. It replays them through the engine in time
  order and exits `0` when every call was allowed, `1` on violations and `2` on
  input it cannot read. Limits are replayed per proxy run, as the live proxy
  counts them: every audit line carries the `run` id of the process that wrote
  it, so a log appended across restarts, or several stdio launches, starts each
  run's counters empty. Lines without a `run` (plain session records) count as
  one run per file. Over `examples/sessions/violation.jsonl` it prints:

  ```
  examples/sessions/violation.jsonl:2 writer docs.publish denied_by_rule: rule "writers-never-publish" denies docs.publish for "writer": Publishing needs a release manager.
  examples/sessions/violation.jsonl:3 writer mail.send constraint_failed: arguments rejected: rule "mail-team-only": to must equal "team@example.test"
  examples/sessions/violation.jsonl:5 writer docs.delete_draft no_matching_rule: no rule allows "writer" to call docs.delete_draft
  3 violation(s) in 5 call(s) across 1 file(s)
  ```

- `explain` prints the decision and reason for one call.

[`action.yml`](action.yml) wraps `validate`, `test` and `check` as a composite
GitHub Action that builds the checker from source. Inside a workflow, `check`
reports violations as annotations on the session file's lines.

```yaml
name: agent policy
on: [push, pull_request]

jobs:
  policy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # This repository is not published yet: put its location and a tag or commit here.
      - uses: <owner>/mcp-policy-proxy@<ref>
        with:
          policy: policy/agents.yaml
          tests: policy/agents.test.yaml
          sessions: |
            recordings/release-*.jsonl
            audit/**/*.jsonl
```

This repository's own [CI](.github/workflows/ci.yml) runs the Action on the
example policy, checks that `examples/sessions/violation.jsonl` fails with 3
violations, and replays the eval transcripts.

## Results

The eval runs five benign tasks, clean and with each of twelve planted
injections (six goals, two phrasings each), against three mock servers: 65
scenarios per condition. The baseline runs the same proxy with its policy gate
swapped for one that forwards every call and writes no audit, so what reaches
the servers is what a direct connection would deliver.

### scripted-obedient-v1 (synthetic)

Synthetic: the scripted stand-in, not a language model. It obeys every injected
instruction, so its baseline attack rate is 100% by construction.

| condition                 | forbidden calls that reached a server | injected runs with a forbidden call | benign tasks completed, clean runs | benign tasks completed, injected runs |
| ------------------------- | ------------------------------------- | ----------------------------------- | ---------------------------------- | ------------------------------------- |
| baseline (no enforcement) | 108                                   | 60 / 60                             | 5 / 5                              | 54 / 60                               |
| enforced                  | 0                                     | 0 / 60                              | 5 / 5                              | 60 / 60                               |

The baseline row is what an always-obedient agent does, not how often a real
model follows an injection. Its 108 forbidden calls are 50 calls toward the
five goals other than overuse (10 each), plus 58 web fetches past the tenth in
a run, which the overuse goal counts whether the injection or the task asked
for them.

Two things are measured: which forbidden calls reached the mock servers with
enforcement on (counted from the servers' own ledgers, by predicates written
separately from the policy), and whether the benign tasks still complete under
the example policy. Both are synthetic too, since the agent is scripted, and no
live model has been recorded yet. The injections and the policy were written by
the same author, so 0 / 60 shows that the engine enforces the policy, not that
the policy is complete.

In one run on one machine over local loopback, the proxy added 0.26 ms per
call at p50. Repeat runs differ by a few tenths of a millisecond, the same size
as the number.

`npm run eval:report` regenerates the tables from the committed transcripts,
and `npm run eval:replay -- --check` is what CI runs: it replays them and fails
if a result or the table differs. The per-goal table, the overhead block, and
the command and commit of the last report are in
[`docs/results.md`](docs/results.md).

## What it stops and what it does not

It stops, for the identities and tools the policy covers:

- calls to a tool an identity must never use (default deny and deny rules),
  including tools the agent was never shown;
- allowed tools called with abusive arguments (another recipient, an outside
  URL, an added `cc`);
- allowed tools called too often (per-minute and per-session limits);
- actions that need a human, which wait for an approval the agent cannot give
  itself.

### Known limits

- **Data can leave through an allowed tool.** If the agent may mail the team,
  injected text can make it paste a secret into a mail to the team.
- **A compromised upstream server is trusted** with whatever it is sent, and
  its tool descriptions reach the model unchanged.
- **Model output is not examined.** The proxy never looks at what the model
  writes back.
- **Traffic that bypasses the proxy is not governed.** The proxy has to be the
  agent's only route to its servers.
- **Per-session limits trust the harness** to name sessions honestly; the
  per-minute limit does not depend on it.
- **Approval can be careless.** A human who approves everything is an allow
  rule; the proxy cannot tell.

## How it differs from prior art

Default-deny rules, argument constraints and filtered tool lists already exist
in other projects, surveyed in [`docs/prior-art.md`](docs/prior-art.md), so the
runtime half of this repo is not new. What this repo adds is running the same
engine over recorded sessions in CI, and a with/without measurement that anyone
can reproduce from the repository without a model key. If you need a gateway in
production today, look at the large gateways listed there.

## Limits of this implementation and what production would add

This is one process with limit counters in memory, static bearer tokens, a
synchronous approval webhook, a policy loaded once at startup, and tools only
(resources and prompts are not proxied, so they are not exposed). Production
would add shared limit state across replicas and a monotonic clock for the
limiter, versioned policy distribution with hot reload, a latency budget, a
tamper-evident audit log, approvals that survive a restart, OAuth through the
existing authenticator interface, and pinning of tool descriptions.
[`docs/design.md`](docs/design.md) gives the reasoning behind every design call,
these limits included, and the questions a reviewer is likely to ask about
them.

## Development

```sh
npm run typecheck
npm run format:check
npm test
npm run build
npm run eval                       # scripted model over every scenario; prints the table, writes nothing
npm run eval:replay -- --check     # what CI runs: replay the committed transcripts and compare
npm run eval:report                # replay and rewrite the tables in docs/results.md
npm run bench                      # measure the proxy's added latency and rewrite its block
```

Recording a live model needs a key and is billed to it; see
[`docs/results.md`](docs/results.md#recording-a-live-model).

- `src/policy/` is the engine: schema, constraints, limits, `decide`. It
  imports nothing from the proxy.
- `src/proxy/`, `src/approval/`, `src/audit/` are the live proxy.
- `src/check/` and `src/cli/` are the offline checker and the CLI.
- `eval/` holds the mock servers, the injection suite and the agent loop;
  `scripts/` the benchmark and the demo; `examples/` the policy, config,
  policy tests and sessions.

To read the code, start with [`docs/walkthrough.md`](docs/walkthrough.md), a
30-minute guided read of one call through it.

## License

[Apache-2.0](LICENSE).

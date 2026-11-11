# Prior art

Surveyed on 2026-11-12. Everything below comes from each project's own README or
docs page as read on that date. Where a page did not state something, the table
says "not stated" rather than guessing. Star counts are the numbers shown that
day and only indicate rough adoption.

## Short version

Putting a policy check in front of MCP tool calls is not new. At least two small
open-source projects (`mcp-policy-gateway`, MCP Seatbelt) already do default-deny
rules with argument constraints, and several large gateways (agentgateway, IBM
ContextForge, Docker MCP Gateway) do authorization as one feature among many.

No project read for this survey covers all of this repo's v1 scope. The parts
that exist elsewhere are the runtime ones: rules, argument constraints, filtered
tool lists, rate limits, audit logs. The parts not found together anywhere are:

1. running **the same engine over recorded sessions** as a CI gate, so a rule
   holds both in a live run and in an offline one, and
2. a **measured with/without table** for injected instructions, produced by a
   script in the repo and replayable without a model key.

So this repo is a small, readable reference whose runtime half overlaps with
existing work, plus those two additions. It is not a replacement for a gateway
you would run in production. If you need one today, start with agentgateway.

## Small policy proxies (closest in scope)

|                           | mcp-policy-gateway                                                                  | MCP Seatbelt                                                                       | AgentGate                                                         | this repo                                                             |
| ------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------- |
| Source                    | [Spuddy10345/mcp-policy-gateway](https://github.com/Spuddy10345/mcp-policy-gateway) | [kryptosai/mcp-seatbelt](https://github.com/kryptosai/mcp-seatbelt)                | [chidhvilasa/agentgate](https://github.com/chidhvilasa/agentgate) |                                                                       |
| Language, license         | Python, Apache-2.0                                                                  | npm package, MIT                                                                   | TypeScript, Apache-2.0                                            | TypeScript, Apache-2.0                                                |
| Stars that day            | 0                                                                                   | 3                                                                                  | not stated                                                        | n/a                                                                   |
| Upstream transports       | stdio, Streamable HTTP                                                              | not stated                                                                         | stdio only                                                        | stdio, Streamable HTTP                                                |
| Several upstreams         | yes                                                                                 | yes, by URL path                                                                   | yes                                                               | yes, namespaced tool names                                            |
| Identity                  | bearer token per request (HTTP), fixed at launch (stdio)                            | "per-agent" RBAC; how identity is established is not stated                        | none for agents                                                   | bearer token per request (HTTP), fixed at launch (stdio)              |
| Policy                    | YAML, default deny, first match wins                                                | YAML; modes default-deny, allowlist, audit; starts in audit mode                   | YAML, default deny, first match wins                              | YAML, default deny only, deny overrides allow (order does not matter) |
| Argument constraints      | yes (`when:` blocks)                                                                | yes (patterns, JSON Schema)                                                        | path, command, host matching                                      | yes (`when:` list, fail closed on missing values)                     |
| Require approval          | not stated                                                                          | not stated                                                                         | yes                                                               | yes (CLI prompt, webhook)                                             |
| Limits                    | token buckets                                                                       | per minute                                                                         | not stated                                                        | per minute and per session                                            |
| Filtered tool list        | yes                                                                                 | not stated                                                                         | quarantined tools hidden                                          | yes                                                                   |
| Audit                     | JSONL, hash-chained                                                                 | signed log                                                                         | SQLite, hash-chained                                              | JSONL plus OpenTelemetry spans                                        |
| Offline use of the policy | `validate`, `explain`, dry-run                                                      | policy test files, `simulate`, `fuzz`, a GitHub Action that simulates sample calls | `replay` of one past event                                        | `check` over recorded sessions, policy test files, GitHub Action      |
| Injection numbers         | none ("not a prompt-injection detector")                                            | none (latency numbers only)                                                        | none                                                              | with/without table from a script                                      |

Notes on these three:

- **mcp-policy-gateway** is the closest match for the runtime behaviour: default
  deny, argument rules, hiding tools the policy can never permit while still
  checking every call, denials returned as tool results. This repo makes the
  same choices on filtering and denial format and says so in the design doc. It
  differs in rule evaluation (deny-overrides instead of first-match), in having
  an approval effect, and in the offline checker and the eval.
- **MCP Seatbelt** has the most offline tooling of the three (policy tests,
  simulation, fuzzing, a GitHub Action). Its Action simulates representative
  calls you write down; it does not replay what an agent actually did in a
  recorded run. Its feature list is long (honeytokens, DLP, attack-chain
  detection) and self-reported on a small repo.
- **AgentGate** has approvals and tool-definition pinning but is stdio only and
  has no agent identity.

## Large gateways

|                                                                                               | What it is                                                            | Authorization                                                                                                                                                                         | Size signal                                     |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [agentgateway](https://github.com/agentgateway/agentgateway) (Apache-2.0, 6.1k stars)         | Rust proxy for agent-to-tool, agent-to-LLM and agent-to-agent traffic | CEL policies; JWT, API key, OAuth identity; rate limiting; OpenTelemetry. Version 1.3 added `mcpGuardrails`, a hook that sends each MCP method call to an external gRPC policy server | Data plane plus Kubernetes controller and UI    |
| [IBM ContextForge](https://github.com/IBM/mcp-context-forge) (Apache-2.0, 4.8k stars)         | Python registry and gateway that federates MCP, A2A and REST          | RBAC (format not stated), JWT and SSO identity, rate limiting, OpenTelemetry                                                                                                          | 40+ plugins, admin UI, Postgres and Redis stack |
| [Docker MCP Gateway](https://github.com/docker/mcp-gateway) (MIT, 1.6k stars)                 | Go CLI plugin that runs MCP servers in containers behind one gateway  | Per-profile tool allowlists; no policy language; agent identity not stated                                                                                                            | Container lifecycle, catalog, secrets           |
| [GitHub Agentic Workflows MCP Gateway](https://github.com/github/gh-aw-mcpg) (MIT, 188 stars) | Go gateway for sandboxed agents in GitHub workflows                   | Guard policies on repository and integrity level, per-session tool call limits, OTLP tracing                                                                                          | WASM guard runtime, GitHub API proxy            |

None of the four pages describes a command that checks recorded sessions
against the policy in CI, policy test files, or published injection numbers.
They solve a larger problem (running and federating many servers for many
teams) and policy is one layer of it.

## Guardrail libraries and scanners

- **[Microsoft Agent Governance Toolkit](https://github.com/microsoft/agent-governance-toolkit)**
  (MIT, 6.6k stars). An in-process library: you wrap a tool with `govern()` and
  a YAML policy decides allow, deny or `require_approval`. It has `lint-policy`
  and red-team commands. Being in-process, it protects agents that adopt the
  SDK; a proxy protects any MCP client without code changes, at the cost of
  seeing only MCP traffic. Its README example sets `default_action: allow`.
- **[Invariant Gateway](https://github.com/invariantlabs-ai/invariant-gateway)**
  (Apache-2.0, 83 stars). Mainly a proxy in front of LLM provider APIs that
  records traces and applies guardrail rules; it can also proxy MCP.
- **[Lasso MCP Gateway](https://github.com/lasso-security/mcp-gateway)** (MIT,
  403 stars) and **[Enkrypt AI Secure MCP Gateway](https://github.com/enkryptai/secure-mcp-gateway)**
  (Apache-2.0, 59 stars). Plugin-based gateways focused on content scanning
  (secrets, PII, injection detection through a hosted API). Content scanning is
  a different control from this repo's: it tries to recognise bad text, while a
  policy proxy does not look at text at all and only decides which calls may
  happen.

## Research this design leans on

- **AgentDojo** (Debenedetti et al., 2024, [arXiv:2406.13352](https://arxiv.org/abs/2406.13352)):
  a benchmark of 97 tasks and 629 security test cases for agents that read
  untrusted tool output. Its results page reports "Utility", "Utility under
  attack" and "Targeted ASR". This repo's eval reports the same kind of pair
  (does the benign task still complete, did the injected goal happen) on a much
  smaller, purpose-built suite. It is not an AgentDojo result and the numbers
  are not comparable.
- **Progent** ([arXiv:2504.11703](https://arxiv.org/abs/2504.11703)): privilege
  control for agents with deterministic rules over tool names and arguments,
  evaluated on AgentDojo. The same idea as this repo's engine, with a richer
  policy language and policies that can be updated during a run.
- **CaMeL** ([arXiv:2503.18813](https://arxiv.org/abs/2503.18813)): separates
  control flow from untrusted data so injected text cannot change which tools
  run, and tracks where data came from. It addresses the case this repo
  explicitly does not: data leaving through a tool the policy allows.

## Seen in search results but not read

These came up in search on 2026-11-12 but their pages could not be fetched
(404, expired certificate, or bot challenge), so they are not compared here:
PolicyLayer Intercept, Arbitus, PortunusMCP, protect-mcp (ScopeBlind), Warden
MCP Gateway. If one of them already does offline session checks or publishes
injection numbers, the "short version" above needs correcting.

## One concrete upstream contribution

agentgateway 1.3 exposes `mcpGuardrails`, which calls an external policy server
for each `tools/call` and `tools/list`. A useful contribution would be a small
example policy server for that hook that loads this repo's policy file format
and answers with this repo's engine, added to agentgateway's examples with a
short guide. It would give agentgateway users a default-deny YAML policy with an
offline `check` command, and it would test whether this engine's interface
(`decide(call, state) -> decision`) is general enough to sit behind someone
else's enforcement point. Before starting, open an issue there to confirm the
maintainers want examples of that kind.

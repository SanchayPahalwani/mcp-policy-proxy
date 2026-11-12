# Walkthrough: one call through the code

A guided read of about 30 minutes. It follows one call, the `writer` agent
calling `mail__send` to an address outside the team, from the HTTP request to
the refusal the agent reads, then the same call to the team address as it is
allowed, forwarded and logged, and finally the logged record going back through
the offline checker.

Each stop says what to read, what to notice, and asks one question. Answers are
at the end. Links point at the lines as they are at the commit that added this
file; if a link lands a few lines off, the function names in the text still
hold. [`docs/design.md`](design.md) explains why each piece is shaped the way
it is.

Run `npm run demo` first: steps 4 and 5 of its output are this walkthrough's
two calls.

## The call

The agent sends `tools/call` with name `mail__send` and arguments
`{"to": "someone@outside.test", "subject": "Notes", "body": "Draft d1 is ready."}`,
with `Authorization: Bearer <writer's token>` and `x-agent-session: demo-writer`.

The rule that will decide it is in the example policy,
[examples/policy.yaml:53-68](../examples/policy.yaml#L53-L68): `writer` may call
`send` on the `mail` server only with `to` equal to `team@example.test`, no
`cc`, no `bcc`, at most two calls per session and two per minute.

## Part 1: the refused call

### Stop 1. HTTP entry and authentication (3 min)

Read [src/proxy/http.ts:77-103](../src/proxy/http.ts#L77-L103), the `handle`
function, then [src/proxy/auth.ts:60-71](../src/proxy/auth.ts#L60-L71).

Notice:

- The order: path check ([line 78](../src/proxy/http.ts#L78)), Host and Origin
  guards against DNS rebinding ([line 82](../src/proxy/http.ts#L82), set up at
  [lines 54-56](../src/proxy/http.ts#L54-L56) only for loopback binds), then the
  token ([line 84](../src/proxy/http.ts#L84)). Nothing reaches the MCP layer
  without an identity.
- `authenticate` hashes the presented token and compares it with every
  configured digest in constant time, and keeps looping after a match
  ([auth.ts:67-69](../src/proxy/auth.ts#L67-L69)).
- The session is the `x-agent-session` header or `default`, and must match
  `SESSION_ID` ([line 27](../src/proxy/http.ts#L27),
  [lines 89-93](../src/proxy/http.ts#L89-L93)).
- What is handed to the SDK ([lines 96-101](../src/proxy/http.ts#L96-L101)) is
  the identity name and the session. The `token` field is an empty string.

**Question 1.** Why is `token` set to `''` instead of the bearer token the
agent sent?

### Stop 2. A server per request, and splitting the name (3 min)

Read the factory at [src/proxy/http.ts:58-68](../src/proxy/http.ts#L58-L68),
then [src/proxy/server.ts:19-46](../src/proxy/server.ts#L19-L46), then
`splitName` at [src/policy/names.ts:11-18](../src/policy/names.ts#L11-L18).

Notice:

- `createMcpHandler` calls the factory once per HTTP request, and
  `buildServer` binds the new server to one caller (identity and session). The
  2026-07-28 protocol revision is stateless, so there is nothing else to keep.
- The `tools/call` handler ([server.ts:31-43](../src/proxy/server.ts#L31-L43))
  splits `mail__send` at the first `__` into server `mail` and tool `send`.
  Server names cannot contain `_`, so the split is unambiguous.
- A name that cannot be routed is refused with `toolNotFound`
  ([server.ts:35](../src/proxy/server.ts#L35)) before the gate sees it.
- `forward` is a closure ([server.ts:40](../src/proxy/server.ts#L40)): the gate
  decides whether to call it, but cannot change where it goes. The request's
  abort signal travels with it ([server.ts:41](../src/proxy/server.ts#L41)).

**Question 2.** An agent calls `mail_send` (one underscore). What does it get
back, and is there a line in the audit log?

### Stop 3. The gate builds the call (2 min)

Read `callTool` at
[src/proxy/policy-gate.ts:286-307](../src/proxy/policy-gate.ts#L286-L307), then
`gatedCall` at
[src/proxy/policy-gate.ts:225-270](../src/proxy/policy-gate.ts#L225-L270).

Notice:

- Every call runs inside one OpenTelemetry span, whose closing fields are read
  only after the call has settled
  ([lines 297-305](../src/proxy/policy-gate.ts#L297-L305)).
- The `Call` the engine sees ([line 239](../src/proxy/policy-gate.ts#L239)) is
  identity, session, server, tool, arguments and a time from the gate's clock.
  Nothing else about the request reaches the policy.
- `decide` runs at [line 240](../src/proxy/policy-gate.ts#L240). This call does
  not need approval, so it goes straight to `admit`
  ([line 252](../src/proxy/policy-gate.ts#L252)).
- The whole block is in a `try` whose `catch`
  ([lines 256-262](../src/proxy/policy-gate.ts#L256-L262)) refuses with
  `internal_error`: an exception can never become an allow.

**Question 3.** Why does the time on the call come from the gate's clock and
not from anything in the request?

### Stop 4. The engine decides (4 min)

Read `decide` at [src/policy/engine.ts:65-144](../src/policy/engine.ts#L65-L144).
It is the heart of the project; read it slowly.

Notice the five steps, in order:

1. A deny rule matching identity, server and tool wins outright
   ([lines 83-92](../src/policy/engine.ts#L83-L92)). None matches `writer`,
   `mail`, `send`.
2. With no permitting rule the call is denied and the tool is hidden
   ([lines 95-102](../src/policy/engine.ts#L95-L102)). Here one rule,
   `mail-team-only`, is a candidate.
3. Each candidate's constraints are tested; a rule whose constraint fails is
   dropped, not fatal ([lines 105-114](../src/policy/engine.ts#L105-L114)).
   `mail-team-only` fails on `to`, nothing is kept, and the result is
   `constraint_failed` with `visible: true`.
4. Limits of the kept rules ([lines 117-120](../src/policy/engine.ts#L117-L120)),
   not reached for this call.
5. `require_approval` beats `allow`
   ([lines 123-143](../src/policy/engine.ts#L123-L143)).

`decide` changes nothing. Counting happens elsewhere, in `commit`
([lines 146-148](../src/policy/engine.ts#L146-L148)), and only for calls that
are forwarded.

**Question 4.** Suppose a second rule allowed `writer` to call `mail.send` with
no constraints at all. What would `decide` return for the outside address, and
what does that tell you about where "never" belongs in a policy?

### Stop 5. The constraint (3 min)

Read [src/policy/constraints.ts:121-141](../src/policy/constraints.ts#L121-L141)
(the `test` of an ordinary constraint), `lookup` at
[lines 26-36](../src/policy/constraints.ts#L26-L36), and the `equals` check at
[lines 61-65](../src/policy/constraints.ts#L61-L65). Glance at `absent`
([lines 110-120](../src/policy/constraints.ts#L110-L120)), which the `cc` and
`bcc` constraints use.

Notice:

- `lookup` returns one of three answers: found, missing, or malformed (a parent
  on the path is present but is not a plain object). Malformed fails whatever
  `optional` says.
- Arrays are checked element by element, and an empty array fails
  ([lines 131-138](../src/policy/constraints.ts#L131-L138)).
- The failure reason is built once, when the policy is compiled
  ([line 63](../src/policy/constraints.ts#L63)): `to must equal "team@example.test"`.

**Question 5.** What does the `to` constraint say about `{"to": []}`, about
`{"to": {"address": "team@example.test"}}`, and about
`{"to": ["team@example.test"]}`? What happens to the last one after the
constraint?

### Stop 6. The decision is recorded (3 min)

Back in the gate, read `admit` at
[src/proxy/policy-gate.ts:106-146](../src/proxy/policy-gate.ts#L106-L146), then
`refusal` and `decisionEvent` at
[src/proxy/audit-events.ts:63-115](../src/proxy/audit-events.ts#L63-L115), then
the file sink's `write` at [src/audit/log.ts:67-77](../src/audit/log.ts#L67-L77).

Notice:

- `refused` ([policy-gate.ts:118-122](../src/proxy/policy-gate.ts#L118-L122))
  is the reason this call will not be forwarded; for a deny it is the engine's
  own code and reason.
- The event is built from the decision with arguments redacted
  ([audit-events.ts:103](../src/proxy/audit-events.ts#L103)) and the policy's
  hash on it ([audit-events.ts:113](../src/proxy/audit-events.ts#L113)).
- A refusal is written with `record`
  ([policy-gate.ts:126](../src/proxy/policy-gate.ts#L126)), which only logs a
  failed write. A call about to be forwarded is written with `write`
  ([policy-gate.ts:131-141](../src/proxy/policy-gate.ts#L131-L141)), and a failed
  write refuses it with `audit_failed`.
- The sink writes synchronously and loops until the whole line is written
  ([log.ts:72-76](../src/audit/log.ts#L72-L76)).

The decision line for this call, spread over several lines here (in the file it
is one line). It has no `rule` field, because no single rule decided it:

```json
{
  "type": "decision",
  "ts": "…",
  "call_id": "…",
  "session": "demo-writer",
  "identity": "writer",
  "server": "mail",
  "tool": "send",
  "args": { "to": "someone@outside.test", "subject": "Notes", "body": "Draft d1 is ready." },
  "effect": "deny",
  "code": "constraint_failed",
  "reason": "arguments rejected: rule \"mail-team-only\": to must equal \"team@example.test\"",
  "visible": true,
  "forwarded": false,
  "policy_sha256": "…"
}
```

**Question 6.** Why may a refusal's audit write fail without changing the
answer, when an allow's may not?

### Stop 7. The agent reads the refusal (2 min)

Read [src/proxy/policy-gate.ts:263-267](../src/proxy/policy-gate.ts#L263-L267)
and `deniedResult` at [src/proxy/gate.ts:33-38](../src/proxy/gate.ts#L33-L38).

Notice:

- A visible tool refused for its arguments returns a normal tool result with
  `isError: true` and this text, which a model can read to correct the
  recipient:

  ```
  Denied by policy (constraint_failed): arguments rejected: rule "mail-team-only": to must equal "team@example.test"
  ```

- A hidden tool ([line 266](../src/proxy/policy-gate.ts#L266)) throws
  `toolNotFound` instead, which the agent sees as the JSON-RPC error `-32602`
  `Tool docs__publish not found`, exactly what a tool that does not exist
  gives.

**Question 7.** Why does a hidden tool answer with a protocol error while this
refusal answers with a readable result?

## Part 2: the same call, allowed

The agent now sends `to: "team@example.test"`. Stops 1 to 3 are the same.

### Stop 8. The engine allows, and the gate commits (3 min)

In `decide`, the constraints pass, `mail-team-only` is kept, its limits have
room (`exhaustion` at
[src/policy/engine.ts:50-63](../src/policy/engine.ts#L50-L63)), and the result
is `allow` with `applied: ["mail-team-only"]`
([lines 135-143](../src/policy/engine.ts#L135-L143)).

In `admit`, `refused` is undefined, so the event is written with `write`
([src/proxy/policy-gate.ts:131-141](../src/proxy/policy-gate.ts#L131-L141)) and
only then does `commit` record the call
([line 144](../src/proxy/policy-gate.ts#L144)). Read `record` in
[src/policy/limits.ts:29-51](../src/policy/limits.ts#L29-L51).

Notice:

- `admit` is synchronous: nothing can run between the limit check in `decide`
  and the count in `commit` (see the comment at
  [lines 104-105](../src/proxy/policy-gate.ts#L104-L105)).
- The per-minute window keeps timestamps per rule and identity; the session
  count is per rule within one identity and session; a session idle for an hour
  is dropped as a whole ([limits.ts:45-50](../src/policy/limits.ts#L45-L50)).
- `minuteCount` has no upper bound
  ([limits.ts:18-23](../src/policy/limits.ts#L18-L23)), so a clock that steps
  back still counts the earlier calls.

**Question 8.** The agent sends the same allowed mail two more times. On which
line is the third one refused, and which counters does that refusal change?

### Stop 9. Forward and record the outcome (3 min)

Read `forwardAndRecord` at
[src/proxy/policy-gate.ts:179-204](../src/proxy/policy-gate.ts#L179-L204), then
`Upstreams.callTool` at
[src/proxy/upstreams.ts:136-144](../src/proxy/upstreams.ts#L136-L144),
`outcomeEvent` at
[src/proxy/audit-events.ts:117-134](../src/proxy/audit-events.ts#L117-L134) and
`errorLabel` at
[src/proxy/audit-events.ts:141-151](../src/proxy/audit-events.ts#L141-L151).

Notice:

- The upstream is called with the proxy's own client; the agent's token never
  leaves the proxy.
- `startedAt` is read after the decision is written
  ([policy-gate.ts:255](../src/proxy/policy-gate.ts#L255)), so `duration_ms`
  is the upstream's time alone.
- The outcome line carries `ok`, `is_error`, the duration and the policy hash.
  If the upstream fails, `error` is a fixed label, never the upstream's text.
- Back in `callTool`, the span closes with `forwarded: true` and the decision's
  code and rule ([policy-gate.ts:297-305](../src/proxy/policy-gate.ts#L297-L305)).
  Spans carry names and labels, never argument values.

**Question 9.** Why is the upstream's error message kept out of the audit log,
when the log already holds the call's arguments?

## Part 3: the same record, offline

### Stop 10. Through `check` (4 min)

The audit file now holds a `list` line, the refused decision, the allowed
decision and its outcome. Run the checker over it the way the demo's step 8
does. Read the command at [src/cli/check.ts:7-26](../src/cli/check.ts#L7-L26),
the reader at
[src/check/sessions.ts:72-177](../src/check/sessions.ts#L72-L177), and the
check at [src/check/check.ts:24-60](../src/check/check.ts#L24-L60).

Notice:

- The reader skips only what it knows is not a forwarded call: `outcome` and
  `list` lines and decisions with `forwarded: false`
  ([sessions.ts:102-111](../src/check/sessions.ts#L102-L111)). Any other shape,
  even `"type": "Decision"`, is a format error and exit 2.
- The time must be ISO 8601 with a zone, on a real date, or epoch milliseconds
  ([sessions.ts:113-116](../src/check/sessions.ts#L113-L116),
  [lines 34-70](../src/check/sessions.ts#L34-L70)).
- A proxy decision line counts as approved only if its `approval.approved` is
  `true` ([sessions.ts:154-161](../src/check/sessions.ts#L154-L161)).
- `checkSessions` runs the same `decide` and `commit` the proxy ran, with a
  fresh `LimitState` per file and the recorded times
  ([check.ts:29-37](../src/check/check.ts#L29-L37)). Anything the policy would
  not have allowed is a violation ([check.ts:49-56](../src/check/check.ts#L49-L56)).
- The summary line comes from `formatCheck`
  ([src/check/report.ts:18-30](../src/check/report.ts#L18-L30)):
  `no violations in 1 call(s) across 1 file(s)` for this file.

**Question 10.** The refused mail to the outside address is in the audit log.
Why does `check` not report it, and what would it report if someone edited the
allowed line's `to` to `someone@outside.test`?

## Answers

1. So nothing downstream can log or forward it. Every later stage gets the
   identity name only; the token stops at the HTTP layer.
2. The JSON-RPC error `Tool mail_send not found`. There is no audit line,
   because the name is rejected before the gate: a call that cannot be routed
   is never shown to the policy.
3. The engine needs a time it can trust and that the offline checker can
   reproduce. A time from the request would let the caller pick which limit
   window it falls in; the recorded `ts` is the gate's time, so a replay sees
   the same windows the live proxy saw.
4. It would return `allow`, from the second rule: a failed constraint drops one
   candidate, and any other permitting rule can still allow the call. So
   "never" is written as a deny rule, which no allow can weaken, and not as a
   constraint on one allow.
5. `to is empty`; `to must equal "team@example.test"` (an object is not equal
   to a string); and for the one-element array, the constraint passes, because
   every element of a non-empty array passes. The call is forwarded and
   counted, and the mail server's own input schema refuses it with an error
   result. The policy guarantees the recipient is the team address; checking
   that the shape is a string is the upstream's job.
6. A refused call has no side effect to account for, so losing its line costs
   only a record. A forwarded call without a decision on disk would be an
   action with no record, which the write-ahead rule exists to prevent.
7. Answering "not found" for a hidden tool does not confirm that it exists. A
   visible tool exists for this caller anyway, so a readable reason costs
   nothing and lets a well-behaved model fix its call.
8. In `exhaustion` at
   [src/policy/engine.ts:57](../src/policy/engine.ts#L57), reached from
   [line 119](../src/policy/engine.ts#L119): the session count is 2 and the
   limit is 2, so `limit_exceeded`. No counter changes, because only forwarded
   calls are committed.
9. The arguments in the log are redacted by key. The upstream chooses its own
   error text and could quote a redacted value back, which would undo the
   redaction.
10. The checker asks whether every call that ran was allowed, and the refused
    call did not run (`forwarded: false`), so it is skipped. With the edited
    line it reports
    `constraint_failed: arguments rejected: rule "mail-team-only": to must equal "team@example.test"`
    and exits 1.

## Exercises

1. **Add an operator.** Add `starts_with` to the constraint language. You will
   touch the operator list and the schema in
   [src/policy/schema.ts](../src/policy/schema.ts), the operator list and
   `compileCheck` in [src/policy/constraints.ts](../src/policy/constraints.ts),
   and the tests in `test/policy/constraints.test.ts`. Decide what it does with
   a non-string value, an array and an empty string, and write the tests first.
   Then ask whether `starts_with` on a URL is safe without the anchoring rules
   `matches` has (try `https://docs.example.test.evil.test/`).
2. **Add a lint.** Warn when a `require_approval` rule has no `limits`, since a
   runaway agent would then ask a human without end. Add it to
   [src/policy/lint.ts](../src/policy/lint.ts) with a test in
   `test/policy/lint.test.ts`, and check that `validate` prints it as a warning
   and still exits 0.
3. **Add an approver.** Write an approver that approves only calls whose
   arguments match a list of pre-approved values read at startup and refuses
   everything else. It implements `Approver` from
   [src/approval/types.ts](../src/approval/types.ts); make it respect the abort
   signal and `close()`. Wire it into the config schema
   ([src/config/schema.ts](../src/config/schema.ts)) and `approverFor` in
   [src/config/start.ts](../src/config/start.ts), and test it through the gate
   the way `test/proxy/approval-gate.test.ts` does.

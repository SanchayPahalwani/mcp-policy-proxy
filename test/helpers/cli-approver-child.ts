// Run by test/approval/close.test.ts: one CLI approval on the real stdin/stderr, then close().
// The process must then exit on its own even though the parent keeps stdin open.
import { cliApprover } from '../../src/approval/cli.js';

const approver = cliApprover();
const result = await approver.request(
  {
    call_id: 'c1',
    identity: 'release-manager',
    session: 's1',
    server: 'docs',
    tool: 'publish',
    args: { id: 7 },
    rule: 'release-publish',
    reason: 'rule "release-publish" requires approval',
    requested_at: new Date(0).toISOString(),
  },
  new AbortController().signal,
);
process.stderr.write(`RESULT ${JSON.stringify(result)}\n`);
await approver.close?.();

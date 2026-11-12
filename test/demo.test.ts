import { describe, expect, it } from 'vitest';
import { runDemo } from '../scripts/demo.js';

describe('demo', () => {
  it('prints the eight steps with what the proxy really answers', { timeout: 60_000 }, async () => {
    const lines: string[] = [];
    await runDemo((line) => lines.push(line));
    const text = lines.join('\n');

    for (let step = 1; step <= 8; step++) expect(text).toMatch(new RegExp(`^${step}\\. `, 'm'));
    // Step 3: a denied tool is hidden, so calling it answers like a tool that does not exist.
    expect(text).toContain('Tool docs__publish not found');
    // Step 4: the refusal names the rule and the failed constraint.
    expect(text).toContain(
      'Denied by policy (constraint_failed): arguments rejected: rule "mail-team-only": to must equal "team@example.test"',
    );
    // Step 5: the third mail hits the per-session limit.
    expect(text).toContain(
      'Denied by policy (limit_exceeded): rule "mail-team-only": limit of 2 calls per session reached',
    );
    // Step 6: the scripted approver says what it approved, and the call goes through.
    expect(text).toContain('approver: approved release-manager docs.publish');
    expect(text).toContain('Published draft d1');
    // Step 7: the audit lines are the proxy's own.
    expect(text).toContain('"code": "denied_by_rule"');
    expect(text).toContain('"code": "approved"');
    // Step 8: the demo's own audit log passes its policy; the bad session does not.
    expect(text).toMatch(/no violations in \d+ call\(s\) across 1 file\(s\)/);
    expect(text).toContain('3 violation(s) in 5 call(s) across 1 file(s)');
    // Tokens are generated per run and never shown.
    expect(text).not.toMatch(/bearer/i);
  });
});

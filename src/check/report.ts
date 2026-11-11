import type { LintIssue } from '../policy/lint.js';
import type { CheckResult } from './check.js';
import type { PolicyTestResult } from './policy-tests.js';

export type Format = 'text' | 'json' | 'github';

// GitHub's workflow-command syntax: data escapes %, CR and LF; properties also escape ":" and ",".
const data = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const property = (s: string) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// A recorded value could hold a newline and a fake summary line; text output shows it escaped.
const printable = (s: string) =>
  s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u{${c.charCodeAt(0).toString(16)}}`);

const lines = (rows: string[]) => rows.join('\n') + '\n';
const pretty = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

export function formatCheck(result: CheckResult, format: Format): string {
  if (format === 'json') return pretty(result);
  const summary = `${
    result.violations.length === 0 ? 'no violations' : `${result.violations.length} violation(s)`
  } in ${result.records} call(s) across ${result.files} file(s)`;
  const rows = result.violations.map((v) => {
    const what = `${v.identity} ${v.server}.${v.tool} ${v.code}: ${v.reason}`;
    return format === 'github'
      ? `::error file=${property(v.file)},line=${v.line},title=Policy violation::${data(what)}`
      : printable(`${v.file}:${v.line} ${what}`);
  });
  return lines([...rows, summary]);
}

export function formatTests(results: PolicyTestResult[], format: Format): string {
  if (format === 'json') return pretty(results);
  const failed = results.filter((r) => !r.ok);
  const summary =
    failed.length === 0
      ? `${results.length} policy test(s) passed`
      : `${failed.length} of ${results.length} policy test(s) failed`;
  const rows = failed.map((r) =>
    format === 'github'
      ? `::error file=${property(r.file)},title=Policy test failed::${data(`${r.name}: ${r.message}`)}`
      : `${r.file}: ${r.name}: ${r.message}`,
  );
  return lines([...rows, summary]);
}

export function formatLint(issues: LintIssue[], format: Format): string {
  if (format === 'json') return pretty(issues);
  const rows = issues.map((i) => {
    const text = i.rule === undefined ? i.message : `rule "${i.rule}": ${i.message}`;
    return format === 'github'
      ? `::${i.level} title=Policy lint::${data(text)}`
      : `${i.level}: ${text}`;
  });
  const errors = issues.filter((i) => i.level === 'error').length;
  const warnings = issues.length - errors;
  return lines([...rows, `${errors} error(s), ${warnings} warning(s)`]);
}

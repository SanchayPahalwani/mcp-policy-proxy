export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** ` (ENOENT)` and the like, when the error carries a string code; never the error's text. */
export function codeOf(e: unknown): string {
  const code = (e as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : '';
}

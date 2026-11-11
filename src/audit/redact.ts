export const REDACTED = '[REDACTED]';

export function redact(value: unknown, keys: string[]): unknown {
  const lowered = new Set(keys.map((k) => k.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v !== 'object' || v === null) return v;
    return Object.fromEntries(
      Object.entries(v).map(([k, inner]) => [
        k,
        lowered.has(k.toLowerCase()) ? REDACTED : walk(inner),
      ]),
    );
  };
  return walk(value);
}

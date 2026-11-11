import { describe, expect, it } from 'vitest';
import { joinName, splitName } from '../../src/proxy/names.js';

describe('tool names', () => {
  it('joins server and tool with the separator', () => {
    expect(joinName('docs', 'publish')).toBe('docs__publish');
  });

  it('splits at the first separator', () => {
    expect(splitName('docs__publish')).toEqual({ server: 'docs', tool: 'publish' });
    expect(splitName('docs__a__b')).toEqual({ server: 'docs', tool: 'a__b' });
  });

  it('rejects names without a valid server prefix or tool', () => {
    for (const bad of ['publish', '__publish', 'docs__', 'Docs__x', 'do_cs__x', '']) {
      expect(splitName(bad)).toBeUndefined();
    }
  });
});

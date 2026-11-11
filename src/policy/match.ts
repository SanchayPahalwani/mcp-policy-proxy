export function globToRegExp(glob: string): RegExp {
  const body = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&'))
    .join('.*');
  // dotAll so a tool name containing a newline cannot slip past a trailing '*'.
  return new RegExp(`^${body}$`, 's');
}

// Anchoring is the point: an unanchored pattern is satisfied by a hostile
// value that merely contains the allowed text.
export function anchoredPattern(pattern: string): RegExp {
  return new RegExp('^(?:' + pattern + ')$', 'u');
}

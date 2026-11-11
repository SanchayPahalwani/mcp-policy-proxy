// Bounds matching work: a longer tool name matches no rule, so default deny applies.
export const MAX_NAME_LENGTH = 256;

// Iterative wildcard match, not a regex: a regex with several '*' backtracks
// exponentially on an attacker-chosen name. This is O(name x glob) at worst.
export function compileGlob(glob: string): (name: string) => boolean {
  return (name) => {
    let g = 0;
    let n = 0;
    let star = -1;
    let resume = 0;
    while (n < name.length) {
      if (g < glob.length && glob[g] === '*') {
        star = g++;
        resume = n;
      } else if (g < glob.length && glob[g] === name[n]) {
        g++;
        n++;
      } else if (star >= 0) {
        g = star + 1;
        n = ++resume;
      } else {
        return false;
      }
    }
    while (glob[g] === '*') g++;
    return g === glob.length;
  };
}

// Anchoring is the point: an unanchored pattern is satisfied by a hostile
// value that merely contains the allowed text.
export function anchoredPattern(pattern: string): RegExp {
  // Compiled bare first so 'a)|(?:b' cannot close the wrapper and escape the anchors.
  new RegExp(pattern, 'u');
  return new RegExp('^(?:' + pattern + ')$', 'u');
}

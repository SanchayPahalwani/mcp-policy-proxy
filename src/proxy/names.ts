export const SEPARATOR = '__';

// No underscores, so the first SEPARATOR in a joined name always ends the server part.
export const SERVER_NAME = /^[a-z0-9][a-z0-9-]*$/;

export function joinName(server: string, tool: string): string {
  return `${server}${SEPARATOR}${tool}`;
}

export function splitName(name: string): { server: string; tool: string } | undefined {
  const at = name.indexOf(SEPARATOR);
  if (at < 0) return undefined;
  const server = name.slice(0, at);
  const tool = name.slice(at + SEPARATOR.length);
  if (!tool || !SERVER_NAME.test(server)) return undefined;
  return { server, tool };
}

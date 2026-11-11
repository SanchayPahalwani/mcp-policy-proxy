import { SERVER_NAME } from '../policy/schema.js';

export const SEPARATOR = '__';

export { SERVER_NAME };

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

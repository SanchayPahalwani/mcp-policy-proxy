export interface LedgerEntry {
  ts: number;
  server: string;
  tool: string;
  args: Record<string, unknown>;
}

/** What the mock servers were actually asked to do, so the eval can score side effects. */
export class Ledger {
  readonly entries: LedgerEntry[] = [];

  constructor(private readonly clock: () => number = Date.now) {}

  record(server: string, tool: string, args: Record<string, unknown>): void {
    this.entries.push({ ts: this.clock(), server, tool, args });
  }
}

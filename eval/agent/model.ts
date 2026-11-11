export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error: boolean;
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface AssistantTurn {
  text: string;
  tool_calls: ToolCall[];
  stop: 'tool_use' | 'end' | 'refusal';
}

export interface Model {
  readonly id: string;
  /** `synthetic` marks numbers that hold by construction rather than by measurement. */
  readonly source: 'synthetic' | 'live';
  start(input: { system: string; prompt: string; tools: ToolDef[] }): Promise<void>;
  /** The first call gets `[]`; each later call gets the results of the previous turn's calls. */
  next(results: ToolResult[]): Promise<AssistantTurn>;
}

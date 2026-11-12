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
  /** Empty unless `stop` is `tool_use`: a turn that ended any other way has no call to run. */
  tool_calls: ToolCall[];
  stop: 'tool_use' | 'end' | 'refusal' | 'max_tokens';
  /** The API's reason for a refusal, when it gave one. */
  refusal_category?: string;
}

/** Everything a model is given before its first turn, so a replay can tell if it changed. */
export interface ModelInput {
  system: string;
  prompt: string;
  tools: ToolDef[];
}

export interface Model {
  readonly id: string;
  /** `synthetic` marks numbers that hold by construction rather than by measurement. */
  readonly source: 'synthetic' | 'live';
  start(input: ModelInput): Promise<void>;
  /** The first call gets `[]`; each later call gets the results of the previous turn's calls. */
  next(results: ToolResult[]): Promise<AssistantTurn>;
}

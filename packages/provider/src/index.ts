import OpenAI from 'openai';
import type { ModelSpec } from '@nexus/protocol';

export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type ChatContent = string | Array<
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' | undefined } }
>;
export type ModelToolCall = { id: string; name: string; arguments: Record<string, unknown>; rawArguments: string };
export type ChatMessage =
  | { role: 'system' | 'user'; content: ChatContent }
  | { role: 'assistant'; content: string | null; toolCalls?: ModelToolCall[] | undefined }
  | { role: 'tool'; content: string; toolCallId: string };
export type ModelToolDefinition = { name: string; description: string; parameters: Record<string, unknown> };
export type ChatInput = {
  system?: string | undefined;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  tools?: ModelToolDefinition[] | undefined;
};
export type ModelTurn = { content: string; toolCalls: ModelToolCall[] };

function safeArguments(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toOpenAIMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === 'tool') return { role: 'tool', content: message.content, tool_call_id: message.toolCallId };
  if (message.role === 'assistant') {
    return {
      role: 'assistant', content: message.content,
      ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({
        id: call.id, type: 'function', function: { name: call.name, arguments: call.rawArguments }
      })) } : {})
    };
  }
  return { role: message.role, content: message.content };
}

export class LocalModelClient {
  constructor(private readonly model: ModelSpec) {}

  async turn(input: ChatInput): Promise<ModelTurn> {
    const client = new OpenAI({ baseURL: this.model.baseUrl, apiKey: this.model.apiKey ?? 'local' });
    const messages: Record<string, unknown>[] = input.system
      ? [{ role: 'system', content: input.system }, ...input.messages.map(toOpenAIMessage)]
      : input.messages.map(toOpenAIMessage);
    const body: Record<string, unknown> = {
      model: this.model.id, messages, temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? this.model.maxOutputTokens,
      ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
      ...(input.tools?.length ? {
        tools: input.tools.map((tool) => ({ type: 'function', function: tool })), tool_choice: 'auto'
      } : {})
    };
    const response = await client.chat.completions.create(body as never);
    const message = response.choices[0]?.message;
    const toolCalls: ModelToolCall[] = (message?.tool_calls ?? []).flatMap((call) => {
      if (call.type !== 'function') return [];
      const rawArguments = call.function.arguments ?? '{}';
      return [{ id: call.id, name: call.function.name, arguments: safeArguments(rawArguments), rawArguments }];
    });
    return { content: message?.content ?? '', toolCalls };
  }

  async complete(input: ChatInput): Promise<string> {
    return (await this.turn(input)).content;
  }
}

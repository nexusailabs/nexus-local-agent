import OpenAI from 'openai';
import type { ModelSpec } from '@nexus/protocol';

export type ChatInput = {
  system?: string;
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  temperature?: number;
  maxTokens?: number;
};

export class LocalModelClient {
  constructor(private readonly model: ModelSpec) {}

  async complete(input: ChatInput): Promise<string> {
    const client = new OpenAI({
      baseURL: this.model.baseUrl,
      apiKey: this.model.apiKey ?? 'local'
    });
    const messages = input.system
      ? [{ role: 'system' as const, content: input.system }, ...input.messages]
      : input.messages;
    const res = await client.chat.completions.create({
      model: this.model.id,
      messages,
      temperature: input.temperature ?? 0.2,
      max_tokens: input.maxTokens ?? this.model.maxOutputTokens
    });
    return res.choices[0]?.message?.content ?? '';
  }
}

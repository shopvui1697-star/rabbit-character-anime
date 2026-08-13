/**
 * Anthropic API Provider
 * Direct integration with Anthropic's Claude API
 */

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("AnthropicProvider");

// Initialize Anthropic client (supports direct API or proxies like 9Router)
const anthropic = new Anthropic({
  apiKey: config.anthropic.apiKey,
  ...(config.anthropic.baseURL ? { baseURL: config.anthropic.baseURL } : {}),
});

export interface AnthropicRequest {
  model?: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string | any[] }>;
  stop_sequences?: string[];
  tools?: any[];
  signal?: AbortSignal;
}

export interface AnthropicResponse {
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: any;
  }>;
  stop_reason: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Invoke Anthropic Claude model (non-streaming)
 */
export async function invokeAnthropic(request: AnthropicRequest): Promise<AnthropicResponse> {
  try {
    const startTime = Date.now();
    
    const response = await anthropic.messages.create({
      model: request.model || config.anthropic.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages as Anthropic.MessageParam[],
      stop_sequences: request.stop_sequences,
      tools: request.tools,
    }, { signal: request.signal });

    const duration = Date.now() - startTime;
    
    log.debug(`Anthropic request completed in ${duration}ms`, {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      stopReason: response.stop_reason,
    });

    return {
      content: response.content.map(block => ({
        type: block.type,
        text: block.type === "text" ? (block.text || "") : undefined,
        id: block.type === "tool_use" ? (block.id || "") : undefined,
        name: block.type === "tool_use" ? (block.name || "") : undefined,
        input: block.type === "tool_use" ? block.input : undefined,
      })),
      stop_reason: response.stop_reason || "end_turn",
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
      },
    };
  } catch (error) {
    log.error("Anthropic API error:", error);
    throw error;
  }
}

/**
 * Invoke Anthropic Claude model with streaming
 * Yields text deltas as they arrive
 */
export async function* invokeAnthropicStream(
  request: AnthropicRequest
): AsyncGenerator<string, void, unknown> {
  try {
    const startTime = Date.now();
    
    const stream = await anthropic.messages.stream({
      model: request.model || config.anthropic.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages as Anthropic.MessageParam[],
      stop_sequences: request.stop_sequences,
      tools: request.tools,
    }, { signal: request.signal });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield event.delta.text;
      }
    }
    
    const duration = Date.now() - startTime;
    log.debug(`Anthropic streaming completed in ${duration}ms`);
  } catch (error) {
    log.error("Anthropic streaming error:", error);
    throw error;
  }
}

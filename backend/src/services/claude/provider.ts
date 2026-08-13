import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";
import {
  invokeBedrockClaude,
  invokeBedrockClaudeStream,
  convertToBedrockMessages,
} from "./bedrock-provider.js";
import {
  invokeAnthropic,
  invokeAnthropicStream,
} from "./anthropic-provider.js";

const log = createLogger("LLM");

interface LLMRequest {
  model?: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: string; content: string | any[] }>;
  stop_sequences?: string[];
  tools?: any[];
  signal?: AbortSignal;
}

interface LLMResponse {
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
 * Unified LLM invocation (supports both Anthropic and Bedrock)
 */
export async function invokeLLM(request: LLMRequest): Promise<LLMResponse> {
  const provider = config.llm.provider;

  if (provider === "bedrock") {
    log.debug("Using AWS Bedrock");
    
    const bedrockRequest = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.max_tokens,
      system: request.system,
      messages: convertToBedrockMessages(request.messages),
      stop_sequences: request.stop_sequences,
      tools: request.tools,
      signal: request.signal,
    };

    const response = await invokeBedrockClaude(bedrockRequest);
    
    // Log usage for cost tracking
    if (response.usage) {
      const cost = calculateCost(response.usage, provider);
      log.debug(`Request cost: $${cost.toFixed(6)}`, {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      });
    }
    
    return {
      content: response.content,
      stop_reason: response.stop_reason,
      usage: response.usage,
    };
  } else {
    log.debug("Using Anthropic API");
    
    const response = await invokeAnthropic({
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages,
      stop_sequences: request.stop_sequences,
      tools: request.tools,
      signal: request.signal,
    });

    // Log usage for cost tracking
    if (response.usage) {
      const cost = calculateCost(response.usage, provider);
      log.debug(`Request cost: $${cost.toFixed(6)}`, response.usage);
    }

    return {
      content: response.content,
      stop_reason: response.stop_reason,
      usage: response.usage,
    };
  }
}

/**
 * Unified LLM streaming
 * Yields text deltas as they arrive
 */
export async function* invokeLLMStream(
  request: LLMRequest
): AsyncGenerator<string, void, unknown> {
  const provider = config.llm.provider;

  if (provider === "bedrock") {
    log.debug("Using AWS Bedrock (streaming)");
    
    const bedrockRequest = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.max_tokens,
      system: request.system,
      messages: convertToBedrockMessages(request.messages),
      stop_sequences: request.stop_sequences,
      tools: request.tools,
      signal: request.signal,
    };

    const streamGenerator = invokeBedrockClaudeStream(bedrockRequest);
    
    for await (const chunk of streamGenerator) {
      if (typeof chunk === "string") {
        yield chunk;
      }
      // Final response with usage info is returned at the end, but we ignore it here
    }
  } else {
    log.debug("Using Anthropic API (streaming)");
    
    yield* invokeAnthropicStream({
      model: request.model,
      max_tokens: request.max_tokens,
      system: request.system,
      messages: request.messages,
      stop_sequences: request.stop_sequences,
      tools: request.tools,
      signal: request.signal,
    });
  }
}

/**
 * Calculate estimated cost based on token usage
 */
function calculateCost(
  usage: { input_tokens: number; output_tokens: number },
  provider: string
): number {
  if (provider === "bedrock") {
    // Haiku 4.5 pricing on Bedrock (approximate)
    const inputCost = (usage.input_tokens / 1_000_000) * 0.25;
    const outputCost = (usage.output_tokens / 1_000_000) * 1.25;
    return inputCost + outputCost;
  } else {
    // Haiku 3.5 pricing on Anthropic API
    const inputCost = (usage.input_tokens / 1_000_000) * 0.80;
    const outputCost = (usage.output_tokens / 1_000_000) * 4.00;
    return inputCost + outputCost;
  }
}

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  InvokeModelWithResponseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { config } from "../../config/index.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("BedrockClaude");

// Initialize Bedrock client
const bedrockClient = new BedrockRuntimeClient({
  region: config.bedrock.region,
  credentials: {
    accessKeyId: config.aws.accessKeyId,
    secretAccessKey: config.aws.secretAccessKey,
  },
});

// Bedrock message format (compatible with Anthropic)
interface BedrockMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
}

interface BedrockRequest {
  anthropic_version: string;
  max_tokens: number;
  system?: string;
  messages: BedrockMessage[];
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: any[];
  signal?: AbortSignal;
}

interface BedrockResponse {
  id: string;
  type: string;
  role: string;
  content: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: any;
  }>;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

/**
 * Invoke Bedrock Claude model (non-streaming)
 */
export async function invokeBedrockClaude(
  request: BedrockRequest
): Promise<BedrockResponse> {
  // Strip `signal` before serializing — it's a transport option, not part of the Bedrock body
  const { signal, ...bedrockBody } = request;
  const command = new InvokeModelCommand({
    modelId: config.bedrock.modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(bedrockBody),
  });

  try {
    const startTime = Date.now();
    const response = await bedrockClient.send(command, { abortSignal: signal });
    const duration = Date.now() - startTime;
    
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    
    log.debug(`Bedrock request completed in ${duration}ms`, {
      inputTokens: responseBody.usage?.input_tokens,
      outputTokens: responseBody.usage?.output_tokens,
      stopReason: responseBody.stop_reason,
    });
    
    return responseBody;
  } catch (error) {
    log.error("Bedrock invoke error:", error);
    throw error;
  }
}

/**
 * Invoke Bedrock Claude model with streaming
 * Yields text deltas as they arrive
 */
export async function* invokeBedrockClaudeStream(
  request: BedrockRequest
): AsyncGenerator<string, BedrockResponse | null, unknown> {
  // Strip `signal` before serializing — it's a transport option, not part of the Bedrock body
  const { signal, ...bedrockBody } = request;
  const command = new InvokeModelWithResponseStreamCommand({
    modelId: config.bedrock.modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(bedrockBody),
  });

  try {
    const startTime = Date.now();
    const response = await bedrockClient.send(command, { abortSignal: signal });

    if (!response.body) {
      throw new Error("No response body from Bedrock");
    }

    let fullResponse: BedrockResponse | null = null;

    // Parse Bedrock event stream
    for await (const event of response.body) {
      if (event.chunk) {
        const chunk = JSON.parse(new TextDecoder().decode(event.chunk.bytes));
        
        // Handle different event types
        if (chunk.type === "content_block_start") {
          // Content block starting
          continue;
        } else if (chunk.type === "content_block_delta") {
          // Text delta - yield to caller
          if (chunk.delta?.type === "text_delta" && chunk.delta.text) {
            yield chunk.delta.text;
          }
        } else if (chunk.type === "content_block_stop") {
          // Content block complete
          continue;
        } else if (chunk.type === "message_delta") {
          // Message metadata update
          continue;
        } else if (chunk.type === "message_stop") {
          // Stream complete
          const duration = Date.now() - startTime;
          log.debug(`Bedrock streaming completed in ${duration}ms`);
          break;
        } else if (chunk.type === "message_start") {
          // Message starting - contains initial metadata
          fullResponse = chunk.message;
        }
      }
    }

    return fullResponse;
  } catch (error) {
    log.error("Bedrock streaming error:", error);
    throw error;
  }
}

/**
 * Convert Anthropic message format to Bedrock format
 */
export function convertToBedrockMessages(
  messages: Array<{ role: string; content: string | any[] }>
): BedrockMessage[] {
  return messages.map((msg) => ({
    role: msg.role as "user" | "assistant",
    content: msg.content,
  }));
}

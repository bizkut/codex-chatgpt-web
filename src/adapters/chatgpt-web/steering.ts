import { createHash, randomBytes } from "node:crypto";
import type { CodexParsedRequest } from "../../types";
import { extractChatGptTurnIdentity, nativeCodexEnvironmentItemIndexBeforeUser, nativeCodexInputItemTurnId } from "./environment";
import type { BrokerToolRequest, BrokerToolResult } from "./turn-broker";

export const MAX_STEERING_MESSAGES_PER_BOUNDARY = 32;
export const MAX_STEERING_TEXT_BYTES_PER_BOUNDARY = 256 * 1024;
export const MAX_ACCEPTED_STEERING_KEYS = 1_024;
export const CHATGPT_STEERING_ENVELOPE_TAG = "codex_transport_steering";

interface RawRequestBody {
  input?: unknown;
}

export interface ChatGptSteeringMessage {
  sourceKey: string;
  sourceIdentity: string;
  contentDigest: string;
  text: string;
}

export interface ChatGptPendingSteering {
  messages: ChatGptSteeringMessage[];
  nextRawInput: unknown[];
  nextRawInputDigest: string;
}

export interface ChatGptSteeringCursor {
  threadId?: string;
  turnId: string;
  rawInput: unknown[];
  rawInputDigest: string;
}

export interface ChatGptSteeringEnvelope {
  version: 1;
  channel_id: string;
  sequence: number;
  after_tool_call_ids: string[];
  source_digest: string;
  messages: Array<{ source_id: string; content: Array<{ type: "text"; text: string }> }>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawInput(parsed: CodexParsedRequest): unknown[] {
  const body = record(parsed._rawBody) as RawRequestBody | undefined;
  if (Array.isArray(body?.input)) return body.input;
  if (typeof body?.input === "string") return [{ role: "user", content: body.input }];
  return [];
}

function canonical(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function isPrefix(prefix: unknown[], input: unknown[]): boolean {
  if (prefix.length > input.length) return false;
  for (let index = 0; index < prefix.length; index += 1) {
    if (canonical(prefix[index]) !== canonical(input[index])) return false;
  }
  return true;
}

function itemClientMessageId(item: Record<string, unknown>): string | undefined {
  for (const key of ["client_user_message_id", "clientUserMessageId"]) {
    const value = item[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function steeringText(item: Record<string, unknown>): string {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  const parts: string[] = [];
  for (const partValue of item.content) {
    const part = record(partValue);
    if (!part) throw new Error("ChatGPT Web steering contains an invalid content block");
    if ((part.type === "input_text" || part.type === "text") && typeof part.text === "string") {
      parts.push(part.text);
      continue;
    }
    throw new Error("ChatGPT Web steering currently supports text input only");
  }
  return parts.join("");
}

function sourceIdentity(
  item: Record<string, unknown>,
  identity: { threadId?: string; turnId: string },
  absoluteIndex: number,
): string {
  const nativeItemId = typeof item.id === "string" && item.id.trim() ? item.id : undefined;
  const clientMessageId = itemClientMessageId(item);
  return canonical({
    threadId: identity.threadId,
    turnId: identity.turnId,
    ...(clientMessageId ? { clientMessageId } : nativeItemId ? { nativeItemId } : { absoluteIndex }),
  });
}

export function createChatGptSteeringChannelId(): string {
  return `steer_${randomBytes(24).toString("base64url")}`;
}

export function createChatGptSteeringCursor(parsed: CodexParsedRequest): ChatGptSteeringCursor {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT Web steering requires native Codex turn_id metadata");
  const input = rawInput(parsed);
  return {
    ...(identity.threadId ? { threadId: identity.threadId } : {}),
    turnId: identity.turnId,
    rawInput: structuredClone(input),
    rawInputDigest: digest(input),
  };
}

export function deriveChatGptSteering(
  parsed: CodexParsedRequest,
  cursor: ChatGptSteeringCursor,
  accepted: ReadonlyMap<string, string>,
  outstandingCallIds: ReadonlySet<string> = new Set(),
): ChatGptPendingSteering | undefined {
  const identity = extractChatGptTurnIdentity(parsed);
  if (identity.turnId !== cursor.turnId || identity.threadId !== cursor.threadId) {
    throw new Error("ChatGPT Web steering request does not match the active native Codex turn");
  }
  const input = rawInput(parsed);
  const inputDigest = digest(input);
  if (inputDigest === cursor.rawInputDigest) return undefined;

  let suffixStart: number;
  const replayPrefix = parsed._replayPrefixLen ?? 0;
  if (replayPrefix > 0) {
    if (replayPrefix > input.length) throw new Error("ChatGPT Web steering replay prefix is invalid");
    if (replayPrefix < cursor.rawInput.length || !isPrefix(cursor.rawInput, input.slice(0, replayPrefix))) {
      throw new Error("Cannot safely derive same-turn Codex steering from a divergent replay prefix");
    }
    suffixStart = cursor.rawInput.length;
  } else {
    if (!isPrefix(cursor.rawInput, input)) {
      throw new Error("Cannot safely derive same-turn Codex steering from a non-append-only request");
    }
    suffixStart = cursor.rawInput.length;
  }

  const suffix = input.slice(suffixStart);
  const environmentIndexes = new Set<number>();
  for (let index = suffixStart; index < input.length; index += 1) {
    const environmentIndex = nativeCodexEnvironmentItemIndexBeforeUser(input, index, cursor.turnId);
    if (environmentIndex !== undefined) environmentIndexes.add(environmentIndex);
  }

  const messages: ChatGptSteeringMessage[] = [];
  for (let offset = 0; offset < suffix.length; offset += 1) {
    const absoluteIndex = suffixStart + offset;
    if (environmentIndexes.has(absoluteIndex)) continue;
    const item = record(suffix[offset]);
    if (!item) throw new Error("ChatGPT Web steering request contains an invalid appended input item");
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      if (typeof item.call_id !== "string" || !outstandingCallIds.has(item.call_id)) {
        throw new Error("ChatGPT Web steering request contains a tool result outside the active batch");
      }
      continue;
    }
    if (item.type === "message" && (item.role === "assistant" || item.role === "developer" || item.role === "system")) continue;
    if (item.type === "reasoning" || item.type === "function_call" || item.type === "custom_tool_call") continue;
    if (item.type !== "message" || item.role !== "user") {
      throw new Error("ChatGPT Web steering request contains an unsupported appended input item");
    }
    const itemTurnId = nativeCodexInputItemTurnId(item);
    if (itemTurnId && itemTurnId !== cursor.turnId) {
      throw new Error("ChatGPT Web steering message belongs to a different native Codex turn");
    }
    const text = steeringText(item);
    const identity = sourceIdentity(item, { threadId: cursor.threadId, turnId: cursor.turnId }, absoluteIndex);
    const key = digest(identity);
    const contentDigest = digest(text);
    const previousDigest = accepted.get(key);
    if (previousDigest !== undefined) {
      if (previousDigest !== contentDigest) throw new Error("ChatGPT Web steering message identity was reused with different content");
      continue;
    }
    messages.push({ sourceKey: key, sourceIdentity: identity, contentDigest, text });
  }

  if (messages.length > MAX_STEERING_MESSAGES_PER_BOUNDARY) {
    throw new Error(`ChatGPT Web steering exceeds ${MAX_STEERING_MESSAGES_PER_BOUNDARY} messages at one tool boundary`);
  }
  const totalBytes = messages.reduce((total, message) => total + Buffer.byteLength(message.text), 0);
  if (totalBytes > MAX_STEERING_TEXT_BYTES_PER_BOUNDARY) {
    throw new Error(`ChatGPT Web steering exceeds ${MAX_STEERING_TEXT_BYTES_PER_BOUNDARY} bytes at one tool boundary`);
  }
  if (accepted.size + messages.length > MAX_ACCEPTED_STEERING_KEYS) {
    throw new Error(`ChatGPT Web steering history exceeds ${MAX_ACCEPTED_STEERING_KEYS} accepted messages`);
  }

  return {
    messages,
    nextRawInput: structuredClone(input),
    nextRawInputDigest: inputDigest,
  };
}

export function createChatGptSteeringEnvelope(
  channelId: string,
  sequence: number,
  messages: readonly ChatGptSteeringMessage[],
  outstanding: readonly BrokerToolRequest[],
): ChatGptSteeringEnvelope {
  return {
    version: 1,
    channel_id: channelId,
    sequence,
    after_tool_call_ids: outstanding.map(request => request.callId),
    source_digest: digest(messages.map(message => ({ sourceKey: message.sourceKey, contentDigest: message.contentDigest }))),
    messages: messages.map(message => ({
      source_id: message.sourceKey,
      content: [{ type: "text", text: message.text }],
    })),
  };
}

export function appendChatGptSteeringEnvelope(
  result: BrokerToolResult,
  envelope: ChatGptSteeringEnvelope,
): BrokerToolResult {
  return {
    ...result,
    content: [
      ...result.content,
      {
        type: "text",
        text: `<${CHATGPT_STEERING_ENVELOPE_TAG}>${JSON.stringify(envelope)}</${CHATGPT_STEERING_ENVELOPE_TAG}>`,
      },
    ],
  };
}

export function sanitizedChatGptSteeringObservation(parsed: CodexParsedRequest): Record<string, unknown> {
  const input = rawInput(parsed);
  return {
    version: 1,
    replayPrefixItems: parsed._replayPrefixLen ?? 0,
    inputItemCount: input.length,
    items: input.map(value => {
      const item = record(value);
      const content = Array.isArray(item?.content) ? item.content : [];
      return {
        type: typeof item?.type === "string" ? item.type : null,
        role: typeof item?.role === "string" ? item.role : null,
        contentKinds: content.map(part => typeof record(part)?.type === "string" ? record(part)!.type : "unknown"),
        textChars: content.reduce((total, part) => {
          const text = record(part)?.text;
          return total + (typeof text === "string" ? text.length : 0);
        }, typeof item?.content === "string" ? item.content.length : 0),
        hasItemId: typeof item?.id === "string",
        hasClientMessageId: Boolean(item && itemClientMessageId(item)),
        hasItemTurnId: nativeCodexInputItemTurnId(item) !== undefined,
      };
    }),
  };
}

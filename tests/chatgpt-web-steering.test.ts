import { expect, test } from "bun:test";
import {
  appendChatGptSteeringEnvelope,
  createChatGptSteeringChannelId,
  createChatGptSteeringCursor,
  createChatGptSteeringEnvelope,
  deriveChatGptSteering,
} from "../src/adapters/chatgpt-web/steering";
import type { BrokerToolRequest, BrokerToolResult } from "../src/adapters/chatgpt-web/turn-broker";
import type { CodexParsedRequest } from "../src/types";

function userItem(text: string, id: string, turnId = "turn-steer") {
  return {
    type: "message",
    id,
    role: "user",
    content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
  };
}

function parsed(input: unknown[], replayPrefixLen = 0): CodexParsedRequest {
  return {
    modelId: "gpt-5.6-sol",
    stream: true,
    context: { messages: [{ role: "user", content: "initial", timestamp: 1 }] },
    options: { reasoning: "high" },
    _rawBody: {
      prompt_cache_key: "thread-steer",
      client_metadata: {
        "x-codex-turn-metadata": JSON.stringify({ thread_id: "thread-steer", turn_id: "turn-steer" }),
      },
      input,
    },
    ...(replayPrefixLen > 0 ? { _replayPrefixLen: replayPrefixLen } : {}),
  };
}

const initial = [userItem("initial", "msg-initial")];
const outstanding: BrokerToolRequest[] = [
  { callId: "call-a", wireName: "exec_command", freeform: false, arguments: { cmd: "first" } },
  { callId: "call-b", wireName: "exec_command", freeform: false, arguments: { cmd: "second" } },
];

function resultItem(callId: string) {
  return { type: "function_call_output", call_id: callId, output: `result-${callId}` };
}

test("derives ordered text steering from an append-only same-turn tool continuation", () => {
  const cursor = createChatGptSteeringCursor(parsed(initial));
  const request = parsed([
    ...initial,
    { type: "function_call", call_id: "call-a", name: "exec_command", arguments: "{}" },
    resultItem("call-a"),
    resultItem("call-b"),
    userItem("summarize only", "msg-steer-1"),
    userItem("and do not edit", "msg-steer-2"),
  ]);

  const pending = deriveChatGptSteering(
    request,
    cursor,
    new Map(),
    new Set(outstanding.map(call => call.callId)),
  );

  expect(pending?.messages.map(message => message.text)).toEqual(["summarize only", "and do not edit"]);
  expect(pending?.messages[0]?.sourceKey).not.toBe(pending?.messages[1]?.sourceKey);
});

test("treats an exact request retry as no new steering", () => {
  const request = parsed(initial);
  const cursor = createChatGptSteeringCursor(request);
  expect(deriveChatGptSteering(request, cursor, new Map())).toBeUndefined();
});

test("uses the local previous-response replay boundary without replaying historical users", () => {
  const cursor = createChatGptSteeringCursor(parsed(initial));
  const request = parsed([
    ...initial,
    { type: "function_call", call_id: "call-a", name: "exec_command", arguments: "{}" },
    resultItem("call-a"),
    resultItem("call-b"),
    userItem("new direction", "msg-steer"),
  ], initial.length + 1);

  const pending = deriveChatGptSteering(
    request,
    cursor,
    new Map(),
    new Set(outstanding.map(call => call.callId)),
  );
  expect(pending?.messages.map(message => message.text)).toEqual(["new direction"]);
});

test("fails closed on mismatched turns, divergent history, images, and unrelated tool results", () => {
  const cursor = createChatGptSteeringCursor(parsed(initial));
  expect(() => deriveChatGptSteering(
    parsed([userItem("changed history", "other"), userItem("steer", "msg-steer")]),
    cursor,
    new Map(),
  )).toThrow("non-append-only");

  expect(() => deriveChatGptSteering(
    parsed([...initial, userItem("wrong turn", "msg-steer", "turn-other")]),
    cursor,
    new Map(),
  )).toThrow("different native Codex turn");

  const imageSteer = userItem("ignored", "msg-image") as Record<string, unknown>;
  imageSteer.content = [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }];
  expect(() => deriveChatGptSteering(parsed([...initial, imageSteer]), cursor, new Map())).toThrow("text input only");

  expect(() => deriveChatGptSteering(
    parsed([...initial, resultItem("call-unrelated"), userItem("steer", "msg-steer")]),
    cursor,
    new Map(),
    new Set(["call-a"]),
  )).toThrow("outside the active batch");
});

test("does not classify an exact native environment carrier as steering", () => {
  const cursor = createChatGptSteeringCursor(parsed(initial));
  const environment = userItem(
    "<environment_context><cwd>/tmp/project</cwd><sandbox_mode>read-only</sandbox_mode></environment_context>",
    "msg-env",
  );
  const request = parsed([...initial, environment, userItem("actual steer", "msg-steer")]);
  const pending = deriveChatGptSteering(request, cursor, new Map());
  expect(pending?.messages.map(message => message.text)).toEqual(["actual steer"]);

  const stringEnvironment = { ...environment, id: "msg-env-string", content: environment.content[0]!.text };
  const stringRequest = parsed([...initial, stringEnvironment, userItem("actual steer", "msg-steer-string")]);
  expect(deriveChatGptSteering(stringRequest, cursor, new Map())?.messages.map(message => message.text))
    .toEqual(["actual steer"]);
});

test("preserves a mixed-content user message containing environment-looking text", () => {
  const cursor = createChatGptSteeringCursor(parsed(initial));
  const mixed = userItem("ignored", "msg-mixed") as Record<string, unknown>;
  mixed.content = [
    { type: "input_text", text: "<environment_context><cwd>/tmp/project</cwd></environment_context>" },
    { type: "input_text", text: "This is user steering, not an environment carrier." },
  ];
  const request = parsed([...initial, mixed, userItem("second steer", "msg-second")]);
  expect(deriveChatGptSteering(request, cursor, new Map())?.messages.map(message => message.text)).toEqual([
    "<environment_context><cwd>/tmp/project</cwd></environment_context>This is user steering, not an environment carrier.",
    "second steer",
  ]);
});

test("preserves two identical text messages with distinct identities and dedupes retries", () => {
  const cursor = createChatGptSteeringCursor(parsed(initial));
  const request = parsed([...initial, userItem("same", "msg-a"), userItem("same", "msg-b")]);
  const pending = deriveChatGptSteering(request, cursor, new Map());
  expect(pending?.messages).toHaveLength(2);

  const accepted = new Map(pending!.messages.map(message => [message.sourceKey, message.contentDigest]));
  const nextCursor = {
    ...cursor,
    rawInput: pending!.nextRawInput,
    rawInputDigest: pending!.nextRawInputDigest,
  };
  expect(deriveChatGptSteering(request, nextCursor, accepted)).toBeUndefined();
});

test("appends one isolated steering envelope without changing structured tool output", () => {
  const channel = createChatGptSteeringChannelId();
  const pending = deriveChatGptSteering(
    parsed([...initial, userItem("stop after summary", "msg-steer")]),
    createChatGptSteeringCursor(parsed(initial)),
    new Map(),
  )!;
  const envelope = createChatGptSteeringEnvelope(channel, 1, pending.messages, outstanding);
  const original: BrokerToolResult = {
    content: [{ type: "text", text: "tool output" }],
    structuredContent: { output: "tool output" },
  };
  const appended = appendChatGptSteeringEnvelope(original, envelope);

  expect(channel).toStartWith("steer_");
  expect(appended.structuredContent).toEqual(original.structuredContent);
  expect(appended.content[0]).toEqual(original.content[0]);
  expect(appended.content).toHaveLength(2);
  const transport = appended.content[1] as { type: string; text: string };
  expect(transport.text).toContain(channel);
  expect(transport.text).toContain("stop after summary");
  expect(envelope.after_tool_call_ids).toEqual(["call-a", "call-b"]);
});

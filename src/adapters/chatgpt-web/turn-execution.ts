import { createHash } from "node:crypto";
import type { AdapterEvent, CodexParsedRequest } from "../../types";
import type { BrokerToolRequest } from "./turn-broker";
import { extractChatGptTurnIdentity } from "./environment";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import {
  createChatGptSteeringCursor,
  createChatGptSteeringEnvelope,
  deriveChatGptSteering,
  MAX_ACCEPTED_STEERING_KEYS,
  MAX_STEERING_MESSAGES_PER_BOUNDARY,
  MAX_STEERING_TEXT_BYTES_PER_BOUNDARY,
  type ChatGptPendingSteering,
  type ChatGptSteeringCursor,
  type ChatGptSteeringEnvelope,
  type ChatGptSteeringMessage,
} from "./steering";

export type ChatGptBrowserOutcome =
  | { type: "final"; answer: string }
  | { type: "error"; error: Error };

export interface ChatGptTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface TraceWaiter {
  resolve: (event: ChatGptTraceEvent) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export class ChatGptTraceFeed {
  private readonly queued: ChatGptTraceEvent[] = [];
  private readonly waiters = new Set<TraceWaiter>();

  push(event: ChatGptTraceEvent): void {
    const normalized = event.continuation ? event.text : event.text.trim();
    if (!normalized) return;
    const normalizedEvent = { ...event, text: normalized };
    const waiter = this.waiters.values().next().value as TraceWaiter | undefined;
    if (!waiter) {
      this.queued.push(normalizedEvent);
      return;
    }
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve(normalizedEvent);
  }

  drain(): ChatGptTraceEvent[] {
    return this.queued.splice(0);
  }

  next(signal?: AbortSignal): Promise<ChatGptTraceEvent> {
    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (signal?.aborted) return Promise.reject(new DOMException("trace wait aborted", "AbortError"));
    return new Promise<ChatGptTraceEvent>((resolveWait, rejectWait) => {
      const waiter: TraceWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("trace wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface TextWaiter {
  resolve: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Append-only browser Markdown feed. Waiters are notifications; `drain` owns consumption. */
export class ChatGptTextFeed {
  private readonly queued: string[] = [];
  private readonly waiters = new Set<TextWaiter>();
  private text = "";

  push(delta: string): void {
    if (!delta) return;
    this.text += delta;
    this.queued.push(delta);
    const waiter = this.waiters.values().next().value as TextWaiter | undefined;
    if (!waiter) return;
    this.waiters.delete(waiter);
    if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener("abort", waiter.onAbort);
    waiter.resolve();
  }

  drain(): string[] {
    return this.queued.splice(0);
  }

  value(): string {
    return this.text;
  }

  wait(signal?: AbortSignal): Promise<void> {
    if (this.queued.length > 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(new DOMException("text wait aborted", "AbortError"));
    return new Promise<void>((resolveWait, rejectWait) => {
      const waiter: TextWaiter = { resolve: resolveWait, reject: rejectWait, ...(signal ? { signal } : {}) };
      if (signal) {
        waiter.onAbort = () => {
          this.waiters.delete(waiter);
          rejectWait(new DOMException("text wait aborted", "AbortError"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.waiters.add(waiter);
    });
  }
}

interface ChatGptTurnRuntimeBase {
  browser: Promise<string>;
  trace: ChatGptTraceFeed;
  text: ChatGptTextFeed;
  cancel: () => void;
}

export type ChatGptTurnRuntime =
  | (ChatGptTurnRuntimeBase & { mode: "tools"; token: Promise<string>; steeringChannelId: string })
  | (ChatGptTurnRuntimeBase & { mode: "read-only" });

export function chatGptTurnExecutionKey(parsed: CodexParsedRequest): string {
  const identity = extractChatGptTurnIdentity(parsed);
  if (!identity.turnId) throw new Error("ChatGPT web requires native Codex turn_id metadata for browser-session replay");
  const payload = {
    threadId: identity.threadId,
    turnId: identity.turnId,
    purpose: parsed._compactionRequest ? "compaction" : "response",
  };
  return createHash("sha256").update(JSON.stringify({
    modelId: parsed.modelId,
    reasoning: parsed.options.reasoning,
    payload,
  })).digest("hex");
}

export class ChatGptTurnSession {
  readonly createdAt = Date.now();
  private lastTouchedAt = this.createdAt;
  readonly browserOutcome: Promise<ChatGptBrowserOutcome>;
  private readonly outstandingById = new Map<string, BrokerToolRequest>();
  private readonly deliveredResultIds = new Set<string>();
  private readonly acceptedSteering = new Map<string, string>();
  private readonly acceptedSteeringIdentities = new Map<string, string>();
  private steeringCursor?: ChatGptSteeringCursor;
  private pendingSteering: ChatGptSteeringMessage[] = [];
  private pendingSteeringCursor?: Pick<ChatGptPendingSteering, "nextRawInput" | "nextRawInputDigest">;
  private steeringSequence = 0;
  private outstandingReasoning: string[] = [];
  private finalReasoning: string[] = [];
  private outstandingPrelude: AdapterEvent[] = [];
  private finalPrelude: AdapterEvent[] = [];
  private settledBrowserOutcome?: ChatGptBrowserOutcome;
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly runtime: ChatGptTurnRuntime, parsed?: CodexParsedRequest) {
    if (parsed) this.steeringCursor = createChatGptSteeringCursor(parsed);
    this.browserOutcome = runtime.browser
      .then(answer => ({ type: "final", answer }) as ChatGptBrowserOutcome)
      .catch(error => ({ type: "error", error: error instanceof Error ? error : new Error(String(error)) }) as ChatGptBrowserOutcome)
      .then(outcome => {
      this.settledBrowserOutcome = outcome;
      return outcome;
    });
  }

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    this.touch();
    const run = this.tail.then(task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  touch(): void {
    this.lastTouchedAt = Date.now();
  }

  lastUsedAt(): number {
    return this.lastTouchedAt;
  }

  outstanding(): BrokerToolRequest[] {
    return [...this.outstandingById.values()];
  }

  settledOutcome(): ChatGptBrowserOutcome | undefined {
    return this.settledBrowserOutcome;
  }

  isActive(): boolean {
    return this.settledBrowserOutcome === undefined;
  }

  setOutstanding(requests: BrokerToolRequest[], reasoning: string[] = [], prelude: AdapterEvent[] = []): void {
    if (this.outstandingById.size > 0) throw new Error("cannot emit a new ChatGPT tool batch while the previous batch is unresolved");
    for (const request of requests) {
      if (this.deliveredResultIds.has(request.callId) || this.outstandingById.has(request.callId)) {
        throw new Error(`duplicate ChatGPT bridge tool call id: ${request.callId}`);
      }
      this.outstandingById.set(request.callId, request);
    }
    this.outstandingReasoning = [...reasoning];
    this.outstandingPrelude = [...prelude];
  }

  hasOutstanding(callId: string): boolean {
    return this.outstandingById.has(callId);
  }

  markResultDelivered(callId: string): void {
    if (!this.outstandingById.delete(callId)) throw new Error(`ChatGPT bridge tool result does not match an outstanding call: ${callId}`);
    this.deliveredResultIds.add(callId);
    if (this.outstandingById.size === 0) {
      this.outstandingReasoning = [];
      this.outstandingPrelude = [];
    }
  }

  reasoningForOutstandingReplay(): string[] {
    return [...this.outstandingReasoning];
  }

  eventsForOutstandingReplay(): AdapterEvent[] {
    return [...this.outstandingPrelude];
  }

  observeSteering(parsed: CodexParsedRequest, outstanding: readonly BrokerToolRequest[] = this.outstanding()): number {
    if (!this.steeringCursor) {
      this.steeringCursor = createChatGptSteeringCursor(parsed);
      return 0;
    }
    const known = new Map(this.acceptedSteering);
    const identities = new Map(this.acceptedSteeringIdentities);
    for (const message of this.pendingSteering) {
      known.set(message.sourceKey, message.contentDigest);
      identities.set(message.sourceIdentity, message.contentDigest);
    }
    const pending = deriveChatGptSteering(
      parsed,
      this.steeringCursor,
      known,
      new Set(outstanding.map(request => request.callId)),
    );
    if (!pending) return 0;
    const combinedMessageCount = this.pendingSteering.length + pending.messages.length;
    if (combinedMessageCount > MAX_STEERING_MESSAGES_PER_BOUNDARY) {
      throw new Error(`ChatGPT Web steering exceeds ${MAX_STEERING_MESSAGES_PER_BOUNDARY} messages at one tool boundary`);
    }
    const combinedTextBytes = [...this.pendingSteering, ...pending.messages]
      .reduce((total, message) => total + Buffer.byteLength(message.text), 0);
    if (combinedTextBytes > MAX_STEERING_TEXT_BYTES_PER_BOUNDARY) {
      throw new Error(`ChatGPT Web steering exceeds ${MAX_STEERING_TEXT_BYTES_PER_BOUNDARY} bytes at one tool boundary`);
    }
    if (this.acceptedSteering.size + combinedMessageCount > MAX_ACCEPTED_STEERING_KEYS) {
      throw new Error(`ChatGPT Web steering history exceeds ${MAX_ACCEPTED_STEERING_KEYS} accepted messages`);
    }
    for (const message of pending.messages) {
      const previousDigest = identities.get(message.sourceIdentity);
      if (previousDigest !== undefined && previousDigest !== message.contentDigest) {
        throw new Error("ChatGPT Web steering message identity was reused with different content");
      }
    }
    this.pendingSteering.push(...pending.messages);
    this.pendingSteeringCursor = {
      nextRawInput: pending.nextRawInput,
      nextRawInputDigest: pending.nextRawInputDigest,
    };
    return pending.messages.length;
  }

  hasPendingSteering(): boolean {
    return this.pendingSteering.length > 0;
  }

  pendingSteeringEnvelope(outstanding: readonly BrokerToolRequest[]): ChatGptSteeringEnvelope | undefined {
    if (this.pendingSteering.length === 0) return undefined;
    if (this.runtime.mode !== "tools") throw new Error("Read-only ChatGPT Web runtime cannot receive same-turn steering");
    return createChatGptSteeringEnvelope(
      this.runtime.steeringChannelId,
      this.steeringSequence + 1,
      this.pendingSteering,
      outstanding,
    );
  }

  commitObservedSteering(): void {
    if (!this.pendingSteeringCursor) return;
    for (const message of this.pendingSteering) {
      const previous = this.acceptedSteering.get(message.sourceKey);
      if (previous !== undefined && previous !== message.contentDigest) {
        throw new Error("ChatGPT Web steering identity changed before delivery");
      }
      this.acceptedSteering.set(message.sourceKey, message.contentDigest);
      this.acceptedSteeringIdentities.set(message.sourceIdentity, message.contentDigest);
    }
    if (this.pendingSteering.length > 0) this.steeringSequence += 1;
    if (!this.steeringCursor) throw new Error("ChatGPT Web steering cursor was not initialized");
    this.steeringCursor = {
      ...this.steeringCursor,
      rawInput: this.pendingSteeringCursor.nextRawInput,
      rawInputDigest: this.pendingSteeringCursor.nextRawInputDigest,
    };
    this.pendingSteering = [];
    this.pendingSteeringCursor = undefined;
  }

  setFinalReasoning(reasoning: string[]): void {
    this.finalReasoning = [...reasoning];
  }

  reasoningForFinalReplay(): string[] {
    return [...this.finalReasoning];
  }

  setFinalEvents(events: AdapterEvent[]): void {
    this.finalPrelude = [...events];
  }

  eventsForFinalReplay(): AdapterEvent[] {
    return [...this.finalPrelude];
  }

  cancel(): void {
    this.runtime.cancel();
  }
}

export class ChatGptTurnSessions {
  private readonly entries = new Map<string, ChatGptTurnSession>();

  constructor(
    private readonly ttlMs = 30 * 60_000,
    private readonly maxEntries = 256,
  ) {}

  getOrCreate(key: string, parsed: CodexParsedRequest, start: () => ChatGptTurnRuntime): ChatGptTurnSession {
    const startRuntime = start;
    this.prune();
    const existing = this.entries.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    const active = [...this.entries.values()].filter(session => session.isActive()).length;
    if (active >= MAX_CHATGPT_BROWSER_TABS) {
      throw new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      );
    }
    if (this.entries.size >= this.maxEntries) throw new Error(`ChatGPT web session registry is full (${this.maxEntries} entries)`);
    const session = new ChatGptTurnSession(startRuntime(), parsed);
    this.entries.set(key, session);
    return session;
  }

  clear(): number {
    const cancelled = this.entries.size;
    for (const session of this.entries.values()) session.cancel();
    this.entries.clear();
    return cancelled;
  }

  activeCount(): number {
    this.prune();
    let active = 0;
    for (const session of this.entries.values()) if (session.isActive()) active += 1;
    return active;
  }

  private prune(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [key, session] of this.entries) {
      if (session.isActive() || session.lastUsedAt() >= cutoff) continue;
      session.cancel();
      this.entries.delete(key);
    }
  }
}

export const chatGptTurnSessions = new ChatGptTurnSessions();

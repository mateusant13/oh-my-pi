/**
 * Oracle for TC-20260923-snapcompact-systemprompt-freeze (P1 follow-up).
 *
 * Plausible break this test catches: `planInlineSwaps` derives the
 * system-prompt swap (`plan.systemPrompt`) from the LEFTOVER image budget on
 * every request. On request N no tool swap consumes budget, so the swap is
 * granted — the swap prepends note + frames to the FIRST user message and
 * replaces `systemPrompt` with the stub. On request N+1 a newly-eligible tool
 * swap consumes budget, the leftover denies the system swap, and the first
 * user message ships in its original form: a rewrite of an already-sent item
 * that breaks the append-only provider prefix (and busts the prompt cache).
 *
 * This test travels the REAL turn path — a live `createAgentSession`,
 * `session.agent.appendMessage` + `await session.sendUserMessage` turns, and a
 * `registerCustomApi` capture at the provider-transport boundary (post
 * `transformProviderContext`, i.e. post snapcompact). It does NOT call
 * `planInlineSwaps`, does NOT hand-build the transformer's input array, and
 * does NOT supply any deciding flag: grant-at-N / deny-at-N+1 falls out of
 * the budget arithmetic (unknown-provider floor 5, system prompt 4 frames,
 * tool result 2 frames: 4 <= 5 grants, 5 - 2 = 3 < 4 denies).
 */
import { describe, expect, it } from "bun:test";
import type { Api, Context, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/** Same dense-text recipe as snapcompact-inline.test.ts. */
function denseText(words: number): string {
	return Array.from({ length: words }, (_, i) => `w${(i * 7919) % 100000}`).join(" ");
}
const TEST_SHAPE = "6x12-dim";
const DEFAULT_CAPACITY = snapcompact.geometry(snapcompact.resolveShape(undefined, TEST_SHAPE)).capacity;
/** ~2 frames on the test shape; the budget math below depends on 2 frames per tool result. */
const LARGE = denseText(Math.ceil((DEFAULT_CAPACITY * 1.7) / 7));
/** ~4 frames on the test shape: fits the unknown-provider floor (5) alone, but not after a 2-frame tool swap. */
const SYS_DENSE = denseText(Math.ceil((DEFAULT_CAPACITY * 3.4) / 7));

let apiCounter = 0;

/**
 * Drives the REAL turn path with `snapcompact.systemPrompt: "agents-md"`.
 * Request N carries only a user turn (system-prompt swap granted from the
 * full budget); request N+1 appends two large tool results first (the older
 * one consumes budget, denying the system-prompt swap on the unmodified
 * tree). Returns the two provider-visible contexts.
 */
async function driveSystemPromptTurns(): Promise<{ requestN: Context; requestNPlus1: Context }> {
	using tempDir = TempDir.createSync("@pi-sysprompt-freeze-");
	const api = `test-sysprompt-freeze-${apiCounter++}`;
	const captured: Context[] = [];
	registerCustomApi(api, (_model, context) => {
		captured.push(context);
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const message = createAssistantMessage("ok");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: message });
			stream.push({ type: "done", reason: "stop", message });
		});
		return stream;
	});
	const model = buildModel({
		id: `sysprompt-freeze-${api}`,
		name: "Sysprompt freeze",
		api,
		// Unknown to PROVIDER_IMAGE_BUDGETS by construction: the safe floor (5)
		// is the budget this oracle's grant/deny arithmetic is sized against.
		provider: "groq",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	} as ModelSpec<Api>) as Model<Api>;
	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry,
		settings: Settings.isolated({
			"compaction.enabled": false,
			"snapcompact.toolResults": true,
			"snapcompact.systemPrompt": "agents-md",
			"snapcompact.shape": TEST_SHAPE,
		}),
		model,
		// Fully deterministic prompt text carrying an agents-md-extractable
		// <repo-rules> section; identical on both requests by construction.
		systemPrompt: ["You are a coding agent.", `<repo-rules>\n${SYS_DENSE}\n</repo-rules>`],
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		taskDepth: 1,
		agentId: "SubAgent",
	});
	try {
		await session.sendUserMessage("first");
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "call_b_sys",
			toolName: "read",
			content: [{ type: "text", text: LARGE }],
			isError: false,
			timestamp: 1,
		});
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "call_c_sys",
			toolName: "read",
			content: [{ type: "text", text: LARGE }],
			isError: false,
			timestamp: 2,
		});
		await session.sendUserMessage("second");
		if (captured.length !== 2) {
			throw new Error(`Expected exactly 2 provider requests, captured ${captured.length}`);
		}
		return { requestN: captured[0]!, requestNPlus1: captured[1]! };
	} finally {
		await session.dispose();
		authStorage.close();
		clearCustomApis();
	}
}

/** Serialize the first provider-visible message (the first user message here). */
function serializedItemZero(context: Context): string {
	const message = context.messages[0];
	if (!message) throw new Error("Expected at least one provider-visible message");
	return JSON.stringify(message);
}

function serializedToolResult(context: Context, toolCallId: string): string {
	const message = context.messages.find(
		(message): message is Extract<Context["messages"][number], { role: "toolResult" }> =>
			message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (!message) throw new Error(`Expected tool result ${toolCallId} among provider-visible messages`);
	return JSON.stringify(message);
}

describe("P1 follow-up: snapcompact system-prompt swap prefix stability (real turn path)", () => {
	it("keeps the already-sent first user message byte-identical when a tool swap denies the system-prompt swap", async () => {
		const { requestN, requestNPlus1 } = await driveSystemPromptTurns();
		const itemZeroN = serializedItemZero(requestN);
		const itemZeroNPlus1 = serializedItemZero(requestNPlus1);
		// Pre-state: the swap was GRANTED on request N — frames ride the first
		// user message alongside its original text.
		expect(itemZeroN).toContain('"type":"image"');
		expect(itemZeroN).toContain("first");
		// Pre-state: the newest tool result still ships as crisp text on N+1
		// (skip-last in both versions) — the fix must not image everything to
		// hold the prefix.
		expect(serializedToolResult(requestNPlus1, "call_c_sys")).toContain(LARGE.slice(0, 80));
		// The invariant: the provider-visible prefix is append-only.
		expect(itemZeroNPlus1).toBe(itemZeroN);
		// The swap's other half: the systemPrompt field must not flip between
		// stub (swapped) and original text either.
		expect(JSON.stringify(requestNPlus1.systemPrompt)).toBe(JSON.stringify(requestN.systemPrompt));
	});
});

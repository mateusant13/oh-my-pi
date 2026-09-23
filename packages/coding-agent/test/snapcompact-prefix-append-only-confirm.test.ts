/**
 * CONFIRM lane for TC-20260923-cache-adversarial-hunt (P1a snapcompact, P1b hook).
 *
 * Plausible break these tests catch (P1a): `planInlineSwaps` skips only the
 * NEWEST tool result (`snapcompact-inline.ts`, `k < input.toolResults.length - 1`),
 * so a tool result that shipped as crisp text on request N becomes imaging-eligible
 * on request N+1 once a newer result appends — and the apply loop rewrites the
 * already-sent message in place (`messages[target.index] = { ...target.message, content }`
 * with note + image frames). That breaks the append-only provider prefix from A onward
 * and busts the provider prompt cache.
 *
 * These tests travel the REAL turn path — a live `createAgentSession`,
 * `session.agent.appendMessage` + `await session.sendUserMessage` turns, and a
 * `registerCustomApi` capture at the provider-transport boundary (post
 * `transformProviderContext`, i.e. post snapcompact). They do NOT call
 * `planInlineSwaps` or hand-build the transformer's input array.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Context, Model, ModelSpec, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { clearCustomApis, registerCustomApi, streamSimple } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as snapcompact from "@oh-my-pi/snapcompact";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import type { FetchInput } from "./helpers/fetch-mock";
import { createAssistantMessage } from "./helpers/agent-session-setup";

/** Same dense-text recipe as snapcompact-inline.test.ts: spans ~2 frames, clears
 *  the 3k-token floor and the 0.9 savings gate for the 6x12-dim test shape. */
function denseText(words: number): string {
	return Array.from({ length: words }, (_, i) => `w${(i * 7919) % 100000}`).join(" ");
}
const TEST_SHAPE = "6x12-dim";
const DEFAULT_CAPACITY = snapcompact.geometry(snapcompact.resolveShape(undefined, TEST_SHAPE)).capacity;
const LARGE = denseText(Math.ceil((DEFAULT_CAPACITY * 1.7) / 7));

let apiCounter = 0;

/**
 * Drives the REAL turn path: full SDK session, tool results A then B appended to
 * live session history, one provider call per turn, captured at the custom-API
 * transport boundary. Request N has A as the newest tool result; request N+1
 * appends B. Returns the two provider-visible contexts.
 */
async function driveABTurns(overrides: {
	toolResults: boolean;
	systemPrompt: "none" | "agents-md";
}): Promise<{ requestN: Context; requestNPlus1: Context }> {
	using tempDir = TempDir.createSync("@pi-prefix-confirm-");
	const api = `test-prefix-confirm-${apiCounter++}`;
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
		id: `prefix-confirm-${api}`,
		name: "Prefix confirm",
		api,
		provider: "anthropic",
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
			"snapcompact.toolResults": overrides.toolResults,
			"snapcompact.systemPrompt": overrides.systemPrompt,
			"snapcompact.shape": TEST_SHAPE,
		}),
		model,
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
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "call_a",
			toolName: "read",
			content: [{ type: "text", text: LARGE }],
			isError: false,
			timestamp: 1,
		});
		await session.sendUserMessage("first");
		session.agent.appendMessage({
			role: "toolResult",
			toolCallId: "call_b",
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

/** Serialize one provider-visible item the way the provider serializer receives it. */
function serializedProviderItem(context: Context, toolCallId: string): string {
	const message = context.messages.find(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolCallId === toolCallId,
	);
	if (!message) throw new Error(`Expected tool result ${toolCallId} among provider-visible messages`);
	return JSON.stringify(message);
}

describe("P1a: snapcompact A→B prefix stability (real turn path)", () => {
	it("keeps an already-sent tool result byte-identical when a newer result appends", async () => {
		const { requestN, requestNPlus1 } = await driveABTurns({ toolResults: true, systemPrompt: "none" });
		const itemN = serializedProviderItem(requestN, "call_a");
		const itemNPlus1 = serializedProviderItem(requestNPlus1, "call_a");
		// Pre-state: on request N, A is the newest tool result and ships as crisp text.
		expect(itemN).toContain(LARGE.slice(0, 80));
		// Sanity: B is the newest result on N+1 and still ships as text.
		expect(serializedProviderItem(requestNPlus1, "call_b")).toContain(LARGE.slice(0, 80));
		// The invariant: the provider-visible prefix is append-only.
		expect(itemNPlus1).toBe(itemN);
	});

	it("control: renderToolResults=false keeps A's item unchanged across the same A→B sequence", async () => {
		// systemPrompt "agents-md" (not "none") keeps the transformer constructed so
		// the transform runs on every request; only the renderToolResults gate is off.
		const { requestN, requestNPlus1 } = await driveABTurns({
			toolResults: false,
			systemPrompt: "agents-md",
		});
		const itemN = serializedProviderItem(requestN, "call_a");
		const itemNPlus1 = serializedProviderItem(requestNPlus1, "call_a");
		expect(itemNPlus1).toBe(itemN);
		// Pins that the switch actually gates imaging: no frames reach A's item.
		expect(itemNPlus1).not.toContain('"type":"image"');
	});
});

describe("P1b: before_provider_request rewrite detection", () => {
	let sharedTempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-p1b-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	it("emits a first_changed_item_index warning when an extension rewrites an already-sent item", async () => {
		using tempDir = TempDir.createSync("@pi-p1b-test-");
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.writeFileSync(
			path.join(extensionsDir, "p1b-hook.ts"),
			`
			export default function(pi) {
				pi.on("before_provider_request", async (event) => {
					const incoming: unknown = event.payload;
					if (!incoming || typeof incoming !== "object" || !("messages" in incoming)) return event.payload;
					if (!Array.isArray(incoming.messages)) return event.payload;
					const messages = incoming.messages.map((message, index) => {
						if (index !== 0 || !message || typeof message !== "object" || !("content" in message)) return message;
						const content = Array.isArray(message.content) ? message.content : [message.content];
						return { ...message, content: [...content, { type: "text", text: "[hook-ts:" + Date.now() + "]" }] };
					});
					return { ...incoming, messages };
				});
			}
			`,
		);
		const loaded = await loadExtensions([path.join(extensionsDir, "p1b-hook.ts")], tempDir.path());
		if (loaded.errors.length > 0) throw new Error(`Extension failed to load: ${JSON.stringify(loaded.errors)}`);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			tempDir.path(),
			SessionManager.inMemory(),
			modelRegistry,
		);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");
		const baseContext: Context = {
			systemPrompt: ["sys"],
			messages: [
				{ role: "user", content: [{ type: "text", text: "already-sent item zero" }], timestamp: 1 },
				{ ...createAssistantMessage("ack"), timestamp: 2 },
				{ role: "user", content: [{ type: "text", text: "second user turn" }], timestamp: 3 },
			],
		};

		const warnMessages: string[] = [];
		const errorMessages: string[] = [];
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(message => {
			warnMessages.push(String(message));
		});
		const errorSpy = vi.spyOn(logger, "error").mockImplementation(message => {
			errorMessages.push(String(message));
		});
		const sentBodies: Array<{ drive: number; body: string }> = [];
		let drive = 0;
		const captureFetch = async (input: FetchInput, init?: RequestInit): Promise<Response> => {
			const request =
				input instanceof Request ? input : new Request(input instanceof URL ? input.href : input, init);
			sentBodies.push({ drive, body: await request.text() });
			return new Response(
				JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "capture-only" } }),
				{ status: 400, headers: { "content-type": "application/json" } },
			);
		};
		try {
			for (let round = 0; round < 2; round++) {
				drive = round;
				const stream = streamSimple(bundled, structuredClone(baseContext), {
					apiKey: "sk-test-capture",
					fetch: captureFetch as never,
					signal: AbortSignal.timeout(15000),
					onPayload: (payload, model) => runner.emitBeforeProviderRequest(payload, model),
				});
				try {
					for await (const _event of stream) {
						// drain until the capture-only 400 aborts the stream
					}
				} catch {
					// expected: the stub fetch answers 400 after the wire body is captured
				}
				// Real-clock delay, not a race guess: the extension appends the REAL platform
				// timestamp (Date.now()), so the drives need a genuine clock advance. Fake timers
				// would freeze (or hand-drive) the very clock whose volatility is the defect.
				await Bun.sleep(15);
			}
		} finally {
			warnSpy.mockRestore();
			errorSpy.mockRestore();
		}

		const bodiesFor = (round: number): string[] =>
			sentBodies.filter(entry => entry.drive === round).map(entry => entry.body);
		if (bodiesFor(0).length === 0 || bodiesFor(1).length === 0) {
			throw new Error(`Expected a captured wire body per drive, got ${JSON.stringify(sentBodies.length)} total`);
		}
		const itemZero = (body: string): string => {
			const parsed: unknown = JSON.parse(body);
			if (!parsed || typeof parsed !== "object" || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
				throw new Error("Expected the captured wire body to carry a messages array");
			}
			return JSON.stringify(parsed.messages[0]);
		};
		// Observation 1: the hook's mutation reaches the wire body that is actually sent.
		expect(bodiesFor(0)[0]).toContain("[hook-ts:");
		// Observation 2: the already-sent item differs between the two otherwise identical requests.
		expect(itemZero(bodiesFor(1)[0]!)).not.toBe(itemZero(bodiesFor(0)[0]!));
		// Oracle: a rewrite of an already-sent item must warn with first_changed_item_index.
		const markerWarnings = [...warnMessages, ...errorMessages].filter(message =>
			message.includes("first_changed_item_index"),
		);
		expect(markerWarnings.length).toBeGreaterThan(0);
	});
});

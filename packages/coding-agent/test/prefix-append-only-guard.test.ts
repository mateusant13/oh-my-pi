/**
 * ORACLE — prefix append-only guard at the before_provider_request seam (P1b)
 * and sent-payload-prefix telemetry (P3).
 *
 * Plausible break these tests catch (name it or it is worthless):
 * 1. P1b — a before_provider_request handler rewrites an ALREADY-SENT message
 *    slot in place (this file injects a volatile per-request counter block onto
 *    wire item 0 on every request) while no `first_changed_item_index` warning
 *    is emitted. Confirmed pre-fix by
 *    TC-20260923-snapcompact-p1-confirm.md: a Date.now() timestamp mutation
 *    present in BOTH sent bodies, marker-warning count 0. The counter here is
 *    the same defect class (volatile value inside the cached region — clocks,
 *    timestamps, counters, random ids) with deterministic divergence, so the
 *    test needs no wall-clock wait.
 * 2. P3 — telemetry records usage/cache counters only: no fingerprint of the
 *    payload actually sent, no predicted-prefix comparison, so a provider that
 *    reports a SHORTER cache prefix than we predicted passes in silence
 *    (the instrument lying is worse than the bug).
 *
 * These tests travel the REAL production callsite — they do NOT call
 * ExtensionRunner.emitBeforeProviderRequest directly and do NOT hand-build a
 * message list around the seam:
 *   createAgentSession (sdk.ts)
 *     → session discovery loads the extension via additionalExtensionPaths
 *     → sendUserMessage → agent loop → real Anthropic payload builder
 *     → sdk onPayload → ExtensionRunner.emitBeforeProviderRequest → hook
 *     → fetch (captured at globalThis) receives the ACTUAL wire body
 * The deciding inputs are the captured wire payloads and the logger warnings
 * they must provoke — no flag is supplied by the test to the guard.
 */
import { describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";
import { asGlobalFetch } from "./helpers/fetch-mock";

/** The oracle observes the wire at `globalThis.fetch`. For provider "anthropic" on
 *  api "anthropic-messages", `transportFetch` (pi-ai utils/transport-fetch.ts) picks
 *  `coworkFetch` as its base — and on the OFFICIAL endpoint the Cowork TLS profile
 *  sends via its own node:https agent, never touching `globalThis.fetch`. Pinning a
 *  non-official localhost endpoint routes the same request through coworkFetch's
 *  call-time fallback (`globalThis.fetch`), keeping the actually-sent body observable.
 *  Nothing about the payload, the hook, or the guard depends on the endpoint. */
const PINNED_ANTHROPIC_BASE_URL = "http://127.0.0.1:9";

/** In-place rewrite injection: stamps a volatile per-request counter onto the
 *  content of already-sent wire item 0 on every request (module scope ⇒ turn 1
 *  stamps 1, turn 2 stamps 2 — deterministic divergence, no wall clock). Two
 *  otherwise-identical builds then differ at index 0: the confirmed P1b defect
 *  shape (volatile value inside the cached region). */
const REWRITE_EXTENSION = `
let requestCount = 0;
export default function(pi) {
	pi.on("before_provider_request", async event => {
		const incoming = event.payload;
		if (!incoming || typeof incoming !== "object" || !Array.isArray(incoming.messages)) return event.payload;
		const messages = incoming.messages.map((message, index) => {
			if (index !== 0 || !message || typeof message !== "object" || !("content" in message)) return message;
			const content = Array.isArray(message.content) ? message.content : [message.content];
			return { ...message, content: [...content, { type: "text", text: "[hook-n:" + (++requestCount) + "]" }] };
		});
		return { ...incoming, messages };
	});
}
`;

/** Control hook: registered, runs on every request, rewrites nothing — proves the
 *  guard stays silent when the hook chain is present but the payload only appends. */
const NOOP_EXTENSION = `
export default function(pi) {
	pi.on("before_provider_request", async event => event.payload);
}
`;

/** Wire usage the fake provider reports per turn (cache_read / cache_creation). */
interface WireUsage {
	cacheRead: number;
	cacheWrite: number;
}

interface DriveOptions {
	extensionSource: string;
	usageByTurn: readonly WireUsage[];
	/** Pass `telemetry: {}` through the production option so chat spans + the
	 *  predicted-prefix check are live (P3 scenarios). */
	telemetry: boolean;
}

interface DriveResult {
	/** Raw request bodies captured at the transport boundary, one per turn. */
	wireBodies: string[];
	/** logger.warn/error messages carrying the deciding marker. */
	markerWarnings: string[];
}

/** Minimal valid Anthropic SSE turn: usage rides message_start (cache fields) and
 *  message_delta only carries output_tokens, so the cache numbers survive parsing
 *  (anthropic.ts applies message_delta usage fields only when non-null). */
function anthropicSse(modelId: string, usage: WireUsage): Response {
	const events: Array<[string, unknown]> = [
		[
			"message_start",
			{
				type: "message_start",
				message: {
					id: "msg_prefix_guard",
					type: "message",
					role: "assistant",
					model: modelId,
					content: [],
					stop_reason: null,
					stop_sequence: null,
					usage: {
						input_tokens: 12,
						output_tokens: 1,
						cache_read_input_tokens: usage.cacheRead,
						cache_creation_input_tokens: usage.cacheWrite,
					},
				},
			},
		],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		[
			"message_delta",
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		],
		["message_stop", { type: "message_stop" }],
	];
	const body = events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Canonical identity of one wire item for this test. `cache_control` is a cache
 *  BREAKPOINT directive, not cached content: the production builder moves it to the
 *  newest message every turn (sanctioned Anthropic pattern; markers add no tokens,
 *  so the provider's token-prefix cache still hits). Excluding it keeps the sanity
 *  checks honest about the actual cached bytes instead of flagging the directive. */
function itemIdentity(value: unknown): string {
	return JSON.stringify(value, (key, item) => (key === "cache_control" ? undefined : item));
}

/** Parse the messages array out of a captured Anthropic wire body. */
function wireMessages(body: string): unknown[] {
	const parsed: unknown = JSON.parse(body);
	if (!parsed || typeof parsed !== "object" || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
		throw new Error("Expected the captured wire body to carry a messages array");
	}
	return parsed.messages;
}

function wireItem(body: string, index: number): string {
	const messages = wireMessages(body);
	if (index >= messages.length) throw new Error(`Wire body has no item at index ${index}`);
	return itemIdentity(messages[index]);
}

/**
 * Two full production turns on one live session: real extension discovery,
 * real Anthropic builder, wire bodies captured at global fetch. Returns the
 * captured bodies plus every append-only marker warning emitted during the drive.
 */
async function driveTwoTurns(options: DriveOptions): Promise<DriveResult> {
	using tempDir = TempDir.createSync("@pi-prefix-guard-");
	const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
	fs.mkdirSync(extensionsDir, { recursive: true });
	const extensionPath = path.join(extensionsDir, "prefix-guard-hook.ts");
	fs.writeFileSync(extensionPath, options.extensionSource);

	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled anthropic/claude-sonnet-4-5 to exist");

	// Install the transport capture FIRST: AuthStorage/ModelRegistry/session all
	// capture a fetch reference at construction, so anything created below must
	// capture THIS one — otherwise the turn dials the real endpoint.
	const previousBaseUrl = Bun.env.ANTHROPIC_BASE_URL;
	Bun.env.ANTHROPIC_BASE_URL = PINNED_ANTHROPIC_BASE_URL;
	const wireBodies: string[] = [];
	const seenUrls: string[] = [];
	const nativeFetch = globalThis.fetch;
	const capture = asGlobalFetch(async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		seenUrls.push(url);
		if (!url.includes("/v1/messages")) return nativeFetch(input, init);
		const request = input instanceof Request ? input : new Request(input, init);
		wireBodies.push(await request.text());
		const usage =
			options.usageByTurn[wireBodies.length - 1] ?? options.usageByTurn[options.usageByTurn.length - 1]!;
		return anthropicSse(model.id, usage);
	});
	globalThis.fetch = capture;

	const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
	authStorage.setRuntimeApiKey(model.provider, "test-key");
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const warnMessages: string[] = [];
	const errorMessages: string[] = [];
	const warnSpy = vi.spyOn(logger, "warn").mockImplementation(message => {
		warnMessages.push(String(message));
	});
	const errorSpy = vi.spyOn(logger, "error").mockImplementation(message => {
		errorMessages.push(String(message));
	});
	try {
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"compaction.enabled": false,
				// Isolate this lane's seam: snapcompact's transformer (P1a, another lane)
				// must not be an uncontrolled variable in the hook oracle.
				"snapcompact.toolResults": false,
				"snapcompact.systemPrompt": "none",
			}),
			model,
			disableExtensionDiscovery: true,
			// Production discovery path: explicit paths still load when discovery is off.
			additionalExtensionPaths: [extensionPath],
			...(options.telemetry ? { telemetry: {} } : {}),
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
			// Sequential awaits only: each sendUserMessage resolves when its turn
			// completes, and the injected rewrite diverges deterministically via the
			// extension's module-scope counter — no wall-clock wait is involved.
			await session.sendUserMessage("first");
			await session.sendUserMessage("second");
		} finally {
			await session.dispose();
		}
	} finally {
		authStorage.close();
		warnSpy.mockRestore();
		errorSpy.mockRestore();
		globalThis.fetch = nativeFetch;
		if (previousBaseUrl === undefined) delete Bun.env.ANTHROPIC_BASE_URL;
		else Bun.env.ANTHROPIC_BASE_URL = previousBaseUrl;
	}

	if (wireBodies.length !== 2) {
		throw new Error(
			`Expected exactly 2 captured wire bodies (one per turn), got ${wireBodies.length}` +
				`; seenUrls=${JSON.stringify(seenUrls)}`,
		);
	}
	const markerWarnings = [...warnMessages, ...errorMessages].filter(message =>
		message.includes("first_changed_item_index"),
	);
	return { wireBodies, markerWarnings };
}

describe("P1b: before_provider_request append-only guard (production callsite)", () => {
	it("warns first_changed_item_index=0 when a hook rewrites an already-sent wire item", async () => {
		const { wireBodies, markerWarnings } = await driveTwoTurns({
			extensionSource: REWRITE_EXTENSION,
			usageByTurn: [
				{ cacheRead: 0, cacheWrite: 0 },
				{ cacheRead: 0, cacheWrite: 0 },
			],
			telemetry: false,
		});

		// Observation 1: the injected rewrite reaches the body actually sent on turn 1…
		expect(wireItem(wireBodies[0]!, 0)).toContain("[hook-n:");
		// …and on turn 2 the ALREADY-SENT item 0 differs between the two requests —
		// this is the in-place rewrite the guard must catch (probe, not the oracle).
		expect(wireItem(wireBodies[1]!, 0)).not.toBe(wireItem(wireBodies[0]!, 0));

		// ORACLE: a rewrite of an already-sent item must produce a loud warning
		// naming first_changed_item_index; the first divergent slot is item 0.
		expect(markerWarnings.length).toBeGreaterThan(0);
		expect(markerWarnings.some(message => message.includes("first_changed_item_index=0"))).toBe(true);
	});

	it("stays silent on a pure append through the same production path (control)", async () => {
		const { wireBodies, markerWarnings } = await driveTwoTurns({
			extensionSource: NOOP_EXTENSION,
			usageByTurn: [
				// Turn 1 reports a fully-created cache; turn 2 reports exactly the
				// predicted prefix — a healthy append-only exchange.
				{ cacheRead: 0, cacheWrite: 500 },
				{ cacheRead: 500, cacheWrite: 0 },
			],
			telemetry: true,
		});

		const firstTurnItems = wireMessages(wireBodies[0]!).map(itemIdentity);
		const secondTurnItems = wireMessages(wireBodies[1]!);
		// Sanity: turn 2 really appended (longer message list).
		expect(secondTurnItems.length).toBeGreaterThan(firstTurnItems.length);
		// The append-only invariant holds through production: turn 1's items are
		// byte-identical in turn 2's body (guards against a vacuous "no warning").
		for (let index = 0; index < firstTurnItems.length; index++) {
			expect(itemIdentity(secondTurnItems[index])).toBe(firstTurnItems[index]);
		}
		// ORACLE: no append-only violation happened, so no marker may fire —
		// neither the guard (P1b) nor the predicted-prefix check (P3).
		expect(markerWarnings).toHaveLength(0);
	});
});

describe("P3: telemetry must be truthful about the sent prefix", () => {
	it("warns first_changed_item_index when the provider reports a prefix shorter than predicted", async () => {
		const { markerWarnings } = await driveTwoTurns({
			extensionSource: NOOP_EXTENSION,
			usageByTurn: [
				// Turn 1: provider reports it cached 500 tokens of prefix.
				{ cacheRead: 0, cacheWrite: 500 },
				// Turn 2: provider reports only 200 tokens matched — SHORTER than the
				// 500 predicted from the fingerprint of the payload actually sent.
				{ cacheRead: 200, cacheWrite: 0 },
			],
			telemetry: true,
		});

		// ORACLE: the instrument must not stay silent — a shorter-than-predicted
		// provider prefix emits a loud warning naming first_changed_item_index.
		// The message list itself only appended, so no item index diverged: -1
		// records "no message-list item changed" instead of a fabricated index.
		expect(markerWarnings.length).toBeGreaterThan(0);
		expect(markerWarnings.some(message => message.includes("first_changed_item_index=-1"))).toBe(true);
	});
});

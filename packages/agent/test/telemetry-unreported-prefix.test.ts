/**
 * Telemetry must not stamp or warn from cache buckets the provider never reported.
 *
 * Production path, end to end: `streamSimple` (Anthropic SSE wire bytes through
 * the production transport + mapper, which derives `usage.unreported`) →
 * `recordSentPayload` (the post-hook sent payload, as the sdk `onPayload` seam
 * passes it) → `finishChatSpan` (the agent loop's span finalizer, which calls
 * `verifyProviderReportedPrefix`). The deciding flag is derived from the wire,
 * never hand-supplied: adding the cache fields back to the SSE flips the oracle.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { streamSimple, type AssistantMessage, type Context } from "@oh-my-pi/pi-ai";
import {
	finishChatSpan,
	PiGenAIAttr,
	recordSentPayload,
	type AgentTelemetry,
	type AgentTelemetryConfig,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core/telemetry";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { logger } from "@oh-my-pi/pi-utils";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = {
	messages: [{ role: "user", content: "Keep this prefix warm.", timestamp: Date.now() }],
};

function sseResponse(events: Array<Record<string, unknown>>): Response {
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream", "request-id": "req_unreported_prefix" },
	});
}

/** One streaming turn. `startUsage`/`deltaUsage` are the wire usage objects; omission flags `unreported`. */
function streamingTurn(
	startUsage: Record<string, unknown>,
	deltaUsage: Record<string, unknown>,
): Array<Record<string, unknown>> {
	return [
		{ type: "message_start", message: { id: "msg_turn", usage: startUsage } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: deltaUsage },
		{ type: "message_stop" },
	];
}

async function streamTurn(
	startUsage: Record<string, unknown>,
	deltaUsage: Record<string, unknown>,
): Promise<AssistantMessage> {
	const stream = streamSimple(model, context, {
		fetch: (async () => sseResponse(streamingTurn(startUsage, deltaUsage))) as typeof fetch,
		apiKey: "test-anthropic-key",
	});
	return stream.result();
}

const exporter = new InMemorySpanExporter();
const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
const tracer = tracerProvider.getTracer("telemetry-unreported-prefix-test");

let previousBaseUrl: string | undefined;
beforeEach(() => {
	previousBaseUrl = Bun.env.ANTHROPIC_BASE_URL;
	delete Bun.env.ANTHROPIC_BASE_URL;
});
afterEach(() => {
	exporter.reset();
	if (previousBaseUrl === undefined) {
		delete Bun.env.ANTHROPIC_BASE_URL;
	} else {
		Bun.env.ANTHROPIC_BASE_URL = previousBaseUrl;
	}
});
afterAll(async () => {
	await tracerProvider.shutdown();
});

interface DriveResult {
	telemetry: AgentTelemetry;
	warnings: string[];
}

/** Fresh config identity per test — the sent-prefix state is keyed by config object. */
function driveSetup(): DriveResult {
	const config: AgentTelemetryConfig = { tracer };
	const telemetry = resolveTelemetry(config, "test-session");
	if (!telemetry) throw new Error("telemetry unexpectedly disabled");
	const warnings: string[] = [];
	vi.spyOn(logger, "warn").mockImplementation(message => {
		warnings.push(String(message));
	});
	vi.spyOn(logger, "error").mockImplementation(message => {
		warnings.push(String(message));
	});
	return { telemetry, warnings };
}

function markerWarnings(warnings: string[]): string[] {
	return warnings.filter(message => message.includes("first_changed_item_index"));
}

describe("telemetry must not stamp or warn from unreported cache buckets (production path)", () => {
	it("stays silent and unstamped when a turn never reports cache counts after a prediction was armed", async () => {
		const { telemetry, warnings } = driveSetup();

		// Turn 1: provider measures both cache buckets — arms prediction 0 + 500.
		const first = await streamTurn(
			{ input_tokens: 1200, cache_read_input_tokens: 0, cache_creation_input_tokens: 500 },
			{ output_tokens: 50 },
		);
		recordSentPayload(telemetry.config, { messages: [{ role: "user", content: "first" }] });
		const span1 = tracer.startSpan("chat turn1");
		await finishChatSpan(telemetry, span1, first, { stepNumber: 0 });
		span1.end();

		// Turn 2: provider omits BOTH cache fields — genuine unknown, not a 0 read.
		const second = await streamTurn({ input_tokens: 1700 }, { output_tokens: 60 });
		recordSentPayload(telemetry.config, {
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
		});
		const span2 = tracer.startSpan("chat turn2");
		await finishChatSpan(telemetry, span2, second, { stepNumber: 1 });
		span2.end();

		// CONTROL: the measured turn-1 zero IS stamped — the stamp path itself works.
		expect(span1.attributes[PiGenAIAttr.ReportedPrefixTokens]).toBe(0);
		// ORACLE: the unreported turn stamps nothing and warns nothing.
		expect(span2.attributes[PiGenAIAttr.ReportedPrefixTokens]).toBeUndefined();
		expect(markerWarnings(warnings)).toEqual([]);
	});

	it("does not re-arm the prediction from an unreported cacheWrite bucket", async () => {
		const { telemetry, warnings } = driveSetup();

		// Turn 1: read 200 measured, write 0 measured — arms prediction 200.
		const first = await streamTurn(
			{ input_tokens: 1000, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
			{ output_tokens: 40 },
		);
		recordSentPayload(telemetry.config, { messages: [{ role: "user", content: "first" }] });
		const span1 = tracer.startSpan("chat turn1");
		await finishChatSpan(telemetry, span1, first, { stepNumber: 0 });
		span1.end();

		// Turn 2: read 300 measured, write OMITTED — read stays truthful, write is unknown.
		const second = await streamTurn({ input_tokens: 1500, cache_read_input_tokens: 300 }, { output_tokens: 40 });
		recordSentPayload(telemetry.config, {
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
		});
		const span2 = tracer.startSpan("chat turn2");
		await finishChatSpan(telemetry, span2, second, { stepNumber: 1 });
		span2.end();

		// Turn 3: read 250 measured — above the last TRUTHFUL prediction (200), so silence.
		// A re-arm from turn 2's unknown write would predict 300 and warn falsely here.
		const third = await streamTurn(
			{ input_tokens: 1600, cache_read_input_tokens: 250, cache_creation_input_tokens: 0 },
			{ output_tokens: 40 },
		);
		recordSentPayload(telemetry.config, {
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
				{ role: "user", content: "third" },
			],
		});
		const span3 = tracer.startSpan("chat turn3");
		await finishChatSpan(telemetry, span3, third, { stepNumber: 2 });
		span3.end();

		expect(span3.attributes[PiGenAIAttr.ReportedPrefixTokens]).toBe(250);
		expect(markerWarnings(warnings)).toEqual([]);
	});

	it("still warns on a measured short read — the gate does not weaken the detector", async () => {
		const { telemetry, warnings } = driveSetup();

		// Turn 1: both cache buckets measured — arms prediction 500.
		const first = await streamTurn(
			{ input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 0 },
			{ output_tokens: 40 },
		);
		recordSentPayload(telemetry.config, { messages: [{ role: "user", content: "first" }] });
		const span1 = tracer.startSpan("chat turn1");
		await finishChatSpan(telemetry, span1, first, { stepNumber: 0 });
		span1.end();

		// Turn 2: MEASURED read 200 < predicted 500 — the provider really did report
		// a shorter prefix, and the pure-append message list diverges at -1.
		const second = await streamTurn(
			{ input_tokens: 700, cache_read_input_tokens: 200, cache_creation_input_tokens: 0 },
			{ output_tokens: 40 },
		);
		recordSentPayload(telemetry.config, {
			messages: [
				{ role: "user", content: "first" },
				{ role: "user", content: "second" },
			],
		});
		const span2 = tracer.startSpan("chat turn2");
		await finishChatSpan(telemetry, span2, second, { stepNumber: 1 });
		span2.end();

		expect(span2.attributes[PiGenAIAttr.ReportedPrefixTokens]).toBe(200);
		expect(markerWarnings(warnings).some(message => message.includes("first_changed_item_index=-1"))).toBe(true);
	});
});

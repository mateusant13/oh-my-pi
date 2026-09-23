import { describe, expect, it } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

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
		headers: { "Content-Type": "text/event-stream", "request-id": "req_usage_unreported" },
	});
}

function jsonResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json", "request-id": "req_usage_unreported" },
	});
}

function fetchReturning(response: () => Response): FetchImpl {
	return (async () => response()) as FetchImpl;
}

/** Full conversation turn: message_start usage lacks BOTH cache fields entirely. */
function streamingTurnOmittingCache(usageAtDelta: Record<string, unknown>): Array<Record<string, unknown>> {
	return [
		{
			type: "message_start",
			message: { id: "msg_omit", usage: { input_tokens: 12, output_tokens: 1 } },
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: usageAtDelta },
		{ type: "message_stop" },
	];
}

withOfficialAnthropicEndpoint();

describe("anthropic: absent wire usage fields stay distinguishable from measured zero", () => {
	it("flags cacheRead/cacheWrite as unreported when no usage payload ever mentions them (streaming)", async () => {
		// Classic Anthropic stream shape: message_start reports input/output only;
		// message_delta carries output_tokens only. Nothing ever reports cache counts.
		const stream = streamSimple(model, context, {
			fetch: fetchReturning(() => sseResponse(streamingTurnOmittingCache({ output_tokens: 3 }))),
			apiKey: "test-anthropic-key",
		});
		const message = await stream.result();

		expect(message.usage.unreported).toEqual(["cacheRead", "cacheWrite"]);
		// Placeholders keep arithmetic total...
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.cacheWrite).toBe(0);
		expect(message.usage.input).toBe(12);
		expect(message.usage.output).toBe(3);
		expect(message.usage.totalTokens).toBe(15);
	});

	it("treats explicit cache zeros from the wire as measured, not unreported", async () => {
		const events: Array<Record<string, unknown>> = [
			{
				type: "message_start",
				message: {
					id: "msg_measured",
					usage: {
						input_tokens: 12,
						output_tokens: 1,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			},
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
			{ type: "content_block_stop", index: 0 },
			{
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					output_tokens: 3,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			},
			{ type: "message_stop" },
		];
		const stream = streamSimple(model, context, {
			fetch: fetchReturning(() => sseResponse(events)),
			apiKey: "test-anthropic-key",
		});
		const message = await stream.result();

		expect(message.usage.unreported ?? []).toEqual([]);
		expect(message.usage.cacheRead).toBe(0);
		expect(message.usage.totalTokens).toBe(15);
	});

	it("clears the flag when a later payload reports the bucket (cache arrives in message_delta)", async () => {
		const stream = streamSimple(model, context, {
			fetch: fetchReturning(() =>
				sseResponse(
					streamingTurnOmittingCache({
						output_tokens: 3,
						cache_read_input_tokens: 500,
						cache_creation_input_tokens: 0,
					}),
				),
			),
			apiKey: "test-anthropic-key",
		});
		const message = await stream.result();

		expect(message.usage.unreported ?? []).toEqual([]);
		expect(message.usage.cacheRead).toBe(500);
		expect(message.usage.cacheWrite).toBe(0);
		expect(message.usage.totalTokens).toBe(515);
	});

	it("flags every bucket when message_start carries no usage object at all", async () => {
		const events: Array<Record<string, unknown>> = [
			{ type: "message_start", message: { id: "msg_nousage" } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } },
			{ type: "message_stop" },
		];
		const stream = streamSimple(model, context, {
			fetch: fetchReturning(() => sseResponse(events)),
			apiKey: "test-anthropic-key",
		});
		const message = await stream.result();

		// Only message_delta's output_tokens was ever reported.
		expect(message.usage.unreported).toEqual(["input", "cacheRead", "cacheWrite"]);
		expect(message.usage.output).toBe(3);
		expect(message.usage.totalTokens).toBe(3);
	});

	it("flags cache buckets on the non-streaming max_tokens=0 refresh response (seam line 2272)", async () => {
		// The replay-only refresh request parses a JSON Message body; this fixture
		// omits both cache fields the way a non-caching anthropic-compatible
		// endpoint would.
		const stream = streamSimple(model, context, {
			fetch: fetchReturning(() =>
				jsonResponse({
					id: "msg_refresh_omit",
					type: "message",
					role: "assistant",
					model: model.id,
					content: [],
					stop_reason: "end_turn",
					usage: { input_tokens: 3, output_tokens: 0 },
				}),
			),
			apiKey: "test-anthropic-key",
			anthropicCacheRefreshRequest: true,
		});
		const message = await stream.result();

		expect(message.usage.unreported).toEqual(["cacheRead", "cacheWrite"]);
		expect(message.usage.input).toBe(3);
		expect(message.usage.output).toBe(0);
		expect(message.usage.totalTokens).toBe(3);
	});

	it("keeps a measured-zero cacheRead unflagged on the refresh path when the wire reports 0", async () => {
		const stream = streamSimple(model, context, {
			fetch: fetchReturning(() =>
				jsonResponse({
					id: "msg_refresh_measured",
					type: "message",
					role: "assistant",
					model: model.id,
					content: [],
					stop_reason: "end_turn",
					usage: { input_tokens: 3, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				}),
			),
			apiKey: "test-anthropic-key",
			anthropicCacheRefreshRequest: true,
		});
		const message = await stream.result();

		expect(message.usage.unreported ?? []).toEqual([]);
		expect(message.usage.cacheRead).toBe(0);
	});
});

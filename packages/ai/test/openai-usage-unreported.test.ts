/**
 * ORACLE (RED-FIRST, lane OmpCacheMirror) — OpenAI-family mappers must carry the
 * `Usage.unreported` mechanism the Anthropic path already has
 * (`ai/test/anthropic-usage-unreported.test.ts`).
 *
 * Plausible breakage these tests catch (name it or it is worthless):
 * an OpenAI-compatible server omits usage fields — an empty `usage: {}` object,
 * a core-less trailing usage-only chunk carrying only
 * `prompt_tokens_details.cached_tokens`, a Responses payload with no
 * `input_tokens` — and `parseChunkUsage` / `populateResponsesUsageFromResponse`
 * collapse the omission into a plain measured `0` via `?? 0` / `firstPositiveNumber`,
 * with no `unreported` marker. Downstream a fabricated cache `0` is then
 * indistinguishable from a provider-measured zero (telemetry stamps it as
 * `ReportedPrefixTokens`, cost math treats it as observed).
 *
 * The rule under test (mirrored from the SuperHarness fix): an omitted cache
 * field is a MEASURED ZERO only when core usage (`prompt_tokens` /
 * `completion_tokens`) is present; when core usage is absent the omission is
 * genuine UNKNOWN and must be flagged. The deciding inputs are the WIRE usage
 * payloads — no flag is supplied by the test to the mapper.
 *
 * Production path travelled (not the mapper unit): streamOpenAICompletions with
 * a captured fetch — the same request function a real turn takes — down to
 * `applyUsagePayload` → `parseChunkUsage`. The Responses cases drive
 * `populateResponsesUsageFromResponse`, the production Responses-API usage
 * parser, with wire payloads.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { populateResponsesUsageFromResponse } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type { AssistantMessage, Model, ModelSpec, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const gpt4oMiniSpec: ModelSpec<"openai-completions"> = (() => {
	const {
		compat: _resolved,
		compatConfig,
		...rest
	} = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">;
	return { ...rest, compat: compatConfig };
})();

const model: Model<"openai-completions"> = buildModel({
	...gpt4oMiniSpec,
	api: "openai-completions",
} as ModelSpec<"openai-completions">);

/** Content chunk, finish chunk, then the usage-only trailing chunk under test —
 * the `stream_options.include_usage` shape (`openai-completions.ts:1172-1176`):
 * a choiceless chunk after `finish_reason`, which the consumer finalizes
 * immediately instead of holding the post-finish grace window. */
async function streamUsage(usage: Record<string, unknown>): Promise<Usage> {
	const modelId = model.id;
	const events: unknown[] = [
		{
			id: "chatcmpl-unreported",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: { content: "Hi" } }],
		},
		{
			id: "chatcmpl-unreported",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		},
		{
			id: "chatcmpl-unreported",
			object: "chat.completion.chunk",
			created: 0,
			model: modelId,
			usage,
		},
		"[DONE]",
	];
	async function mockFetch(): Promise<Response> {
		const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
		return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
	}
	const context = { messages: [{ role: "user", content: "hello", timestamp: Date.now() }] };
	const result = await streamOpenAICompletions(model, context, {
		apiKey: "test-key",
		fetch: Object.assign(mockFetch, { preconnect: fetch.preconnect }),
	}).result();
	return result.usage;
}

function blankResponsesOutput(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("openai-completions: absent wire usage fields stay distinguishable from measured zero", () => {
	it("flags cacheRead/cacheWrite as unreported when the wire usage object is empty", async () => {
		const usage = await streamUsage({});

		expect(usage.unreported).toEqual(["cacheRead", "cacheWrite"]);
		// Placeholders keep arithmetic total...
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.totalTokens).toBe(0);
	});

	it("treats omitted cache details as measured zero when core usage is present", async () => {
		const usage = await streamUsage({ prompt_tokens: 100, completion_tokens: 10 });

		expect(usage.unreported ?? []).toEqual([]);
		expect(usage.cacheRead).toBe(0);
		expect(usage.cacheWrite).toBe(0);
		expect(usage.input).toBe(100);
		expect(usage.totalTokens).toBe(110);
	});

	it("keeps a reported cacheRead measured when core usage is absent but cache details arrived", async () => {
		// Trailing usage-only chunk shape: cache details with no core counts.
		const usage = await streamUsage({ prompt_tokens_details: { cached_tokens: 50 } });

		expect(usage.cacheRead).toBe(50);
		expect(usage.unreported).toEqual(["cacheWrite"]);
	});
});

describe("openai-responses: absent wire usage fields stay distinguishable from measured zero", () => {
	it("flags cacheRead/cacheWrite as unreported when the response usage is empty", () => {
		const output = blankResponsesOutput();
		populateResponsesUsageFromResponse(output, {});

		expect(output.usage.unreported).toEqual(["cacheRead", "cacheWrite"]);
		expect(output.usage.cacheRead).toBe(0);
		expect(output.usage.cacheWrite).toBe(0);
	});

	it("treats omitted cache details as measured zero when core usage is present", () => {
		const output = blankResponsesOutput();
		populateResponsesUsageFromResponse(output, {
			input_tokens: 100,
			output_tokens: 10,
			input_tokens_details: { cached_tokens: 20 },
		});

		expect(output.usage.unreported ?? []).toEqual([]);
		expect(output.usage.cacheRead).toBe(20);
	});
});

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * Oracle for the SessionAdvisors half of `69b91971fa` (announced
 * `openai-codex/gpt-6-luna:high`, executed `openai-codex/gpt-5.6-luna`).
 *
 * `SessionAdvisors.#recoverAdvisorTurn` must emit
 * `retry_fallback_applied.to` as the RESOLVED candidate — the model actually
 * swapped into the advisor — not `selector.raw`, the configured chain string:
 * a chain id unknown to the registry fuzzy-resolves to a different model, and
 * the event must describe the walk that happened. The sibling
 * `retry-fallback-announced-executed.test.ts` walks the TurnRecovery emitter;
 * this file walks the advisor emitter specifically (`role: "advisor"`).
 * Fails while `to` carries `selector.raw`.
 */
describe("advisor retry fallback announced-vs-executed parity", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-advisor-fallback-parity-");
		await initTheme();
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "parity.db"));
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");
		authStorage.setRuntimeApiKey("openai-codex", "openai-codex-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		modelRegistry.clearSuppressedSelectors();
		vi.restoreAllMocks();
	});

	it("announces the executed model when the advisor chain id is unknown to the catalog", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled primary model to exist");
		// Precondition that makes this a genuine divergence probe: the chain id
		// has no exact registry entry, so resolution falls through to fuzzy.
		expect(modelRegistry.find("openai-codex", "gpt-6-luna")).toBeUndefined();

		const primarySelector = `${primary.provider}/${primary.id}`;
		const advisorRoleSelector = `${primarySelector}:high`;
		const requestedAdvisorModels: string[] = [];
		const applied: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const succeeded: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const fallbackSucceeded = Promise.withResolvers<void>();
		const mainMock = createMockModel({ responses: [{ content: ["Primary complete"] }] });
		const advisorMock = createMockModel();

		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mainMock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { advisor: ["openai-codex/gpt-6-luna:high"] },
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", advisorRoleSelector);
		vi.spyOn(modelRegistry.authStorage, "markUsageLimitReached").mockResolvedValue({ switched: false });

		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			advisorTools: [],
			advisorConfigs: [{ name: "fallback-parity-test", model: advisorRoleSelector }],
			advisorStreamFn: (model, context, options) => {
				const selector = `${model.provider}/${model.id}`;
				requestedAdvisorModels.push(selector);
				if (selector === primarySelector) {
					advisorMock.push({
						throw: "Devin stream error failed_precondition: Your daily usage quota has been exhausted. Your quota will reset after 1s.",
					});
				} else if (selector === "openai-codex/gpt-5.6-luna") {
					advisorMock.push({ content: ["Advisor recovered"] });
				} else {
					throw new Error(`Unexpected advisor model requested: ${selector}`);
				}
				return advisorMock.stream(model, context, options);
			},
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") applied.push(event);
			if (event.type === "retry_fallback_succeeded") {
				succeeded.push(event);
				fallbackSucceeded.resolve();
			}
		});

		session.setAdvisorEnabled(true);
		await session.prompt("Complete one primary turn");
		await session.waitForIdle();
		// The catch-up gate releases immediately while the advisor is mid-failure
		// (a failing advisor must never park the primary), so waitForIdle can
		// return before the fallback retry lands — await the success event.
		await fallbackSucceeded.promise;

		// The walk executed the fuzzy-resolved model, not the configured chain id.
		expect(requestedAdvisorModels).toEqual([primarySelector, "openai-codex/gpt-5.6-luna"]);
		expect(applied).toHaveLength(1);
		// The oracle: the advisor's announced candidate IS the executed model.
		expect(applied[0]!.to).toBe("openai-codex/gpt-5.6-luna:high");
		// Emitter site: advisor role chain, advisor's own current selector as `from`.
		expect(applied[0]).toMatchObject({ from: advisorRoleSelector, role: "advisor" });
		expect(succeeded).toEqual([
			{ type: "retry_fallback_succeeded", model: "openai-codex/gpt-5.6-luna:high", role: "advisor" },
		]);
	});
});

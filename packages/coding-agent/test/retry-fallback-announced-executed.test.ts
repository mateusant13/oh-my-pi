import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
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
 * Oracle for the 2026-09-22 fallback-trace mismatch (announced `gpt-6-luna`,
 * executed `gpt-5.6-luna`).
 *
 * `retry_fallback_applied.to` must name the RESOLVED candidate — the model
 * actually swapped in — not the configured chain string: a chain id unknown
 * to the registry fuzzy-resolves to a different model, and the log must
 * describe the walk that happened. Fails while `to` carries `selector.raw`.
 */
describe("retry fallback announced-vs-executed parity", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-fallback-parity-");
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
	});

	it("announces the executed model when the chain id is unknown to the catalog", async () => {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primary) throw new Error("Expected bundled primary model to exist");
		// Precondition that makes this a genuine divergence probe: the chain id
		// has no exact registry entry, so resolution falls through to fuzzy.
		expect(modelRegistry.find("openai-codex", "gpt-6-luna")).toBeUndefined();

		const requestedModels: string[] = [];
		const applied: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		const succeeded: Array<Extract<AgentSessionEvent, { type: "retry_fallback_succeeded" }>> = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, options) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				if (model.provider === primary.provider && model.id === primary.id) {
					mock.push({ throw: "overloaded_error: provider returned error 503" });
				} else {
					mock.push({ content: [`ok:${model.provider}/${model.id}`] });
				}
				return mock.stream(model, context, options);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.fallbackChains": { default: ["openai-codex/gpt-6-luna:high"] },
		});
		settings.setModelRole("default", `${primary.provider}/${primary.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") applied.push(event);
			if (event.type === "retry_fallback_succeeded") succeeded.push(event);
		});

		await session.prompt("Recover from rate limits");
		await session.waitForIdle();

		// The walk executed the fuzzy-resolved model, not the chain string.
		expect(requestedModels).toEqual(["anthropic/claude-sonnet-4-5", "openai-codex/gpt-5.6-luna"]);
		expect(applied).toHaveLength(1);
		expect(succeeded).toHaveLength(1);
		// The oracle: the announced candidate IS the executed model.
		expect(applied[0]!.to).toBe("openai-codex/gpt-5.6-luna:high");
		expect(succeeded[0]!.model).toBe(applied[0]!.to);
	});
});

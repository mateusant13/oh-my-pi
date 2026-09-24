import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateLoadedBindings } from "../native/loader-state.js";

async function withStaleCandidate(run: (candidate: string) => void) {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-sentinel-control-"));
	const candidate = path.join(dir, "pi_natives.node");
	try {
		await fs.writeFile(candidate, "__piNativesV18_1_14");
		run(candidate);
	} finally {
		await fs.rm(dir, { recursive: true, force: true });
	}
}

const currentSentinel = "__piNativesV18_1_15";
const staleBindings = { __piNativesV18_1_14: () => {}, grep: () => {} };

describe("workspace sentinel durable RED instrument", () => {
	it("negative control: install-style load rejects stale bindings", async () => {
		await withStaleCandidate(candidate => {
			expect(() =>
				validateLoadedBindings(
					{ isWorkspaceLoad: false, packageVersion: "18.1.15", versionSentinelExport: currentSentinel },
					staleBindings,
					candidate,
				),
			).toThrow("reinstall to re-sync");
		});
	});

	it("workspace load rejects the same stale bindings", async () => {
		await withStaleCandidate(candidate => {
			expect(() =>
				validateLoadedBindings(
					{ isWorkspaceLoad: true, packageVersion: "18.1.15", versionSentinelExport: currentSentinel },
					staleBindings,
					candidate,
				),
			).toThrow("reinstall to re-sync");
		});
	});

	it("workspace load accepts bindings with the expected sentinel", async () => {
		await withStaleCandidate(candidate => {
			expect(() =>
				validateLoadedBindings(
					{ isWorkspaceLoad: true, packageVersion: "18.1.15", versionSentinelExport: currentSentinel },
					{ [currentSentinel]: () => {}, grep: () => {} },
					candidate,
				),
			).not.toThrow();
		});
	});
});

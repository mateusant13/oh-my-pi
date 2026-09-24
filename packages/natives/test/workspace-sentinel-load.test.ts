import { describe, expect, it } from "bun:test";
import * as childProcess from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import packageJson from "../package.json" with { type: "json" };

describe("workspace load infers and enforces the version sentinel", () => {
	it("rejects an addon whose version differs from the workspace package", async () => {
		const sourceNativeDir = path.join(import.meta.dir, "../native");
		const addonFiles = (await fs.readdir(sourceNativeDir)).filter(name => /^pi_natives\..+\.node$/.test(name));
		expect(addonFiles.length, "build/install a host native addon before this test").toBeGreaterThan(0);

		const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-natives-workspace-sentinel-"));
		const nativeDir = path.join(workspaceDir, "native");
		await fs.mkdir(nativeDir);
		try {
			await fs.copyFile(path.join(sourceNativeDir, "loader-state.js"), path.join(nativeDir, "loader-state.js"));
			await fs.copyFile(path.join(sourceNativeDir, "embedded-addon.js"), path.join(nativeDir, "embedded-addon.js"));
			for (const addonFile of addonFiles) {
				await fs.copyFile(path.join(sourceNativeDir, addonFile), path.join(nativeDir, addonFile));
			}
			await fs.writeFile(
				path.join(workspaceDir, "package.json"),
				JSON.stringify({ ...packageJson, version: "0.0.0-workspace-sentinel-test" }),
			);

			const loaderUrl = pathToFileURL(path.join(nativeDir, "loader-state.js")).href;
			const runner = `import { loadNative } from ${JSON.stringify(loaderUrl)};\ntry {\n  loadNative();\n  console.log("LOAD_SUCCEEDED");\n} catch (error) {\n  console.error(error instanceof Error ? error.message : String(error));\n  process.exitCode = 23;\n}`;
			const result = childProcess.spawnSync(process.execPath, ["-e", runner], {
				encoding: "utf8",
				windowsHide: true,
			});

			expect(result.error, result.error?.message).toBeUndefined();
			expect(result.status, result.stderr || result.stdout).toBe(23);
			expect(result.stderr).toContain("does not expose the @oh-my-pi/pi-natives@0.0.0-workspace-sentinel-test version sentinel");
			expect(result.stderr).toContain("reinstall to re-sync");
			expect(result.stdout).not.toContain("LOAD_SUCCEEDED");
		} finally {
			await fs.rm(workspaceDir, { recursive: true, force: true });
		}
	}, 20_000);
});

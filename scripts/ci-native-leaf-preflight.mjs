#!/usr/bin/env node
/**
 * PR native-leaf version preflight.
 *
 * The PR path of `.github/workflows/ci.yml` never builds the native addons; it
 * fetches the published `@oh-my-pi/pi-natives-linux-x64` leaf instead. That
 * fetch must resolve to the version THIS checkout declares: workspace loads now
 * enforce the version sentinel, so a leaf from another release makes every
 * native-dependent TS job fail for the wrong reason.
 *
 * Reads (no inputs are supplied by the caller — the deciding values come from
 * the repo itself):
 *   - `packages/natives/package.json` `"version"` — the checkout's declared version
 *   - every `@oh-my-pi/pi-natives-linux-x64@<spec>` fetch token in
 *     `.github/workflows/ci.yml` — what CI will actually request
 *
 * A spec may be a literal/dist-tag (resolved against the npm registry) or
 * `${var}` where the workflow derives `var` straight from the manifest's
 * `"version"` field (the derivation line is matched exactly). Anything else —
 * no fetch token found, an unrecognized derived form, a derivation from another
 * source, or a registry version that differs from the declared one — exits RED
 * (1). Matching versions exit GREEN (0).
 */

import { readFileSync } from "node:fs";

const MANIFEST = "packages/natives/package.json";
const WORKFLOW = ".github/workflows/ci.yml";
const LEAF = "@oh-my-pi/pi-natives-linux-x64";
const REGISTRY_LEAF = "@oh-my-pi%2Fpi-natives-linux-x64";
const DERIVATION = String.raw`require('./packages/natives/package.json').version`;

function red(reason) {
	console.log(`native leaf version preflight: RED — ${reason}`);
	process.exit(1);
}

const declared = JSON.parse(readFileSync(MANIFEST, "utf8")).version;
if (!declared) red(`${MANIFEST} has no "version" field`);

const workflow = readFileSync(WORKFLOW, "utf8");
// Only code lines count: a comment mentioning the leaf is not the fetch, so a
// stale `# was @latest` note can never stand in for the live fetch token.
const specs = [];
for (const [i, line] of workflow.split(/\r?\n/).entries()) {
	if (line.trimStart().startsWith("#")) continue;
	const code = line.replace(/\s+#.*$/, "");
	const m = /@oh-my-pi\/pi-natives-linux-x64@([^\s"'`)]+)/.exec(code);
	if (m) specs.push({ spec: m[1], line: i + 1 });
}
if (specs.length === 0) {
	red(`no ${LEAF}@<spec> fetch token found in ${WORKFLOW} code; fetch/checkout alignment cannot be proven`);
}

console.log(`native leaf version preflight`);
console.log(`  checkout declared : ${declared}  (${MANIFEST} "version")`);

for (const { spec, line } of specs) {
	let target = spec;
	let origin = `literal spec`;
	const derivedVar = /^\$\{(\w+)\}$/.exec(spec);
	if (derivedVar) {
		const [, name] = derivedVar;
		const derivation = new RegExp(
			`${name}=\\s*"\\$\\(node -p "require\\('\\./packages/natives/package\\.json'\\)\\.version"\\)"`,
		);
		if (!derivation.test(workflow)) {
			red(`fetch spec ${spec} in ${WORKFLOW} is not derived as ${name}="$(node -p "${DERIVATION}")"`);
		}
		target = declared;
		origin = `derived from ${MANIFEST} "version"`;
	} else if (spec.includes("$")) {
		red(`fetch spec ${spec} in ${WORKFLOW} uses an unrecognized derivation; only \${var} from ${DERIVATION} is allowed`);
	}

	let published;
	try {
		const res = await fetch(`https://registry.npmjs.org/${REGISTRY_LEAF}/${encodeURIComponent(target)}`);
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		published = (await res.json()).version;
	} catch (err) {
		published = `<not published: ${err.message}>`;
	}

	console.log(`  fetch spec        : ${spec}  (${WORKFLOW}:${line})`);
	console.log(`  resolves to       : ${target}  (${origin})`);
	console.log(`  published leaf    : ${published}  (registry ${LEAF}@${target})`);

	if (published !== declared) {
		red(`CI would fetch ${published} while the checkout declares ${declared}`);
	}
}

console.log(`native leaf version preflight: GREEN — every ${LEAF} fetch resolves to the declared ${declared}`);

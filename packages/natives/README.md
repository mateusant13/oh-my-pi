# @oh-my-pi/pi-natives

Native Rust functionality via N-API.

## What's Inside

- **Grep**: Regex-based search powered by ripgrep's engine with native file walking and matching
- **Find**: Glob-based file/directory discovery with gitignore support (pure TypeScript via `globPaths`)
- **SIXEL**: Terminal image encoding for SIXEL-capable terminals (decode, resize, encode in one pass)
- **Audio**: Cross-platform low-latency microphone capture and gapless speaker playback
- **WebRTC**: Native Opus media, SDP offer/answer negotiation, and data-channel events for live sessions
- **File locking**: Process-owned cross-process locks with in-memory kernel names on Linux/Windows and `flock(2)` sidecars on other Unix platforms
- **PDF**: In-memory PDF-to-Markdown extraction with OCR-page classification via `pdf-inspector`

General-purpose image processing (decode/resize/encode for files and buffers)
lives in [`Bun.Image`](https://bun.com/docs/runtime/image) on the JS side; this
crate only ships the SIXEL encoder because no built-in equivalent exists for
that terminal protocol.

## Usage

```typescript
import { encodeSixel, grep, pdfToMarkdown } from "@oh-my-pi/pi-natives";

// Grep for a pattern
const results = await grep({
	pattern: "TODO",
	path: "/path/to/project",
	glob: "*.ts",
	context: 2,
});

// Find files
const files = await find({
	pattern: "*.rs",
	path: "/path/to/project",
	fileType: "file",
});

// SIXEL encode for a terminal cell box (px)
const sequence = encodeSixel(pngBytes, widthPx, heightPx);

// Extract PDF text and identify pages that still need OCR
const pdf = await pdfToMarkdown(pdfBytes);
console.log(pdf.markdown, pdf.pagesNeedingOcr);
```

## Building

From a fresh clone, use the workspace setup command at the repository root:

```bash
bun setup
```

This installs workspace dependencies and builds `@oh-my-pi/pi-natives`; re-run
`bun run build:native` after changing Rust crates or `packages/natives`
(`README.md` at the repository root describes this setup path).

### Windows GNU toolchain prerequisites

Before running `bun setup` with the `x86_64-pc-windows-gnu` Rust toolchain,
install these packages in an MSYS2 MinGW x64 shell:

```bash
pacman -S --needed mingw-w64-x86_64-cmake mingw-w64-x86_64-ninja mingw-w64-x86_64-nodejs
export PATH="/mingw64/bin:$PATH"
```

Keep `/mingw64/bin` on `PATH` when running `bun setup`. The local native build
uses CMake and Ninja for the bundled Opus build (`packages/natives/scripts/build-bindings.ts:24-54`;
`.cargo/config.toml:17-21` selects Ninja). The GNU-Windows N-API setup searches
`LIBNODE_PATH`, `LIBPATH`, and `PATH` for `libnode.dll`, then links the `node`
library (`napi-build 2.4.1`, `windows.rs:4-16,19-41`); the MinGW Node package
provides both `libnode.dll` and its import library `libnode.dll.a`. The stock
Windows Node distribution's `node.exe` and `node.lib` do not provide these GNU
link inputs. MSYS2 `mingw-w64-x86_64-nodejs` 24.8.0-2 was used to build and
verify this path.

For other host toolchains, install Rust and run `bun setup` from the repository
root; the native build script can discover CMake/Ninja from Visual Studio on
Windows when those components are installed (`build-bindings.ts:24-54`).

```bash
# Type check the package
bun --cwd=packages/natives run check
```

## Architecture

`@oh-my-pi/pi-natives` publishes a small core package plus generated
platform-specific optional dependency packages:

```
crates/pi-natives/       # Rust source (workspace member)
  src/lib.rs             # N-API exports
  src/sixel.rs           # SIXEL terminal-image encoding
  Cargo.toml             # Rust dependencies
native/                  # Core loader files and local/CI native build outputs
  index.js               # Public native export surface
  loader-state.js        # Platform, ISA variant, and addon resolution
  embedded-addon.js      # Standalone binary embed stub/generated metadata
  pi_natives.<platform>-<arch>-modern.node   # x64 modern ISA (local/CI artifact)
  pi_natives.<platform>-<arch>-baseline.node # x64 baseline ISA (local/CI artifact)
  pi_natives.<platform>-<arch>.node          # non-x64 build artifact
npm/<platform>-<arch>/   # Generated at publish time, not committed
  package.json           # @oh-my-pi/pi-natives-<platform>-<arch>
  *.node                 # Only that platform's addon binary or x64 ISA variants
```

The published core package contains only the JS loader, declarations, README,
and `package.json`. Release publishing generates one leaf package per supported
`os`/`cpu` pair and injects those leaves into the core manifest as pinned
`optionalDependencies`, so package managers install only the host platform's
native addon. x64 leaves include every built ISA variant, and the loader keeps
choosing between `baseline` and `modern` at runtime.

# Third-party notices

The [MIT License](LICENSE) covers Outrunner's original source. Dependencies,
fonts, and bundled tools retain their upstream licenses and copyright notices.

## Code and assets included with this repository or its builds

| Component | Used in | License notice |
| --- | --- | --- |
| [shadcn/ui](https://github.com/shadcn-ui/ui) | UI components adapted in `components/ui/` | [MIT](licenses/shadcn-ui.txt) |
| [Geist](https://github.com/vercel/geist-font) | `public/fonts/GeistPixel_Square.woff2` | [SIL Open Font License 1.1](public/fonts/OFL.txt) |
| [creack/pty](https://github.com/creack/pty) | Go runtime-agent and CLI | [MIT](licenses/creack-pty.txt) |
| [gorilla/websocket](https://github.com/gorilla/websocket) | Go runtime-agent and CLI | [BSD 2-Clause](licenses/gorilla-websocket.txt) |
| [tmux](https://github.com/tmux/tmux) | Bundled Mac sidecar | [ISC](licenses/tmux.txt) |
| [libevent](https://github.com/libevent/libevent) | Linked into the Mac tmux sidecar | [Upstream notices](licenses/libevent.txt) |
| [utf8proc](https://github.com/JuliaStrings/utf8proc) | Linked into the Mac tmux sidecar | [MIT and Unicode notices](licenses/utf8proc.txt) |
| [jemalloc](https://github.com/jemalloc/jemalloc) | Linked into the Mac tmux sidecar | [BSD](licenses/jemalloc.txt) |

The Go standard library and runtime retain the
[Go project's BSD license](licenses/go-runtime.txt).

The Mac app's resource bundle includes these notices and licenses. CLI npm
packages include Outrunner's license and the licenses for the Go dependencies
they distribute. Font redistribution must include its OFL notice; the font
is not relicensed under MIT.

## Installed dependencies and agent tools

JavaScript, Rust, and Go dependencies are recorded in `package.json`,
`pnpm-lock.yaml`, `runtime-desktop/src-tauri/Cargo.lock`, and
`runtime-agent/go.mod` / `go.sum`. Their packages contain their own license
terms. Preserve those notices when redistributing a build; this file is not
an exhaustive inventory of transitive dependencies.

Claude Code, Codex, provider SDKs, and other tools installed in sandbox images
are separate projects with their own licenses or service terms. Outrunner's
license does not relicense those tools or grant access to their services.

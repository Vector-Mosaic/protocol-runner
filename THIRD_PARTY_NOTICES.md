# Third-party software

Protocol Runner source is released under the MIT license in `LICENSE`.
Dependencies keep their own licenses. The pinned dependency graph is recorded in
`pnpm-lock.yaml`; installing it obtains each package with its own copyright and
license files. This source repository does not redistribute a packaged Electron
runtime, browser binary or installed dependency tree.

Direct runtime dependencies include SQL.js (SQLite compiled to WebAssembly), React,
React DOM, Lucide React and Express. Build and development dependencies include
TypeScript, Vite, SWC, ESLint, Vitest, Testing Library, jsdom and Electron. Consult
each installed package's license before redistributing a bundled application.

Codex is a separately installed OpenAI product, and Discord is an optional external
service. Neither product is bundled or relicensed by this repository. This project
is independently maintained and is not an OpenAI or Discord product.

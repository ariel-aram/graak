@AGENTS.md

## Gemini CLI and Antigravity

- The shared rules above apply in full: definition of done, scope discipline, git, parallel work.
- Run each independent gap (TLS client options, `dns`, Brotli, DH/ECDH, HTTP/2, `node:test`) as its own agent in its own git worktree
  or branch. Agents never edit the same files. `quickjs/native`, `quickjs/prebuilt`, generated `intl-*.js` and `dist/` are
  single-writer: one agent owns them at a time, and all C work is merged before the one `bun run prebuilts`.
- Before handing back, an agent lists the commands it ran (Biome, `tsc`, `bun run build`, the suite, the corpus it diffed against Node.js
  24.21.0 and 26.9.0) and their results, and names anything it skipped and why.
- Long jobs (Intl data generation, `bun run prebuilts`, Wine and Docker tests) run as background terminals; confirm the job finished
  before reading its output.
- Commit locally after green checks; do not push unless the user asks.

### Verification Workflow

- `bunx biome check --write`
- `bun run typecheck`
- `bun run build`
- `bun run test`
- For runtime changes: compare against Node 24.21.0 and 26.9.0 differential corpora under `test/fixtures/web/`.
- For C changes: `bun run prebuilts`, Wine verification in `fg-wine` container.

### Silent Mode

- Adhere strictly to silent mode: terse verdicts (`pass` / `fail` + check name) and blocker questions only. No unsolicited narration or lengthy summaries.

# dsh-tamer · AI Taming Tool (DeepSeek Harness plugin)

> Turns the "AI Taming Tool" work protocol into a native DSH plugin: the protocol enters the
> system prompt, strictness modes are explicit per-session state, the external memory file and
> archive repository are wired in, and **an answer that cites no sources for factual claims is
> automatically sent back for revision**.

中文文档：[README.zh.md](README.zh.md)

---

## Capabilities

| Capability | Mechanism | Strength |
|---|---|---|
| Protocol in the system prompt | `ctx.systemPrompt.section()` | every request |
| Three modes (fast / standard / strict) | `/tamer` command + per-session state | explicit, survives turns |
| External memory injection | `记忆库/约定.md` → session context | on session start + on change |
| Re-assert protocol every N turns | `agent.inject()` | mitigates long-session drift |
| **Missing sources → send back for revision** | `agent/turn-stopping` + `agent.steer()` | enforcement |
| Optional execution gate | `tools/pre-execute` → `ask` | off by default |
| Source archival | `tamer_archive` tool | writes to `留痕仓库/` |
| UI presence (browser half) | `client.js` → dock badge in `conversation.composer.dock` | shows the plugin is live + the three modes |
| Single source of truth for the protocol | `scripts/gen-protocol.mjs` | generated from `core/协议注入模板.txt` |

## Install

### Preferred (verified path on this machine): install it from the sidebar

1. Sidebar → **Plugins**
2. **Add plugin** (or the arrow → **Install a third-party plugin**)
3. Paste the **absolute local path**: `<工作区>\dsh-tamer` → **Install**

The install dialog accepts a package name (optionally versioned), a Git address, a tarball, or an
absolute local path (`ui-plugin-manager/README.md:46,53`); a local directory is recorded as a
`link:` dependency, like the `dsh-at-file` and `dshmarket` entries already in this profile.

**Prerequisite: `pnpm` must be on PATH** — the plugin manager runs it as an external command
(`pnpmCommand` defaults to `'pnpm'`, resolved through PATH; a missing one is reported as
`pnpm-missing`). Installed here at user level:

```powershell
npm i -g pnpm     # installs into the per-user npm global directory under %USERPROFILE%; Node install untouched
```

This plugin has **no dependencies and no lifecycle scripts**, so no build-script approval is asked.

### Alternative: plugin manager in Creator mode

In a session using the **`cordis` preset**, run `plugin_manager: install_bundle` with
`target = <工作区>\dsh-tamer`. The `plugin_manager` tool is `disabled: true` in the `standard`
preset, and presets are selected **per session**, so agent-side installation needs a new session.

### Alternative: CLI (`dsh` is not on PATH on this machine)

```powershell
dsh plugin --profile desktop add <工作区>\dsh-tamer
```

> DSH startup is all-or-nothing: one failing plugin exits the process. To roll back, add
> `disabled: true` to the `- id: dsh-tamer` row in
> `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`, or use the plugin page's failure
> recovery. This plugin touches no system resources, needs no network, and has no dependencies.

### Packaging (build artifact)

The plugin is a zero-build design — `index.js`, `client.js` and `src/*` *are* the runtime
artifact. Distribution still needs one:

```powershell
node scripts/pack.mjs      # verify → pack → validate → unpack and load, in one run
```

It writes `dist/dsh-tamer-0.1.0.tgz` (git-ignored), prints its sha256 and file list, then
**extracts it and imports the packed entry with plain Node** — a missing `src/` module fails the
run on the spot. Install the tarball with
`dsh plugin --profile desktop add "<abs path to tgz>"` or the Plugins page's Add plugin.

> ⚠️ A tarball install **copies** the package in, while the current install is a `link:`
> (Junction) that reads your source tree — source edits apply to the link on restart, but a
> tarball install must be re-packed and re-installed.

## Usage

```
/tamer fast|standard|strict      switch mode
/tamer status                    show mode, turn count, censor setting, paths
/tamer memory                    list external memory entries
/tamer remember <text>           append a long-term rule
/tamer forget <keyword>          remove matching rules
```

## Configuration

Edit the `config:` block of the `- id: dsh-tamer` row in `cordis.patch.yml`
(HMR applies it in about a second):

| Field | Default | Meaning |
|---|---|---|
| `mode` | `standard` | default mode |
| `censor` | `warn` | `off` / `warn` (one revision) / `strict` (up to two) |
| `reinjectEvery` | `0` (off) | re-assert the protocol every N turns. **Off by default**: the protocol section rides every request through `systemPrompt.section()`, so re-assertion is a patch for "inject once" browser plugins — raise it (e.g. 30) only if needed |
| `protocolOrder` | `9000` | order of the protocol section in the system prompt |
| `execGate` | `off` | `ask` = confirm before mutating tools when no source lookup ran |
| `memoryFile` / `archiveRoot` | auto | resolved from the session cwd when empty |

v0.1 deliberately exports no Cordis `Config` (schemastery) schema, keeping the plugin
dependency-free; invalid values warn and fall back to defaults instead of throwing.

## Keys

The plugin itself needs **no** API key. Keys matter only for the companion R2 setup
(pointing DSH at the `saddle` gateway): fill `dsh-tamer\.env.local` (git-ignored), whose
template is `.env.example`. See [接入指引_R2.md](接入指引_R2.md).

## Development

```powershell
node --test "tests/*.test.mjs"          # 60 zero-dependency tests
node scripts/gen-protocol.mjs           # regenerate src/protocol.js
node scripts/gen-protocol.mjs --check   # drift check
node scripts/check.mjs                  # syntax + manifest + wiring + drift
```

## Browser half

`client.js` registers itself through `window.__ModuleLoader__.load({ id: 'dsh-tamer', factory })`
and contributes a small, non-interactive dock badge under the composer plus a `zh`/`en` locale
dictionary (`ctx.locale.register`). It is **deliberately static**: reading the live mode from the
host would require an extra Typert Remote service, so the badge never claims a mode it cannot
verify. Use `/tamer status` for live state.

## Bypass paths and irreducible limits (real case, 2026-10-11)

A real session asked for strict mode **and** "do not list any sources in the reply". The model did not
silently comply, nor did it use the protocol against the owner: it surfaced the conflict and moved the
per-item source mapping into a separate file. The source check **did not fire**, for two overlapping
reasons:

1. **Judgement error (fixable)** — the reply contained the word 出处 ("verify the 出处 of these
   constants"), which the substring-based `sourced()` counted as a citation. Plan: require structure
   instead of substrings — a link, an `[n]` marker, or a line-anchored `来源：` label.
2. **Protocol gap (fixable)** — the protocol only describes "list sources at the end of the reply" and
   gives "sources in a separate file" no legal slot, so this conflict repeats every time.

**Why such bypasses cannot be fully eliminated.** The owner may authorise an exception — clause 3
("the owner decides") makes obeying it *correct*, not a hole, and any rule that lets the owner specify
exceptions is bypassable by construction. The model's default bias is to be helpful, so without explicit
authorisation it looks for a path that satisfies both sides rather than refusing or pushing back (the
protocol's "right to disagree" exists precisely to make pushing back an encouraged behaviour).
And "does this reply cite sources" has no perfect formal test over natural language: detection always
lags expression.

**Design stance — do not chase unreachable invariants.** Make bypasses *visible* (the load log records
`censor-retry`; sources land in the archive; a relocated source list must be pointed at from the reply),
*authorised* (an explicit request, fast mode, or `censor: off`), and *conservative* (`warn` by default —
one revision, never data loss). The source check is a step from "reminder" towards "enforcement", not a
security boundary; the real backstop is the archive, the log, and the owner's review.

## Honest limitations

- **Not yet load-verified against a live profile.** The code follows the official source
  (citations in README.zh.md), and 60/60 tests pass, but loading into the `desktop` profile
  has not been executed — it changes your DSH profile and needs your explicit go-ahead.
- **DSH startup is all-or-nothing**, so the entry module deliberately has **no bare static
  imports**: every `@deepseek-ai/*` dependency is loaded with a runtime `import()` inside
  `try/catch`, and a failure degrades only the affected feature (with a warning) instead of
  failing the plugin row. The archive tool registers a raw `ToolDefinition` rather than going
  through `defineTool`, so it needs no import at all.
- The source check is **heuristic**, not semantic; a false positive costs one revision, never data.
- Revision is capped (1 for `warn`, 2 for `strict`) to avoid a model loop.
- The protocol section is still a **soft** constraint; only the revision and the optional gate enforce.
- The browser half is a **static badge** (see above); the visual result is not covered by tests.

## License

MIT

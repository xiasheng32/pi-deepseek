# Changelog

All notable changes to this project are documented in this file.
Versions follow [Semantic Versioning](https://semver.org/); dates are release dates.

## [0.1.5] - 2026-10-21

### Added
- The footer balance status now appears only while the active model belongs to the `deepseek` provider: after Ctrl+P or `/model` switches to another provider, the `pi-deepseek` status entry is cleared instead of leaving a stale balance from the previous provider.
- Leaving the provider also pauses the 60-second poll and disposes the controller (aborting the in-flight request and dropping the cached snapshot); returning to `deepseek` refreshes immediately once and resumes polling. Starting on a non-`deepseek` model resolves no credentials, makes no network request, and shows no footer entry.
- `/pi-deepseek` still works on any provider: it forces a refresh and opens the detail panel as before, but never writes the footer status.
- Added `tests/extension.test.ts` wiring tests (`node:test` with mock timers) covering hide-on-switch, restore-on-switch-back, no polling while hidden, zero requests when starting on another provider, a usable command that keeps the footer hidden, and cached reuse for same-provider model changes; 36 offline tests in total.

### Changed
- `agent_settled` no longer triggers a refresh when the active provider is not `deepseek`.
- Non-TUI and offline behavior are unchanged.

## [0.1.4] - 2026-10-21

### Fixed
- Fixed real accounts showing `🐳 DeepSeek 数据异常`. DeepSeek returns signed balances (for example `topped_up_balance` of `"-0.23"` after granted credit is clawed back), and the old validator only accepted non-negative values, so a valid response was treated as malformed. Total, granted, and topped-up balances are now parsed and displayed with their original sign.
- Validation stays strict: only an optional minus sign followed by up to 18 integer digits and 8 decimals is accepted; exponent notation, whitespace, Unicode minus signs, and repeated signs are still rejected, so unvalidated data is never rendered.
- Added 2 tests covering signed balance parsing, footer/detail rendering of the real response shape, and malformed-format rejection; 30 offline tests in total.

## [0.1.3] - 2026-10-17

### Changed (rename migration)
- Renamed the repository and package from `deepseek-balance` to `pi-deepseek`, updating package metadata, repository links, and install/update commands while retaining the root project layout.
- Renamed `/deepseek-balance` to `/pi-deepseek` and the footer status key to `pi-deepseek`. The old command is no longer registered; custom footers must update their status key.
- Renamed the entry, core test, and standalone deployment files to `pi-deepseek.ts` and `pi-deepseek.test.ts`; generated bundle headers now identify the repository rather than a local path.
- Added migration instructions for GitHub sources, standalone copies, and footer settings in both READMEs; package and lockfile root versions are now 0.1.3. Balance queries, credential sources, refresh policy, and UI behavior are unchanged.

## [0.1.2] - 2026-10-15

### Added
- Added `CHANGELOG.md` and `CHANGELOG.en.md` covering the full history since v0.1.0.
- Added the English document `README.en.md`; line 2 of both READMEs provides the language switch links.

### Changed
- Both READMEs now follow the standard section order (Features / Installation / Usage / Configuration / Development and testing / Project structure / Version history / License); per-version update notes moved into this file.

## [0.1.1] - 2026-10-11

### Added
- Added `npm run typecheck` for strict type checking and `npm run check` for combined validation.
- Added the strict `tsconfig.json` (unused-declaration checks, erasable-syntax restrictions) and the locked development dependencies in `package-lock.json`.
- Added 2 synchronization tests using temporary directories and a temporary HOME, for 28 offline tests in total.

### Changed
- All project-maintained code is TypeScript. Tests and the synchronization script run natively in Node without an extra TypeScript runner or compiled artifacts.
- Balance queries, forced refreshes, the detail panel, and footer behavior are unchanged. No new runtime dependencies.

## [0.1.0] - 2026-10-07

### Added
- First release: a persistent footer status showing the DeepSeek account balance, colored by availability.
- The `/deepseek-balance` command forces a refresh and opens a panel showing the total, granted, and topped-up balance for each currency, plus account status.
- Refresh policy: query at startup, poll every 60 seconds, throttle to 30 seconds after the agent settles, exponential backoff and 429 cooldown, 10-second request timeout.
- Credentials are resolved through pi's model registry; the repository contains no hardcoded keys.
- The `npm run sync-autoload` script generates a self-contained autoload copy.
- 26 offline unit tests.

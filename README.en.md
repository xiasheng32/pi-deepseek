# pi-deepseek

[简体中文](README.md) | [English](README.en.md)

> A [pi](https://pi.dev) extension that displays your DeepSeek account balance in the footer and provides a `/pi-deepseek` command for a detailed balance panel.

## Features

- **Persistent footer status (DeepSeek only):** displays `🐳 DeepSeek 余额：¥110.00` while the active model belongs to the `deepseek` provider, with colors indicating account availability or missing credentials; the entry is hidden and polling stops when another provider is selected. The extension's UI labels remain in Chinese.
- **`/pi-deepseek` command:** forces a refresh and opens a panel showing the total, granted, and topped-up balance for each currency, plus account status.
- **Automatic refresh:** queries at session startup, polls every 60 seconds, and attempts a refresh after the agent settles with a 30-second throttle. Failures use exponential backoff; each request has a 10-second timeout.
- **No hardcoded keys:** credentials come from pi's model registry. The repository contains no API keys.

## Installation

Requires Node.js >=22.19 and a pi host exposing `modelRegistry.getApiKeyForProvider()`. The verified host version is **1.0.4**. Runtime execution and offline tests need no additional dependency installation; pi supplies the host packages. Project-maintained TypeScript runs natively in Node. Development type checking requires the development dependencies.

### Option 1: Local path for development or a trial

After cloning, run these commands from the project root containing `package.json` (or the `package/` directory after extracting a `.tgz`):

```bash
cd pi-deepseek

# Offline trial for this run only: no other extensions, configuration writes,
# credential resolution, or balance queries
pi --offline -ne -e .

# Online trial for this run only: interactive startup queries the real account
pi -ne -e .

# Install persistently when ready; this writes pi's package configuration
pi install .
```

Restart pi or run `/reload` in an existing session. Use `pi list` to see configured packages.

### Option 2: Install from GitHub

```bash
pi install git:github.com/xiasheng32/pi-deepseek
pi update git:github.com/xiasheng32/pi-deepseek  # Update an existing installation
```

For GitHub package installations, the startup `[Extensions]` compact list shows `xiasheng32/pi-deepseek` without the entry filename, matching pi-codex. The package entry is `extensions/index.ts`; standalone autoload copies keep the `pi-deepseek.ts` filename.

### Option 3: Generate a standalone autoload file

`extensions/index.ts` depends on `../src/balance.ts` and cannot be copied on its own. Explicitly generate a self-contained file from the project root:

```bash
npm run sync-autoload
# Overwrites ~/.pi/agent/extensions/pi-deepseek.ts by default;
# then run /reload in pi

# Or generate a local file without modifying the active extension
npm run sync-autoload -- /tmp/pi-deepseek.ts
```

**Enable either the installed package or the standalone autoload copy, never both.** Loading both may register duplicate commands, statuses, and queries. If a standalone copy exists, disable the old source with `pi config`, or back it up and move it out of the autoload directory. The trial commands use `-ne` to isolate other extensions. The synchronization script only updates the selected output file, not other extensions or configuration.

### Migrating from deepseek-balance (renamed in v0.1.3)

- The package, command, and footer status key are now `pi-deepseek`. Use `/pi-deepseek` for details; the old `/deepseek-balance` command is no longer registered. Update `deepseek-balance` to `pi-deepseek` in custom footer settings such as `footerLine2Keys`.
- For a GitHub installation, remove the old source before installing the renamed repository to avoid loading both:

```bash
pi remove git:github.com/xiasheng32/deepseek-balance
pi install git:github.com/xiasheng32/pi-deepseek
```

- For standalone deployments, disable the old copy or back up and move `~/.pi/agent/extensions/deepseek-balance.ts` out of autoload before running `npm run sync-autoload` to generate `pi-deepseek.ts`. Do not enable both copies.
- The repository is now `github.com/xiasheng32/pi-deepseek`; GitHub redirects the old URL. Existing clones can run `git remote set-url origin https://github.com/xiasheng32/pi-deepseek.git`. Pi still manages credentials, and `DEEPSEEK_API_KEY` and `/login deepseek` are unchanged. Restart pi or run `/reload` after migrating.

## Usage

- Start `pi` to see the DeepSeek balance in the footer.
- The footer entry appears only while the active model belongs to the `deepseek` provider: Ctrl+P or `/model` to another provider clears it immediately and pauses background polling, and switching back restores it with an immediate refresh. If pi starts on a non-`deepseek` model, the balance is never queried.
- Run `/pi-deepseek` to force a refresh and open the detail panel. Close it with `Enter`, `Esc`, or `q`. Scroll overflowing content with `↑` / `↓`; use `Home` / `End` to jump to the beginning or end. The command works on any provider but never brings the footer entry back.
- Without credentials, the footer shows `🐳 DeepSeek 未配置` (not configured), and the command reports the missing configuration.

### Refresh policy and status

The refresh policy follows `pi-codex`, but this package runs independently and does not depend on a neighboring project.

- Interactive startup queries without blocking, then polls every 60 seconds and attempts a refresh on `agent_settled`. Automatic requests are at least 30 seconds apart. Starting on a model outside the `deepseek` provider resolves no credentials, makes no network request, and shows no footer entry.
- The footer entry and polling are DeepSeek-only: on `model_select` away from the provider the status entry is cleared, the 60-second poll stops, and the controller is disposed (in-flight request aborted, cached snapshot dropped); returning refreshes immediately once and resumes polling. Changing models inside the provider only repaints the status text and makes no extra request.
- Only one refresh runs at a time; concurrent callers share the same Promise. Each request resolves credentials through pi again instead of caching the API key. Credential changes, HTTP 401/403, or logout clear old data.
- Each request has a 10-second timeout. Automatic retries after a failed balance query back off from 60 seconds (60 → 120 → 240 seconds), capped at 5 minutes. HTTP 429 honors `Retry-After` in seconds or HTTP-date form; manual refresh cannot bypass this cooldown.
- While refreshing, the footer shows `🐳 DeepSeek[更新中] 余额：…` in the accent color and keeps the previous value. Network or data errors retain the last successful value with `🐳 DeepSeek[过期] 余额：…` in the warning color. The panel warns that the stale cache does not represent the current balance. The stale marker takes precedence over the refreshing marker.
- Missing credentials show `🐳 DeepSeek 未配置` without entering backoff. After a key is configured, refresh can resume at the next throttle window. Unavailable accounts use the warning color and `⚠`.
- Detail timestamps use the local time zone and `YYYY-MM-DD HH:MM` format.
- Closing, switching, or reloading sessions clears timers, cancels requests, and ignores late results. State is isolated per session rather than stored in a module-level singleton.

Offline mode skips credential resolution as well as network requests, including manual refresh:

```bash
pi --offline -ne -e .
# Or: PI_OFFLINE=1 pi -ne -e .
```

### Security and API limitations

- Sends GET requests only to the fixed endpoint `https://api.deepseek.com/user/balance`, rejecting redirects. Queries do not spend the balance.
- Does not log API keys, raw authentication errors, or complete responses. Network and data failures display sanitized status messages.
- Extensions have the same system permissions as pi. Load trusted source code only. Real account and network access are outside the offline tests.

## Configuration

pi's model registry resolves credentials. The extension does not read `auth.json` directly or save its own API key. Usually, choose one of these methods:

1. Run `/login deepseek` in pi and let pi store and manage the credentials.
2. Export the environment variable in the shell that starts pi, replacing the placeholder:

```bash
export DEEPSEEK_API_KEY='YOUR_DEEPSEEK_API_KEY'
pi
```

`.env.example` only documents the variable name with an empty value. **Neither pi nor this extension automatically loads the project's `.env` file.** Copying the example does not configure credentials. If you use `.env`, have your shell or another tool export it before starting pi.

> Do not commit real keys, `auth.json`, or local configuration. `.env` is ignored by Git, and the distributed example remains empty.

## Development and testing

Run the refresh-policy tests from the project root. They inject fetch and synthetic credentials without making real network requests.

```bash
npm test  # Runs tests/*.test.ts natively; no extra test dependencies required

# Install only this project's development dependencies, without dependency
# install scripts or changes to the global pi installation
npm ci --ignore-scripts --no-audit --no-fund
# If an extracted package has no package-lock.json, use:
# npm install --ignore-scripts --no-audit --no-fund
npm run typecheck  # Strict checks for entry point, core, script, and tests; no JS output
npm run check      # Type checking and all offline tests
```

Type checking uses TypeScript, Node types, and pi 1.0.4 host packages as development-only dependencies. At runtime, pi supplies those packages; they are neither runtime dependencies nor bundled into the extension. `tsconfig.json` enables strict checks, unused-declaration checks, and erasable-syntax restrictions. Native Node execution strips types but does not replace type checking.

Synchronization tests cover explicit and default output paths using temporary directories and a temporary HOME. They do not write to the real pi autoload directory or query credentials or balances.

Inspect offline startup options or try this package's HUD and command in isolation:

```bash
pi --offline -ne -e . --help
pi --offline -ne -e .
```

The help command alone cannot prove that the extension loaded successfully. In an offline interactive trial, expect `🐳 DeepSeek 离线` (offline); `/pi-deepseek` should not query credentials or balances. Do not use `-p "ok"` for an offline check because it invokes a model.

After editing `src/balance.ts` or `extensions/index.ts`, package installations only need `/reload`. Standalone deployments require an explicit `npm run sync-autoload`.

### Local packaging and GitHub uploads

Run from the project root:

```bash
npm pack --offline --ignore-scripts --pack-destination ..
# Creates pi-deepseek-0.2.0.tgz in the parent directory;
# does not install the extension or publish to npm
```

Upload this project's contents with `package.json` at the repository root. Do not upload the entire parent directory, `.tgz` files, credentials, or local configuration. Keep the source, tests, both READMEs, license, empty `.env.example`, and `.gitignore`. The manifest uses an explicit file allowlist; `node_modules/` is unnecessary. After extracting the package, you can run `npm test` and `pi -ne -e .` directly.

## Project structure

```text
pi-deepseek/
├── package.json                 # pi package manifest (keyword: pi-package)
├── extensions/
│   └── index.ts                 # pi events, command, and detail panel
├── src/
│   └── balance.ts               # refresh policy and status text; no external dependencies
├── scripts/
│   └── sync-autoload.ts         # explicitly generates a self-contained autoload copy
├── tests/
│   ├── pi-deepseek.test.ts
│   ├── extension.test.ts         # provider-gated footer wiring tests
│   └── sync-autoload.test.ts    # synchronization tests in temporary directories
├── tsconfig.json                # strict type checking; no JavaScript output
├── package-lock.json            # locked development dependencies
├── .env.example                 # empty DEEPSEEK_API_KEY example
├── .gitignore
├── LICENSE
├── README.md
├── README.en.md
├── CHANGELOG.md
└── CHANGELOG.en.md
```

## Version history

Current version **v0.2.0**. See [CHANGELOG.en.md](CHANGELOG.en.md) for the full history.

## License

[MIT](./LICENSE). Copyright (c) 2026 xiasheng32.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const script = join(root, "scripts/sync-autoload.ts");

async function expectedBundle(): Promise<string> {
	const source = await readFile(join(root, "src/balance.ts"), "utf8");
	const entry = await readFile(join(root, "extensions/index.ts"), "utf8");
	const body = entry.replace(/^import .* from "\.\.\/src\/balance\.ts";\n/gm, "");
	const split = body.indexOf('const STATUS_KEY = "pi-deepseek";');
	assert.ok(split >= 0);
	return "// Self-contained pi autoload extension. Generated from xiasheng32/pi-deepseek by npm run sync-autoload.\n"
		+ body.slice(0, split) + source + "\n" + body.slice(split);
}

function runScript(home: string, args: string[]): string {
	const result = spawnSync(process.execPath, [script, ...args], {
		cwd: root,
		// Both explicit and default destinations are isolated from the real Pi home.
		env: { ...process.env, HOME: home, USERPROFILE: home },
		encoding: "utf8",
		timeout: 10_000,
	});
	assert.ifError(result.error);
	assert.equal(result.status, 0, result.stderr);
	return result.stdout;
}

test("package exposes only extensions/index.ts for the compact plugin label", async () => {
	const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	assert.deepEqual(manifest.pi.extensions, ["./extensions/index.ts"]);
	assert.deepEqual(manifest.files.filter((file: string) => file.startsWith("extensions/")), ["extensions/index.ts"]);
	const entries = await readdir(join(root, "extensions"), { withFileTypes: true });
	assert.deepEqual(
		entries.filter((entry) => entry.isFile() && /\.(?:ts|js)$/.test(entry.name)).map((entry) => entry.name).sort(),
		["index.ts"],
	);
});

test("TS sync script generates an exact self-contained bundle at an explicit nested destination", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-deepseek-sync-"));
	try {
		const target = join(home, "nested", "pi-deepseek.ts");
		assert.ok(runScript(home, [target]).includes(`Updated ${target}`));
		assert.equal(await readFile(target, "utf8"), await expectedBundle());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("TS sync script defaults to the sandbox autoload path without touching the real Pi home", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-deepseek-sync-"));
	try {
		const target = join(home, ".pi", "agent", "extensions", "pi-deepseek.ts");
		assert.ok(runScript(home, []).includes(`Updated ${target}`));
		assert.equal(await readFile(target, "utf8"), await expectedBundle());
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

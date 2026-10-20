import assert from "node:assert/strict";
import { test } from "node:test";
import type { TestContext } from "node:test";
import piDeepseek from "../extensions/pi-deepseek.ts";

// Wiring tests for the extension entry: the footer status is DeepSeek-only, and
// leaving the provider must stop the network and payload work as well.

const POLL_MS = 60_000;
const PAYLOAD = {
	is_available: true,
	balance_infos: [{ currency: "CNY", total_balance: "1.27", granted_balance: "0.00", topped_up_balance: "1.27" }],
};

type PiApi = Parameters<typeof piDeepseek>[0];
type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakeModel {
	provider: string;
	id: string;
}

interface FakeContext {
	mode: "tui" | "json";
	hasUI: boolean;
	model: FakeModel | undefined;
	ui: {
		setStatus(key: string, text: string | undefined): void;
		theme: { fg(color: string, text: string): string };
		custom(factory: unknown, options: unknown): Promise<void>;
		notify(message: string, type?: string): void;
	};
	modelRegistry: { getApiKeyForProvider(provider: string): Promise<string | undefined> };
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Trick the extension's `pi` API into exposing its handlers to the test. */
function harness(t: TestContext) {
	t.mock.timers.enable({ apis: ["setInterval", "Date"] });
	const previousFetch = globalThis.fetch;
	const previousOffline = process.env.PI_OFFLINE;
	delete process.env.PI_OFFLINE;

	let fetchCount = 0;
	globalThis.fetch = (async () => {
		fetchCount++;
		return new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { "Content-Type": "application/json" } });
	}) as typeof globalThis.fetch;

	const statuses: { text: string | undefined }[] = [];
	let customCalls = 0;
	const ctx: FakeContext = {
		mode: "tui",
		hasUI: true,
		model: { provider: "deepseek", id: "deepseek-flash" },
		ui: {
			setStatus: (_key, text) => { statuses.push({ text }); },
			theme: { fg: (_color, text) => text },
			custom: async () => { customCalls++; },
			notify: () => {},
		},
		modelRegistry: { getApiKeyForProvider: async () => "sk-test" },
	};

	const handlers = new Map<string, Handler>();
	const commands = new Map<string, Handler>();
	const pi = {
		on: (event: string, handler: Handler) => { handlers.set(event, handler); return () => {}; },
		registerCommand: (name: string, options: { handler: Handler }) => { commands.set(name, options.handler); },
	} as unknown as PiApi;
	piDeepseek(pi);

	return {
		ctx,
		statuses,
		fetches: () => fetchCount,
		customCalls: () => customCalls,
		/** The most recent footer text; `undefined` means the entry was cleared. */
		lastStatus: () => statuses.at(-1)?.text,
		setProvider(provider: string | undefined, id = `${provider ?? "none"}-test`) {
			ctx.model = provider === undefined ? undefined : { provider, id };
		},
		async emit(event: string, payload: unknown = {}) {
			const handler = handlers.get(event);
			assert.ok(handler, `extension did not register ${event}`);
			await handler(payload, ctx);
			await settle();
		},
		async run(command: string) {
			const handler = commands.get(command);
			assert.ok(handler, `extension did not register /${command}`);
			await handler("", ctx);
			await settle();
		},
		/** Stop polling before the mock realm disappears, then restore globals. */
		async dispose() {
			if (handlers.has("session_shutdown")) await handlers.get("session_shutdown")?.({}, ctx);
			globalThis.fetch = previousFetch;
			if (previousOffline === undefined) delete process.env.PI_OFFLINE;
			else process.env.PI_OFFLINE = previousOffline;
			t.mock.timers.reset();
		},
	};
}

test("shows the balance footer and polls while the deepseek provider is active", async (t) => {
	const h = harness(t);
	try {
		await h.emit("session_start");
		assert.match(String(h.lastStatus()), /DeepSeek.*余额：¥1\.27/);
		assert.equal(h.fetches(), 1);

		t.mock.timers.tick(POLL_MS);
		await settle();
		assert.equal(h.fetches(), 2, "the 60s poll keeps refreshing on deepseek");
	} finally {
		await h.dispose();
	}
});

test("switching to another provider clears the footer and stops polling", async (t) => {
	const h = harness(t);
	try {
		await h.emit("session_start");
		t.mock.timers.tick(POLL_MS);
		await settle();
		const before = h.fetches();

		h.setProvider("anthropic");
		await h.emit("model_select", { type: "model_select", model: h.ctx.model, source: "cycle" });

		assert.equal(h.lastStatus(), undefined, "footer entry must be cleared, not kept stale");
		t.mock.timers.tick(POLL_MS * 5);
		await settle();
		assert.equal(h.fetches(), before, "hidden provider must not keep querying the balance API");
	} finally {
		await h.dispose();
	}
});

test("switching back to deepseek restores the footer, refreshes and resumes polling", async (t) => {
	const h = harness(t);
	try {
		await h.emit("session_start");
		h.setProvider("openai");
		await h.emit("model_select", { type: "model_select", model: h.ctx.model, source: "cycle" });
		assert.equal(h.lastStatus(), undefined);
		const before = h.fetches();

		h.setProvider("deepseek");
		await h.emit("model_select", { type: "model_select", model: h.ctx.model, source: "cycle" });
		assert.match(String(h.lastStatus()), /DeepSeek.*余额：¥1\.27/);
		assert.equal(h.fetches(), before + 1, "returning to deepseek refreshes immediately");

		t.mock.timers.tick(POLL_MS);
		await settle();
		assert.equal(h.fetches(), before + 2, "polling resumes after returning");
	} finally {
		await h.dispose();
	}
});

test("a deepseek model change repaints the footer without another request", async (t) => {
	const h = harness(t);
	try {
		await h.emit("session_start");
		assert.equal(h.fetches(), 1);

		h.setProvider("deepseek", "deepseek-reasoner");
		await h.emit("model_select", { type: "model_select", model: h.ctx.model, source: "cycle" });

		assert.match(String(h.lastStatus()), /DeepSeek.*余额：¥1\.27/);
		assert.equal(h.fetches(), 1, "same-provider switches reuse the cached snapshot");
	} finally {
		await h.dispose();
	}
});

test("starting on another provider queries nothing and shows no footer", async (t) => {
	const h = harness(t);
	try {
		h.setProvider("anthropic");
		await h.emit("session_start");

		assert.equal(h.fetches(), 0, "no network at startup on a foreign provider");
		assert.equal(h.statuses.filter((status) => status.text !== undefined).length, 0);
		assert.equal(h.lastStatus(), undefined);

		t.mock.timers.tick(POLL_MS * 5);
		await settle();
		assert.equal(h.fetches(), 0);
		assert.equal(h.lastStatus(), undefined);
	} finally {
		await h.dispose();
	}
});

test("/pi-deepseek still opens the panel on another provider but leaves the footer hidden", async (t) => {
	const h = harness(t);
	try {
		h.setProvider("anthropic");
		await h.emit("session_start");
		const before = h.fetches();

		await h.run("pi-deepseek");

		assert.equal(h.customCalls(), 1, "the command stays usable on any provider");
		assert.equal(h.fetches(), before + 1, "the command still forces a refresh");
		assert.equal(h.statuses.filter((status) => status.text !== undefined).length, 0);
		assert.equal(h.lastStatus(), undefined);
	} finally {
		await h.dispose();
	}
});

/**
 * DeepSeek balance refresh policy.
 *
 * Ported from xiasheng32/pi-codex/src/quota.ts so both extensions share the
 * same refresh scheme: controller-scoped state, guard ordering, per-request
 * timeout, exponential backoff, Retry-After cooldown, stale marking and a
 * phase-driven status line.
 *
 * Deliberately dependency-free (no imports, no `node:` builtins) so the same
 * file can be unit-tested under `node --test` and inlined into the deployed
 * autoload bundle by scripts/sync-autoload.ts.
 */

export const PROVIDER = "deepseek";
export const API_URL = "https://api.deepseek.com/user/balance";
export const THROTTLE_MS = 30_000;
export const TIMEOUT_MS = 10_000;
export const POLL_MS = 60_000;
const BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 300_000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export interface BalanceInfo {
	currency: string;
	totalBalance: string;
	grantedBalance: string;
	toppedUpBalance: string;
}

export interface BalanceSnapshot {
	isAvailable: boolean;
	infos: BalanceInfo[];
	receivedAt: number;
}

export type BalancePhase =
	| "idle" | "offline" | "loading" | "ready" | "not_configured"
	| "auth_error" | "rate_limited" | "data_error" | "network_error" | "timeout";

export interface BalanceError {
	kind: "auth" | "http_auth" | "rate_limit" | "data" | "http" | "network" | "timeout";
	httpStatus?: number;
}

export interface BalanceState {
	phase: BalancePhase;
	snapshot: BalanceSnapshot | null;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	stale: boolean;
	retryAt: number | null;
	error: BalanceError | null;
}

export interface ControllerOptions {
	/** Request-time credential resolution; the resolved key is never retained. */
	resolveAuth: () => Promise<string | undefined>;
	fetch?: typeof globalThis.fetch;
	now?: () => number;
	timeoutSignal?: (milliseconds: number) => AbortSignal;
	onChange?: (state: BalanceState) => void;
	offline?: boolean;
}

class BalanceDataError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOffline(value: string | undefined): boolean {
	return /^(1|true|yes)$/i.test(value?.trim() ?? "");
}

/**
 * Non-cryptographic fingerprint used only to notice a credential change without
 * retaining the secret itself. A collision merely delays the reset until the
 * next refresh.
 */
function fingerprint(value: string): string {
	let hash = 0x811c9dc5;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `${value.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

function decimal(value: unknown): string {
	// DeepSeek reports signed amounts: clawed-back grants can make topped_up_balance
	// (and occasionally total_balance) negative, e.g. "-0.23". Rejecting the sign
	// turned those real responses into "数据异常".
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "string" && /^-?\d{1,18}(?:\.\d{1,8})?$/.test(value)) return value;
	throw new BalanceDataError();
}

/** Keep only validated fields; never surface raw response content. */
export function parseBalance(payload: unknown, receivedAt: number): BalanceSnapshot {
	if (!isRecord(payload)) throw new BalanceDataError();
	if (typeof payload.is_available !== "boolean") throw new BalanceDataError();
	if (!Array.isArray(payload.balance_infos) || payload.balance_infos.length > 32) throw new BalanceDataError();
	const infos = payload.balance_infos.map((row) => {
		if (!isRecord(row)) throw new BalanceDataError();
		if (typeof row.currency !== "string" || !/^[A-Z0-9]{2,8}$/.test(row.currency)) throw new BalanceDataError();
		return {
			currency: row.currency,
			totalBalance: decimal(row.total_balance),
			grantedBalance: decimal(row.granted_balance),
			toppedUpBalance: decimal(row.topped_up_balance),
		};
	});
	return { isAvailable: payload.is_available, infos, receivedAt };
}

export function parseRetryAfter(value: string | null, now: number): number | undefined {
	if (!value?.trim()) return undefined;
	const text = value.trim();
	const numeric = /^\d+(?:\.\d+)?$/.test(text);
	// Date.parse also accepts strings such as "-1" as calendar dates, not valid Retry-After.
	if (!numeric && !/^[a-z]{3,9}(?:,|\s)/i.test(text)) return undefined;
	const retryAt = numeric ? now + Number(text) * 1000 : Date.parse(text);
	return Number.isFinite(retryAt) && retryAt <= MAX_DATE_MS ? Math.max(now, retryAt) : undefined;
}

/** Cancel the caller's wait even when a host operation or mock ignores its signal. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(signal.reason);
		};
		operation.then(
			(value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
			(error) => { signal.removeEventListener("abort", onAbort); reject(error); },
		);
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

/** Per-extension-session controller, with an injectable transport for offline tests. */
export class BalanceController {
	private readonly options: ControllerOptions;
	private readonly now: () => number;
	private readonly fetch: typeof globalThis.fetch;
	private state: BalanceState;
	private inflight: Promise<BalanceState> | null = null;
	private request: AbortController | null = null;
	private credential: string | null = null;
	private generation = 0;
	private disposed = false;
	private failures = 0;
	private nextAutomaticAt = 0;
	private rateLimitUntil = 0;

	constructor(options: ControllerOptions) {
		this.options = options;
		this.now = options.now ?? Date.now;
		this.fetch = options.fetch ?? globalThis.fetch;
		this.state = {
			phase: options.offline ? "offline" : "idle",
			snapshot: null, lastAttemptAt: null, lastSuccessAt: null,
			stale: false, retryAt: null, error: null,
		};
	}

	getState(): BalanceState {
		return {
			...this.state,
			error: this.state.error ? { ...this.state.error } : null,
			snapshot: this.state.snapshot ? {
				...this.state.snapshot,
				infos: this.state.snapshot.infos.map((info) => ({ ...info })),
			} : null,
		};
	}

	refresh(force = false): Promise<BalanceState> {
		if (this.disposed) return Promise.resolve(this.getState());
		if (this.options.offline) {
			this.publish();
			return Promise.resolve(this.getState());
		}
		if (this.inflight) return this.inflight;
		const now = this.now();
		if (now < this.rateLimitUntil) return Promise.resolve(this.getState());
		if (!force && (now < this.nextAutomaticAt
			|| (this.state.lastAttemptAt !== null && now - this.state.lastAttemptAt < THROTTLE_MS))) {
			return Promise.resolve(this.getState());
		}

		const generation = ++this.generation;
		const request = new AbortController();
		this.request = request;
		this.state = { ...this.state, phase: "loading", lastAttemptAt: now, error: null };
		this.inflight = Promise.resolve().then(() => this.performRefresh(generation, request)).finally(() => {
			if (this.request === request) {
				this.request = null;
				this.inflight = null;
			}
		});
		this.publish();
		return this.inflight;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation++;
		this.request?.abort();
		this.credential = null;
		this.state = {
			phase: "idle", snapshot: null, lastAttemptAt: null, lastSuccessAt: null,
			stale: false, retryAt: null, error: null,
		};
	}

	private current(generation: number): boolean {
		return !this.disposed && generation === this.generation;
	}

	private publish(): void {
		if (this.disposed) return;
		// A UI callback must not turn background polling into an unhandled rejection.
		try { this.options.onChange?.(this.getState()); } catch { /* UI may be tearing down. */ }
	}

	private clearCredential(): void {
		this.credential = null;
		this.state = { ...this.state, snapshot: null, lastSuccessAt: null, stale: false };
	}

	private fail(phase: BalancePhase, error: BalanceError, retryAt?: number): void {
		const now = this.now();
		const delay = Math.min(MAX_BACKOFF_MS, BACKOFF_MS * 2 ** Math.min(this.failures++, 3));
		const next = retryAt ?? now + delay;
		this.nextAutomaticAt = Math.max(now + THROTTLE_MS, next);
		this.state = {
			...this.state, phase, error,
			stale: this.state.snapshot !== null,
			retryAt: this.nextAutomaticAt,
		};
		this.publish();
	}

	private async performRefresh(generation: number, request: AbortController): Promise<BalanceState> {
		let signal: AbortSignal | undefined;
		try {
			let key: string | undefined;
			try {
				request.signal.throwIfAborted();
				key = await withAbort(this.options.resolveAuth(), request.signal);
			} catch {
				if (!this.current(generation) || request.signal.aborted) return this.getState();
				this.clearCredential();
				this.fail("auth_error", { kind: "auth" });
				return this.getState();
			}
			if (!this.current(generation)) return this.getState();
			if (!key) {
				this.clearCredential();
				this.failures = 0;
				this.nextAutomaticAt = this.now() + THROTTLE_MS;
				this.state = { ...this.state, phase: "not_configured", error: null, retryAt: null };
				this.publish();
				return this.getState();
			}
			const credential = fingerprint(key);
			if (this.credential !== credential) {
				// credential === null implies snapshot === null, so the first sighting of a
				// key has nothing stale to clear and needs no extra notification.
				const rotated = this.credential !== null;
				this.clearCredential();
				this.credential = credential;
				if (rotated) this.publish();
			}

			signal = AbortSignal.any([request.signal, (this.options.timeoutSignal ?? AbortSignal.timeout)(TIMEOUT_MS)]);
			signal.throwIfAborted();
			const response = await withAbort(this.fetch(API_URL, {
				method: "GET", redirect: "error",
				headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
				signal,
			}), signal);
			if (!this.current(generation)) return this.getState();
			if (!response.ok) {
				void response.body?.cancel().catch(() => {});
				if (response.status === 401 || response.status === 403) {
					this.clearCredential();
					this.fail("auth_error", { kind: "http_auth", httpStatus: response.status });
				} else if (response.status === 429) {
					this.rateLimitUntil = Math.max(this.now() + THROTTLE_MS, parseRetryAfter(response.headers.get("Retry-After"), this.now()) ?? this.now() + BACKOFF_MS);
					this.fail("rate_limited", { kind: "rate_limit", httpStatus: 429 }, this.rateLimitUntil);
				} else {
					this.fail("network_error", { kind: "http", httpStatus: response.status });
				}
				return this.getState();
			}

			let payload: unknown;
			try { payload = await withAbort(response.json(), signal); }
			catch { signal.throwIfAborted(); throw new BalanceDataError(); }
			const snapshot = parseBalance(payload, this.now());
			if (!this.current(generation)) return this.getState();
			this.failures = 0;
			this.rateLimitUntil = 0;
			this.nextAutomaticAt = (this.state.lastAttemptAt ?? this.now()) + THROTTLE_MS;
			this.state = { ...this.state, phase: "ready", snapshot, lastSuccessAt: snapshot.receivedAt, stale: false, error: null, retryAt: null };
			this.publish();
		} catch (error) {
			if (!this.current(generation) || request.signal.aborted) return this.getState();
			if (signal?.aborted) this.fail("timeout", { kind: "timeout" });
			else if (error instanceof BalanceDataError) this.fail("data_error", { kind: "data" });
			else this.fail("network_error", { kind: "network" });
		}
		return this.getState();
	}
}

export function currencySymbol(currency: string): string {
	if (currency === "CNY") return "¥";
	if (currency === "USD") return "$";
	return `${currency} `;
}

function localTime(timestamp: number | null): string {
	if (timestamp === null) return "未知";
	const date = new Date(timestamp);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function retryRemaining(retryAt: number, now: number): string {
	const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.ceil(seconds / 60)}m`;
}

function errorDescription(error: BalanceError): string {
	switch (error.kind) {
		case "auth": return "pi 认证解析/续期失败，请重新配置 DeepSeek 凭据";
		case "http_auth": return `余额接口拒绝认证（HTTP ${error.httpStatus}），请重新配置 DeepSeek 凭据`;
		case "rate_limit": return "余额查询被限流（HTTP 429），请等待冷却";
		case "data": return "余额响应格式异常，未显示未经校验的数据";
		case "http": return `余额接口查询失败（HTTP ${error.httpStatus}）`;
		case "network": return "余额查询网络失败，请检查连接或代理";
		case "timeout": return "余额查询超时（10 秒）";
	}
}

export function statusLine(state: BalanceState, now: number): { text: string; color: "dim" | "accent" | "success" | "warning" | "error" } {
	void now; // Kept for parity with the Codex status line; DeepSeek has no wall-clock window.
	if (state.phase === "offline") return { text: "🐳 DeepSeek 离线", color: "dim" };
	if (state.phase === "not_configured") return { text: "🐳 DeepSeek 未配置", color: "dim" };
	if (state.phase === "auth_error") return { text: "🐳 DeepSeek 凭据失效", color: "warning" };
	const snapshot = state.snapshot;
	if (!snapshot) {
		if (state.phase === "loading") return { text: "🐳 DeepSeek 查询中…", color: "accent" };
		const text = state.phase === "rate_limited" ? "🐳 DeepSeek 查询限流"
			: state.phase === "data_error" ? "🐳 DeepSeek 数据异常"
			: state.phase === "timeout" ? "🐳 DeepSeek 查询超时"
			: state.phase === "network_error" ? "🐳 DeepSeek 查询失败" : "🐳 DeepSeek 待查询";
		return { text, color: state.error ? "warning" : "dim" };
	}
	const marker = state.stale ? "[过期]" : state.phase === "loading" ? "[更新中]" : "";
	const body = snapshot.infos.length
		? snapshot.infos.map((info) => `${currencySymbol(info.currency)}${info.totalBalance}`).join("；")
		: "无余额数据";
	const text = `🐳 DeepSeek${marker} 余额：${body}${snapshot.isAvailable ? "" : " ⚠"}`;
	const color = state.stale ? "warning" : state.phase === "loading" ? "accent"
		: !snapshot.isAvailable ? "warning" : "success";
	return { text, color };
}

export function detailLines(state: BalanceState, now: number): string[] {
	if (state.phase === "offline") return ["离线模式：未解析凭据，未发起余额请求。", "取消 PI_OFFLINE / --offline 后重新启动 pi。"];
	if (state.phase === "not_configured") return ["未配置 DeepSeek API Key。", "请在 pi 中执行 /login deepseek 或设置 DEEPSEEK_API_KEY。"];
	const lines: string[] = [];
	if (state.phase === "loading") lines.push("正在刷新…");
	if (state.error) lines.push(errorDescription(state.error));
	if (state.stale) lines.push("以下为过期缓存，不代表当前余额。");
	const snapshot = state.snapshot;
	if (snapshot) {
		if (!snapshot.infos.length) lines.push("服务端未提供余额明细。");
		for (const info of snapshot.infos) {
			lines.push(info.currency);
			lines.push(`总余额    ${currencySymbol(info.currency)}${info.totalBalance}`);
			lines.push(`赠送余额  ${info.grantedBalance}`);
			lines.push(`充值余额  ${info.toppedUpBalance}`);
		}
		lines.push(`状态      ${snapshot.isAvailable ? "可用" : "不可用"}`);
		lines.push("", `更新：${localTime(state.lastSuccessAt)} · 本机时区`);
	}
	if (state.retryAt !== null && state.retryAt > now) {
		lines.push(`${state.phase === "rate_limited" ? "限流冷却" : "自动重试"}：${retryRemaining(state.retryAt, now)}后`);
	}
	return lines.length ? lines : ["暂无余额数据。"];
}

export function summaryLine(state: BalanceState): { text: string; type: "info" | "warning" | "error" } {
	if (state.phase === "offline") return { text: "离线模式：未查询 DeepSeek 余额", type: "info" };
	if (state.phase === "not_configured") return { text: "未配置 DeepSeek API Key", type: "error" };
	const snapshot = state.snapshot;
	if (!snapshot) {
		return state.error
			? { text: `DeepSeek 余额查询失败：${errorDescription(state.error)}`, type: "error" }
			: { text: "DeepSeek 余额：暂无数据", type: "info" };
	}
	const parts = snapshot.infos.map(
		(info) => `${currencySymbol(info.currency)}${info.totalBalance}（赠送 ${info.grantedBalance} / 充值 ${info.toppedUpBalance}）`,
	);
	const text = `${state.stale ? "[过期] " : ""}DeepSeek 余额：${parts.join("；") || "无"} · ${snapshot.isAvailable ? "可用" : "不可用"}`;
	return { text, type: state.stale || state.error ? "warning" : "info" };
}

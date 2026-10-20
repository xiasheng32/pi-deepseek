/**
 * Pi DeepSeek balance HUD.
 *
 * Wires the shared-codex-style refresh controller (`../src/balance.ts`) into pi:
 * footer status line, `/pi-deepseek` command and a live detail panel.
 *
 * - Status: ctx.ui.setStatus("pi-deepseek", "🐳 DeepSeek 余额：¥110.00")
 *   Only while the active model belongs to the `deepseek` provider; switching away
 *   clears the status and disposes the controller, switching back restarts it.
 * - Refresh: session start (immediate) + 60s poll + agent_settled (30s throttle)
 * - API: GET https://api.deepseek.com/user/balance (Bearer auth)
 *
 * Deployment: `npm run sync-autoload` inlines ../src/balance.ts into
 * ~/.pi/agent/extensions/pi-deepseek.ts. This file cannot be copied there
 * verbatim because of the relative import.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { BalanceController, POLL_MS, PROVIDER, detailLines, isOffline, statusLine, summaryLine } from "../src/balance.ts";
import type { BalanceState } from "../src/balance.ts";

const STATUS_KEY = "pi-deepseek";

export class BalancePanel {
	private readonly tui: TUI;
	private readonly ctx: ExtensionContext;
	private readonly controller: BalanceController;
	private readonly done: () => void;
	private offset = 0;
	private maxOffset = 0;

	constructor(tui: TUI, ctx: ExtensionContext, controller: BalanceController, done: () => void) {
		this.tui = tui;
		this.ctx = ctx;
		this.controller = controller;
		this.done = done;
	}

	invalidate(): void {} // Lines and theme are recomputed on every render.

	render(availableWidth: number): string[] {
		const width = Math.max(0, Math.min(availableWidth, 64));
		if (width === 0) return [];
		const state = this.controller.getState();
		const now = Date.now();
		const theme = this.ctx.ui.theme;
		if (width < 6 || this.tui.terminal.rows < 8) {
			return [statusLine(state, now).text, "Enter/Esc 关闭"].map((line) => truncateToWidth(line, width));
		}
		const inner = width - 2;
		const contentWidth = Math.max(1, inner - 2);
		const paint = (line: string) => {
			if (line.startsWith("正在刷新") || line.startsWith("总余额")) return theme.fg("accent", line);
			if (line.startsWith("状态")) return theme.fg(/不可用\s*$/.test(line) ? "error" : "success", line);
			if (/过期缓存|查询失败|查询限流|查询超时|格式异常|拒绝认证|未配置/.test(line)) return theme.fg("warning", line);
			if (/^更新：|本机时区|自动重试|限流冷却|^[A-Z0-9]{2,8}$/.test(line)) return theme.fg("dim", line);
			return line;
		};
		const content = detailLines(state, now).flatMap((line) => wrapTextWithAnsi(paint(line), contentWidth));
		const bodyHeight = Math.max(1, Math.min(20, this.tui.terminal.rows - 7));
		this.maxOffset = Math.max(0, content.length - bodyHeight);
		this.offset = Math.min(this.offset, this.maxOffset);
		const row = (text: string) => {
			const value = truncateToWidth(` ${text}`, inner);
			return theme.fg("border", "│") + value + " ".repeat(Math.max(0, inner - visibleWidth(value))) + theme.fg("border", "│");
		};
		return [
			theme.fg("border", `╭${"─".repeat(inner)}╮`),
			row(theme.fg("accent", "🐳 DeepSeek 余额")),
			theme.fg("border", `├${"─".repeat(inner)}┤`),
			...content.slice(this.offset, this.offset + bodyHeight).map((line) => row(line)),
			theme.fg("border", `╰${"─".repeat(inner)}╯`),
			theme.fg("dim", `${this.maxOffset ? ` ↑↓ 滚动 ${this.offset + 1}-${Math.min(content.length, this.offset + bodyHeight)}/${content.length} ·` : ""} Enter/Esc 关闭`),
		].map((line) => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "return") || data === "q") {
			this.done();
		} else if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + (matchesKey(data, "up") ? -1 : 1)));
			this.tui.requestRender();
		} else if (matchesKey(data, "home") || matchesKey(data, "end")) {
			this.offset = matchesKey(data, "home") ? 0 : this.maxOffset;
			this.tui.requestRender();
		}
	}
}

export default function piDeepseek(pi: ExtensionAPI): void {
	// State is factory-local: reloads and different sessions cannot share requests.
	let controller: BalanceController | null = null;
	let timer: ReturnType<typeof setInterval> | undefined;
	// Offline mode intentionally runs no timer, so a timer alone cannot say whether
	// balance tracking is active; `started` covers both cases.
	let started = false;

	/** The footer entry belongs to the DeepSeek provider only. */
	function isActive(ctx: ExtensionContext): boolean {
		return ctx.model?.provider === PROVIDER;
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (ctx.mode === "tui" && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
	}

	function updateStatus(ctx: ExtensionContext, state: BalanceState): void {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!isActive(ctx)) {
			// Late callbacks and `/pi-deepseek` must not resurrect the footer elsewhere.
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		const status = statusLine(state, Date.now());
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(status.color, status.text));
	}

	function getController(ctx: ExtensionContext): BalanceController {
		if (!controller) {
			const instance = new BalanceController({
				resolveAuth: () => ctx.modelRegistry.getApiKeyForProvider(PROVIDER),
				offline: isOffline(process.env.PI_OFFLINE),
				onChange: (state) => { if (controller === instance) updateStatus(ctx, state); },
			});
			controller = instance;
		}
		return controller;
	}

	function stop(ctx: ExtensionContext): void {
		started = false;
		if (timer !== undefined) clearInterval(timer);
		timer = undefined;
		controller?.dispose();
		controller = null;
		clearStatus(ctx);
	}

	function start(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !ctx.hasUI || !isActive(ctx)) return;
		started = true;
		const instance = getController(ctx);
		updateStatus(ctx, instance.getState());
		void instance.refresh(true);
		if (isOffline(process.env.PI_OFFLINE)) return;
		timer = setInterval(() => {
			void instance.refresh();
			if (controller === instance) updateStatus(ctx, instance.getState());
		}, POLL_MS);
		timer.unref();
	}

	pi.on("session_start", (_event, ctx) => {
		stop(ctx);
		start(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;
		if (!isActive(ctx)) {
			stop(ctx);
			return;
		}
		if (!started) {
			start(ctx); // First arrival on deepseek: status, fresh snapshot, polling.
			return;
		}
		// Same provider, different model: only the themed status text needs repainting.
		if (controller) updateStatus(ctx, controller.getState());
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (ctx.mode !== "tui" || !controller || !isActive(ctx)) return;
		void controller.refresh();
		updateStatus(ctx, controller.getState());
	});

	pi.on("session_shutdown", (_event, ctx) => stop(ctx));

	pi.registerCommand("pi-deepseek", {
		description: "查看 DeepSeek 账户余额；强制刷新并打开详情面板",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			const instance = getController(ctx);
			await instance.refresh(true);
			if (controller !== instance) return; // Context may have been invalidated while awaiting.
			if (ctx.mode === "tui") {
				await ctx.ui.custom<undefined>(
					(tui, _theme, _keybindings, done) => new BalancePanel(tui, ctx, instance, () => done(undefined)),
					{ overlay: true, overlayOptions: { anchor: "center", width: 64, margin: 1 } },
				);
			} else {
				const summary = summaryLine(instance.getState());
				ctx.ui.notify(summary.text, summary.type);
			}
		},
	});
}

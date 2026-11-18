import os from "node:os";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type WindowData = {
	usedPercent?: number;
	resetAt?: number;
};

type UsageState = {
	primary?: WindowData;
	secondary?: WindowData;
	fetchedAt: number;
};

const STATUS_KEY = "usage-limits";
const REFRESH_MS = 5_000;
const USAGE_REFRESH_MS = 60_000;
const USAGE_MAX_AGE_MS = USAGE_REFRESH_MS + 8_000;
const USAGE_PATH = "/wham/usage";

function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asUnixMillis(value: unknown): number | undefined {
	const number = asFiniteNumber(value);
	if (number === undefined) return undefined;
	return number < 10_000_000_000 ? number * 1_000 : number;
}

function readWindow(value: unknown): WindowData | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const usedPercent = asFiniteNumber(record.used_percent ?? record.usedPercent ?? record.utilization);
	const resetAt = asUnixMillis(record.reset_at ?? record.resetAt ?? record.resets_at);
	if (usedPercent === undefined && resetAt === undefined) return undefined;
	return { usedPercent, resetAt };
}

function readUsage(payload: unknown): UsageState | undefined {
	if (!payload || typeof payload !== "object") return undefined;
	const record = payload as Record<string, unknown>;
	const rateLimit = record.rate_limit && typeof record.rate_limit === "object"
		? record.rate_limit as Record<string, unknown>
		: record;
	const primary = readWindow(rateLimit.primary_window ?? rateLimit.primaryWindow ?? rateLimit.five_hour);
	const secondary = readWindow(rateLimit.secondary_window ?? rateLimit.secondaryWindow ?? rateLimit.seven_day);
	if (!primary && !secondary) return undefined;
	return { primary, secondary, fetchedAt: Date.now() };
}

function formatDuration(milliseconds: number): string {
	if (milliseconds <= 0) return "now";
	const totalMinutes = Math.ceil(milliseconds / 60_000);
	const days = Math.floor(totalMinutes / 1_440);
	const hours = Math.floor((totalMinutes % 1_440) / 60);
	const minutes = totalMinutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatWindow(label: string, window: WindowData | undefined): string | undefined {
	if (!window) return undefined;
	const parts = [label];
	if (window.usedPercent !== undefined) parts.push(`${Math.round(window.usedPercent)}% used`);
	if (window.resetAt !== undefined) parts.push(`reset ${formatDuration(window.resetAt - Date.now())}`);
	return parts.length > 1 ? parts.join(" ") : undefined;
}

function readCpuTimes(): { idle: number; total: number } | undefined {
	const cpus = os.cpus();
	if (cpus.length === 0) return undefined;
	let idle = 0;
	let total = 0;
	for (const cpu of cpus) {
		idle += cpu.times.idle;
		total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
	}
	return { idle, total };
}

function sampleCpu(previous: { idle: number; total: number } | undefined): { percent?: number; current?: { idle: number; total: number } } {
	const current = readCpuTimes();
	if (!current || !previous || current.total <= previous.total) return { current };
	const totalDelta = current.total - previous.total;
	const idleDelta = current.idle - previous.idle;
	return { current, percent: Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)) };
}

function formatBytes(bytes: number): string {
	const units = ["B", "KB", "MB", "GB", "TB"];
	let value = bytes;
	let unit = 0;
	while (value >= 1024 && unit < units.length - 1) {
		value /= 1024;
		unit += 1;
	}
	return `${value.toFixed(unit >= 3 ? 1 : 0)}${units[unit]}`;
}

function formatElapsed(seconds: number): string {
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${minutes}m`;
}

function formatSessionAge(ctx: ExtensionContext | undefined): string | undefined {
	try {
		const timestamp = ctx?.sessionManager.getHeader()?.timestamp;
		if (!timestamp) return undefined;
		const startedAt = Date.parse(timestamp);
		if (!Number.isFinite(startedAt)) return undefined;
		const seconds = Math.max(0, (Date.now() - startedAt) / 1_000);
		return `session: ${formatElapsed(seconds)}`;
	} catch {
		return undefined;
	}
}

function buildStatus(usage: UsageState | undefined, previousCpu: { idle: number; total: number } | undefined, ctx?: ExtensionContext): { text?: string; cpu?: { idle: number; total: number } } {
	// Do not leave old quota values visible if a refresh stalls or fails.
	if (usage && Date.now() - usage.fetchedAt >= USAGE_MAX_AGE_MS) usage = undefined;
	const parts: string[] = [];
	const fiveHour = formatWindow("5h:", usage?.primary);
	const sevenDay = formatWindow("7d:", usage?.secondary);
	if (fiveHour) parts.push(fiveHour);
	if (sevenDay) parts.push(sevenDay);

	const cpuSample = sampleCpu(previousCpu);
	if (cpuSample.percent !== undefined) parts.push(`CPU: ${Math.round(cpuSample.percent)}%`);

	const totalMemory = os.totalmem();
	const freeMemory = os.freemem();
	if (totalMemory > 0 && freeMemory >= 0 && freeMemory <= totalMemory) {
		const usedMemory = totalMemory - freeMemory;
		parts.push(`RAM: ${formatBytes(usedMemory)}/${formatBytes(totalMemory)} (${Math.round((usedMemory / totalMemory) * 100)}%)`);
	}

	try {
		const load = os.loadavg()[0];
		if (Number.isFinite(load)) parts.push(`load: ${load.toFixed(2)}`);
	} catch {
		// Some platforms do not expose load averages.
	}

	const sessionAge = formatSessionAge(ctx);
	if (sessionAge) parts.push(sessionAge);

	return { text: parts.length > 0 ? parts.join(" · ") : undefined, cpu: cpuSample.current };
}

async function fetchUsage(ctx: ExtensionContext): Promise<UsageState | undefined> {
	try {
		const model = ctx.model;
		if (!model) return undefined;
		// AuthResult wraps resolved credentials in .auth, not at the top level.
		const resolution = await ctx.modelRegistry.getProviderAuth(model.provider);
		const auth = resolution?.auth;
		const baseUrl = auth?.baseUrl || model.baseUrl;
		if (!baseUrl) return undefined;

		const url = `${baseUrl.replace(/\/$/, "")}${USAGE_PATH}`;
		const headers: Record<string, string> = { Accept: "application/json" };
		for (const [key, value] of Object.entries(auth?.headers ?? {})) {
			if (typeof value === "string") headers[key] = value;
		}
		if (auth?.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}
		if (auth?.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "chatgpt-account-id")) {
			try {
				const payload = auth.apiKey.split(".")[1];
				const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
				const authClaims = claims["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
				const accountId = authClaims?.chatgpt_account_id;
				if (typeof accountId === "string") headers["ChatGPT-Account-ID"] = accountId;
			} catch {
				// Account ID is optional; the bearer token may be sufficient.
			}
		}

		const timeout = AbortSignal.timeout(8_000);
		const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
		const response = await fetch(url, { headers, signal, redirect: "error" });
		if (!response.ok) return undefined;
		return readUsage(await response.json());
	} catch {
		return undefined;
	}
}

function styleStatus(text: string, usage: UsageState | undefined, theme: ExtensionContext["ui"]["theme"]): string {
	let result = "";
	let offset = 0;
	for (const match of text.matchAll(/(5h: |7d: )(\d+(?:\.\d+)?%)/g)) {
		const index = match.index!;
		const window = match[1] === "5h: " ? usage?.primary : usage?.secondary;
		const percent = window?.usedPercent ?? 0;
		const color = percent >= 66 ? "error" : percent >= 33 ? "warning" : "dim";
		result += theme.fg("dim", text.slice(offset, index) + match[1]);
		result += theme.fg(color, match[2]);
		offset = index + match[0].length;
	}
	return result + theme.fg("dim", text.slice(offset));
}

function alignStatus(metrics: string, phase: string | undefined, width: number | undefined): string {
	if (!width || width <= 0) return [metrics, phase].filter(Boolean).join(" · ");
	const right = phase ? truncateToWidth(phase, width) : "";
	const available = Math.max(0, width - visibleWidth(right) - (phase ? 2 : 0));
	if (visibleWidth(metrics) > available) {
		metrics = metrics.split(" · ")
			.filter((part) => !part.startsWith("load: ") && !part.startsWith("session: "))
			.join(" · ");
	}
	const left = truncateToWidth(metrics, available);
	if (!phase) return left;
	// Pi collapses ASCII spaces in extension statuses. NBSP preserves alignment.
	const padding = "\u00a0".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right)));
	return left + padding + right;
}

export default function usageLimitsExtension(pi: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | undefined;
	let usage: UsageState | undefined;
	let usageRequestInFlight = false;
	let lastUsageFetch = 0;
	let previousCpu: { idle: number; total: number } | undefined;
	let currentContext: ExtensionContext | undefined;
	let generation = 0;
	let requestRefresh: (() => Promise<void>) | undefined;
	let publishStatus: (() => void) | undefined;
	let metricsText = "";
	let working = false;
	const activeTools = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		if (!ctx.hasUI) return;

		publishStatus = () => {
			try {
				const phase = !working ? undefined : activeTools.size > 0 ? "Running tools" : "Thinking";
				const text = alignStatus(metricsText, phase, process.stdout.columns);
				ctx.ui.setStatus(STATUS_KEY, text ? styleStatus(text, usage, ctx.ui.theme) : undefined);
			} catch {
				// Optional status updates must not interrupt Pi.
			}
		};

		const render = () => {
			try {
				const status = buildStatus(usage, previousCpu, currentContext ?? ctx);
				previousCpu = status.cpu;
				metricsText = status.text ?? "";
				publishStatus?.();
			} catch {
				// Status rendering must never affect the agent.
			}
		};

		const refreshUsage = async () => {
			if (usageRequestInFlight || Date.now() - lastUsageFetch < USAGE_REFRESH_MS) return;
			usageRequestInFlight = true;
			lastUsageFetch = Date.now();
			const requestGeneration = generation;
			try {
				const next = await fetchUsage(currentContext ?? ctx);
				if (requestGeneration === generation) usage = next;
			} finally {
				usageRequestInFlight = false;
				if (requestGeneration === generation) render();
				else if (currentContext) void refreshUsage();
			}
		};

		requestRefresh = refreshUsage;
		void refreshUsage();
		render();
		timer = setInterval(() => {
			render();
			void refreshUsage();
		}, REFRESH_MS);
	});

	pi.on("agent_start", () => {
		working = true;
		activeTools.clear();
		publishStatus?.();
	});

	pi.on("tool_execution_start", (event) => {
		activeTools.add(event.toolCallId);
		publishStatus?.();
	});

	pi.on("tool_execution_end", (event) => {
		activeTools.delete(event.toolCallId);
		publishStatus?.();
	});

	pi.on("agent_settled", () => {
		working = false;
		activeTools.clear();
		publishStatus?.();
	});

	pi.on("model_select", (_event, ctx) => {
		currentContext = ctx;
		generation += 1;
		usage = undefined;
		lastUsageFetch = 0;
		void requestRefresh?.();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		generation += 1;
		requestRefresh = undefined;
		publishStatus = undefined;
		metricsText = "";
		working = false;
		activeTools.clear();
		currentContext = undefined;
		if (timer) clearInterval(timer);
		timer = undefined;
		previousCpu = undefined;
		try {
			ctx.ui.setStatus(STATUS_KEY, undefined);
		} catch {
			// Shutdown cleanup is best effort.
		}
	});
}

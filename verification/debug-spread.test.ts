import { describe, expect, it } from "bun:test";

const ANTHROPIC_SESSION_DURATION_DEFAULT = 5 * 60 * 60 * 1000;
const RECENT_PICK_WINDOW_MS = 500;
const RECENT_PICK_PENALTY = 100;
const MAX_AFFINITY_ENTRIES = 10_000;

interface Account {
	id: string;
	name: string;
	provider: string;
	priority: number;
	paused: boolean;
	rate_limited_until: number | null;
	session_start: number | null;
	session_request_count: number;
	requires_reauth: boolean;
	auto_fallback_enabled: boolean;
	pause_reason: string | null;
	rate_limit_reset: number | null;
}
interface RequestMeta {
	id: string;
	headers: Headers;
	timestamp: number;
	clientSessionId: string | null;
}
interface StrategyStore {
	getAccountUtilization?(id: string, p: string): number | null;
}

function isAccountAvailable(account: Account, now: number): boolean {
	return (
		!account.requires_reauth && !account.paused &&
		(!account.rate_limited_until || account.rate_limited_until < now)
	);
}

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "a", name: "a", provider: "anthropic", priority: 0, paused: false,
		rate_limited_until: null, session_start: null, session_request_count: 0,
		requires_reauth: false, auto_fallback_enabled: false, pause_reason: null,
		rate_limit_reset: null,
		...overrides,
	};
}

class MockStore implements StrategyStore {
	utilization = new Map<string, number>();
	getAccountUtilization(id: string): number | null {
		return this.utilization.get(id) ?? null;
	}
}

class SessionAffinityStrategy {
	private affinityTtlMs: number;
	private maxAffinityEntries: number;
	private store: StrategyStore | null = null;
	private affinity = new Map<string, { accountId: string; assignedAt: number }>();
	private lastPickedAt = new Map<string, number>();

	constructor(
		affinityTtlMs: number = ANTHROPIC_SESSION_DURATION_DEFAULT,
		maxAffinityEntries: number = MAX_AFFINITY_ENTRIES,
	) {
		this.affinityTtlMs = affinityTtlMs;
		this.maxAffinityEntries = maxAffinityEntries;
	}

	initialize(store: StrategyStore): void { this.store = store; }

	private rankByLeastUsed(accounts: Account[], now: number): Account[] {
		const scored = accounts.map((a) => {
			const util = this.store?.getAccountUtilization?.(a.id, a.provider) ?? 0;
			const lastPick = this.lastPickedAt.get(a.id) ?? 0;
			const recencyPenalty =
				now - lastPick < RECENT_PICK_WINDOW_MS ? RECENT_PICK_PENALTY : 0;
			return { account: a, score: util + recencyPenalty };
		});
		return scored.sort((a, b) => {
			if (a.account.priority !== b.account.priority) return a.account.priority - b.account.priority;
			return a.score - b.score;
		}).map((s) => s.account);
	}

	private pickAndMark(available: Account[], now: number): Account[] {
		const ranked = this.rankByLeastUsed(available, now);
		const chosen = ranked[0];
		if (chosen) this.lastPickedAt.set(chosen.id, now);
		return ranked;
	}

	private evictOldestIfFull(): void {
		if (this.affinity.size < this.maxAffinityEntries) return;
		let oldestKey: string | null = null;
		let oldestAt = Number.POSITIVE_INFINITY;
		for (const [key, entry] of this.affinity) {
			if (entry.assignedAt < oldestAt) {
				oldestAt = entry.assignedAt;
				oldestKey = key;
			}
		}
		if (oldestKey !== null) this.affinity.delete(oldestKey);
	}

	select(accounts: Account[], meta: RequestMeta): Account[] {
		const now = Date.now();
		const available = accounts.filter((a) => isAccountAvailable(a, now));
		if (available.length === 0) return [];

		for (const [clientId, entry] of this.affinity) {
			if (now - entry.assignedAt >= this.affinityTtlMs) this.affinity.delete(clientId);
		}

		const clientId = meta.clientSessionId ?? null;
		if (clientId !== null) {
			const mapping = this.affinity.get(clientId);
			if (mapping) {
				const mapped = available.find((a) => a.id === mapping.accountId);
				if (mapped) {
					mapping.assignedAt = now;
					const others = this.rankByLeastUsed(available.filter((a) => a.id !== mapped.id), now);
					return [mapped, ...others];
				}
				return this.pickAndMark(available, now);
			}
		}

		const ranked = this.pickAndMark(available, now);
		const chosen = ranked[0];
		if (clientId !== null && chosen) {
			this.evictOldestIfFull();
			this.affinity.set(clientId, { accountId: chosen.id, assignedAt: now });
		}
		return ranked;
	}
}

it("debug spread - first 12 picks", () => {
	const accounts = [
		makeAccount({ id: "x" }),
		makeAccount({ id: "y" }),
		makeAccount({ id: "z" }),
	];
	const store = new MockStore();
	const strat = new SessionAffinityStrategy();
	strat.initialize(store);

	const picks: string[] = [];
	for (let i = 0; i < 12; i++) {
		const meta = { id: "r" + i, headers: new Headers(), timestamp: Date.now(), clientSessionId: `c-${i}` };
		const picked = strat.select(accounts, meta)[0].id;
		picks.push(picked);
	}
	console.log("FIRST 12 picks sequence:", picks.join(", "));
});

it("debug spread - 50 picks distribution", () => {
	const accounts = [
		makeAccount({ id: "x" }),
		makeAccount({ id: "y" }),
		makeAccount({ id: "z" }),
	];
	const store = new MockStore();
	const strat = new SessionAffinityStrategy();
	strat.initialize(store);

	const counts = new Map<string, number>();
	for (let i = 0; i < 50; i++) {
		const meta = { id: "r" + i, headers: new Headers(), timestamp: Date.now(), clientSessionId: `c-${i}` };
		const picked = strat.select(accounts, meta)[0].id;
		counts.set(picked, (counts.get(picked) ?? 0) + 1);
	}
	console.log("50 pick counts:", JSON.stringify(Array.from(counts.entries())));
});

it("debug spread - 50 picks with util=0 for all (control)", () => {
	const accounts = [
		makeAccount({ id: "x" }),
		makeAccount({ id: "y" }),
		makeAccount({ id: "z" }),
	];
	const store = new MockStore();
	store.utilization.set("x", 0);
	store.utilization.set("y", 0);
	store.utilization.set("z", 0);
	const strat = new SessionAffinityStrategy();
	strat.initialize(store);

	const counts = new Map<string, number>();
	for (let i = 0; i < 50; i++) {
		const meta = { id: "r" + i, headers: new Headers(), timestamp: Date.now(), clientSessionId: `c-${i}` };
		const picked = strat.select(accounts, meta)[0].id;
		counts.set(picked, (counts.get(picked) ?? 0) + 1);
	}
	console.log("50 pick counts (util=0):", JSON.stringify(Array.from(counts.entries())));
});

it("debug spread - 10 picks spread across seconds (real-world timing)", async () => {
	const accounts = [
		makeAccount({ id: "x" }),
		makeAccount({ id: "y" }),
		makeAccount({ id: "z" }),
	];
	const store = new MockStore();
	const strat = new SessionAffinityStrategy();
	strat.initialize(store);

	const picks: string[] = [];
	for (let i = 0; i < 10; i++) {
		const meta = { id: "r" + i, headers: new Headers(), timestamp: Date.now(), clientSessionId: `c-${i}` };
		picks.push(strat.select(accounts, meta)[0].id);
		// Real-world: ~600ms between project starts (outside recency window)
		await new Promise(r => setTimeout(r, 600));
	}
	console.log("10 picks (600ms gaps):", picks.join(", "));
}, 30_000);

it("debug spread - with utilization telemetry updated after each pick", async () => {
	const accounts = [
		makeAccount({ id: "x" }),
		makeAccount({ id: "y" }),
		makeAccount({ id: "z" }),
	];
	const store = new MockStore();
	const strat = new SessionAffinityStrategy();
	strat.initialize(store);

	const picks: string[] = [];
	for (let i = 0; i < 10; i++) {
		const meta = { id: "r" + i, headers: new Headers(), timestamp: Date.now(), clientSessionId: `c-${i}` };
		const picked = strat.select(accounts, meta)[0].id;
		picks.push(picked);
		// Simulate the proxy recording the request count on the picked account
		// (real-world: telemetry is updated asynchronously after each request).
		const prev = store.utilization.get(picked) ?? 0;
		store.utilization.set(picked, prev + 10);
		// 600ms between projects
		await new Promise(r => setTimeout(r, 600));
	}
	console.log("10 picks w/ util telemetry:", picks.join(", "));
}, 30_000);
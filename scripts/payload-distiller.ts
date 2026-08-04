#!/usr/bin/env bun
/**
 * payload-distiller — distill ccflare/ccmax request_payloads into engram + godkb.
 *
 * For each not-yet-distilled row in request_payloads it extracts:
 *   (a) a per-request record (prompt summary, model, cost, success)  -> engram kind:fact
 *   (b) a failure/error corpus entry for failed requests             -> engram kind:lesson
 *   (c) per-run cost rollups by model/account/UTC-day                -> engram kind:fact
 *   (d) recurring failure signatures (>=3 in a run, max 3/run)       -> godkb POST /seed (pattern)
 *
 * Idempotency: a sidecar table `payload_distilled(payload_id, distilled_at)` marks
 * completed rows (request_payloads itself is NEVER altered). Rows are marked ONLY
 * after their engram writes succeed (write-then-mark). If marking fails the run
 * aborts immediately so at most one row can ever be double-written on a re-run.
 * Rollups aggregate only rows newly marked in this run, so summing rollups across
 * runs never double-counts.
 *
 * KNOWN LIMIT (verified adversarially): a failed request emits TWO observations
 * (fact + lesson); if the second write fails after the first succeeded, the row
 * is not marked and the re-run re-posts the first observation. Exposure is
 * bounded to one duplicated observation per interrupted run. The dual chosen
 * deliberately: losing data (mark-then-write) is worse than one duplicate fact.
 *
 * Fail-safe behavior:
 *   - engram unreachable at startup  -> exit 2, nothing marked, nothing written
 *   - engram write fails after retry -> row is SKIPPED (not marked), run continues
 *   - godkb write fails              -> logged, never blocks distillation
 *   - --dry-run                      -> zero writes anywhere (no sidecar table,
 *                                       no INSERTs, no HTTP POSTs)
 *
 * Usage:
 *   DATABASE_URL=postgres://... bun scripts/payload-distiller.ts \
 *     --dry-run --limit 20 --source ccflare [--scope <engram-project>]
 *
 * The engram token comes from $ENGRAM_API_TOKEN or `cal-infisical get
 * /engram/ENGRAM_API_TOKEN`. It is never logged.
 */

import { SQL } from "bun";

// ---------------------------------------------------------------- CLI

export interface Args {
	dryRun: boolean;
	limit: number;
	scope: string;
	source: string;
	dbUrl: string | undefined;
	engramUrl: string;
	godkbUrl: string;
	godkb: boolean;
	verbose: boolean;
	onlyFailed: boolean;
	rollupOnly: boolean;
}

export function parseArgs(argv: string[]): Args {
	const args: Args = {
		dryRun: false,
		limit: 100,
		scope: "_distill_selftest",
		source: "ccflare",
		dbUrl: process.env.DATABASE_URL,
		engramUrl: process.env.ENGRAM_URL || "https://engram.zp.digital",
		godkbUrl: process.env.GODKB_URL || "https://godkb.zp.digital",
		godkb: true,
		verbose: false,
		onlyFailed: false,
		rollupOnly: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => {
			i++;
			const v = argv[i];
			if (v === undefined) throw new Error(`missing value for ${a}`);
			return v;
		};
		switch (a) {
			case "--dry-run":
				args.dryRun = true;
				break;
			case "--limit":
				args.limit = Math.max(1, Number.parseInt(next(), 10) || 100);
				break;
			case "--scope":
				args.scope = next();
				break;
			case "--source":
				args.source = next();
				break;
			case "--db-url":
				args.dbUrl = next();
				break;
			case "--engram-url":
				args.engramUrl = next();
				break;
			case "--godkb-url":
				args.godkbUrl = next();
				break;
			case "--no-godkb":
				args.godkb = false;
				break;
			case "--only-failed":
				args.onlyFailed = true;
				break;
			case "--rollup-only":
				// emit ONLY per-day/model cost rollups; skip the per-row fact/lesson
				// observations. Rows are still marked distilled (after their rollup
				// POSTs OK), so they become prune-eligible without flooding engram
				// with individual facts. Use for bulk success-row backfill.
				args.rollupOnly = true;
				break;
			case "--verbose":
				args.verbose = true;
				break;
			case "--help":
				console.log(
					"payload-distiller [--dry-run] [--limit N] [--scope engram-project] [--source ccflare|ccmax] [--only-failed] [--rollup-only] [--db-url URL] [--engram-url URL] [--godkb-url URL] [--no-godkb] [--verbose]",
				);
				process.exit(0);
				break;
			default:
				throw new Error(`unknown arg: ${a}`);
		}
	}
	if (!args.dbUrl) {
		throw new Error("DATABASE_URL (or --db-url) is required");
	}
	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(args.scope)) {
		throw new Error(`invalid --scope: ${args.scope}`);
	}
	return args;
}

// ------------------------------------------------------- extraction

/** Redact obvious secret material from free text before it leaves the DB. */
export function scrubSecrets(text: string): string {
	return text
		.replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "[REDACTED:anthropic-key]")
		.replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:api-key]")
		.replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github-token]")
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{16,}=*/gi, "$1[REDACTED]")
		.replace(
			/(["']?(?:password|passwd|secret|token|api[_-]?key|authorization)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
			"$1[REDACTED]",
		)
		.replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}/g, "[REDACTED:jwt]");
}

function truncate(text: string, max: number): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

function tryB64ToUtf8(value: string): string | null {
	try {
		const buf = Buffer.from(value, "base64");
		// Reject if round-trip fails badly (was not base64)
		if (buf.length === 0 && value.length > 0) return null;
		const text = buf.toString("utf8");
		if (text.includes("�")) return null;
		return text;
	} catch {
		return null;
	}
}

/** request/response bodies are stored either as base64 or as raw JSON text. */
function decodeBody(body: unknown): string | null {
	if (typeof body !== "string" || body.length === 0) return null;
	const t = body.trimStart();
	if (t.startsWith("{") || t.startsWith("[") || t.startsWith("event:")) {
		return body;
	}
	return tryB64ToUtf8(body) ?? body;
}

interface ContentBlock {
	type?: string;
	text?: string;
}

function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return (content as ContentBlock[])
			.filter((b) => b && b.type === "text" && typeof b.text === "string")
			.map((b) => b.text as string)
			.join(" ");
	}
	return "";
}

interface PromptInfo {
	summary: string;
	messageCount: number;
	bodyModel: string | null;
}

function extractPrompt(requestBodyRaw: string | null): PromptInfo {
	const out: PromptInfo = { summary: "", messageCount: 0, bodyModel: null };
	if (!requestBodyRaw) return out;
	try {
		const parsed = JSON.parse(requestBodyRaw) as Record<string, unknown>;
		if (typeof parsed.model === "string") out.bodyModel = parsed.model;
		const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
		out.messageCount = messages.length;
		// last user message is the live instruction; walk backwards
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i] as Record<string, unknown>;
			if (m?.role === "user") {
				const text = textOfContent(m.content);
				if (text.trim().length > 0) {
					out.summary = truncate(scrubSecrets(text), 300);
					break;
				}
			}
		}
		if (!out.summary && messages.length > 0) {
			const first = messages[0] as Record<string, unknown>;
			out.summary = truncate(scrubSecrets(textOfContent(first?.content)), 300);
		}
	} catch {
		out.summary = "(unparseable request body)";
	}
	return out;
}

interface PayloadMeta {
	success?: boolean;
	accountId?: string;
	timestamp?: number;
	project?: string;
	isStream?: boolean;
	trace?: { timestamp?: number; provider?: string };
	account?: { id?: string };
	transport?: { success?: boolean; isStream?: boolean };
}

interface DbRow {
	id: string;
	timestamp: string | number | null;
	json: string;
	model: string | null;
	cost_usd: number | null;
	success: boolean | null;
	status_code: number | null;
	error_message: string | null;
	account_used: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	total_tokens: number | null;
	response_time_ms: number | null;
	path: string | null;
}

interface Extracted {
	id: string;
	tsMs: number | null;
	model: string;
	success: boolean | null;
	costUsd: number;
	account: string;
	project: string | null;
	statusCode: number | null;
	errorMessage: string | null;
	prompt: PromptInfo;
	responseSnippet: string | null;
	totalTokens: number | null;
	responseTimeMs: number | null;
	path: string | null;
}

function toNum(v: string | number | null | undefined): number | null {
	if (v === null || v === undefined) return null;
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

function extractRow(row: DbRow): Extracted {
	let payload: Record<string, unknown> = {};
	try {
		payload = JSON.parse(row.json) as Record<string, unknown>;
	} catch {
		// keep {}: metadata from the requests join still yields a usable record
	}
	const meta = (payload.meta ?? {}) as PayloadMeta;
	const request = (payload.request ?? {}) as Record<string, unknown>;
	const response = (payload.response ?? {}) as Record<string, unknown>;

	const prompt = extractPrompt(decodeBody(request.body));
	// live rows have flat meta; repo-HEAD rows nest under trace/account/transport
	const metaSuccess = meta.success ?? meta.transport?.success ?? null;
	const success = row.success ?? metaSuccess;
	const account = row.account_used ?? meta.accountId ?? meta.account?.id ?? "unknown";
	const tsMs =
		toNum(row.timestamp) ?? meta.timestamp ?? meta.trace?.timestamp ?? null;

	let responseSnippet: string | null = null;
	let responseErrorMessage: string | null = null;
	if (success === false) {
		const respBody = decodeBody(response.body);
		if (respBody) {
			responseSnippet = truncate(scrubSecrets(respBody), 400);
			try {
				const parsed = JSON.parse(respBody) as {
					error?: { message?: string };
				};
				if (typeof parsed.error?.message === "string") {
					responseErrorMessage = truncate(scrubSecrets(parsed.error.message), 300);
				}
			} catch {
				// non-JSON error body; snippet already captured
			}
		}
	}

	return {
		id: row.id,
		tsMs,
		model: row.model ?? prompt.bodyModel ?? "unknown",
		success,
		costUsd: toNum(row.cost_usd) ?? 0,
		account,
		project: typeof meta.project === "string" ? meta.project : null,
		statusCode: row.status_code,
		errorMessage: row.error_message
			? truncate(scrubSecrets(row.error_message), 300)
			: responseErrorMessage,
		prompt,
		responseSnippet,
		totalTokens: toNum(row.total_tokens),
		responseTimeMs: toNum(row.response_time_ms),
		path: row.path,
	};
}

// ------------------------------------------------------ observations

interface Observation {
	kind: string;
	project: string;
	subject: string;
	body: string;
	evidence?: string[];
	tags?: string[];
}

function dayOf(tsMs: number | null): string {
	if (!tsMs) return "unknown-day";
	return new Date(tsMs).toISOString().slice(0, 10);
}

function factOf(e: Extracted, args: Args): Observation {
	const status =
		e.success === true ? "ok" : e.success === false ? "FAILED" : "unknown";
	const shortId = e.id.slice(0, 8);
	const lines = [
		`model=${e.model} status=${status} cost_usd=${e.costUsd.toFixed(4)} account=${e.account}`,
		`tokens=${e.totalTokens ?? "?"} response_ms=${e.responseTimeMs ?? "?"} messages=${e.prompt.messageCount} path=${e.path ?? "?"}${e.project ? ` project=${e.project}` : ""}`,
		`prompt: ${e.prompt.summary || "(empty)"}`,
	];
	return {
		kind: "fact",
		project: args.scope,
		subject: `${args.source} req ${shortId} ${dayOf(e.tsMs)}: ${e.model} ${status}`,
		body: lines.join("\n"),
		evidence: [`db=${args.source} request_payloads.id=${e.id}`],
		tags: ["payload-distill", args.source, e.model, status],
	};
}

function lessonOf(e: Extracted, args: Args): Observation {
	const shortId = e.id.slice(0, 8);
	const lines = [
		`model=${e.model} http_status=${e.statusCode ?? "?"} account=${e.account}${e.project ? ` project=${e.project}` : ""}`,
		`error: ${e.errorMessage ?? "(no error_message)"}`,
		`prompt: ${e.prompt.summary || "(empty)"}`,
	];
	if (e.responseSnippet) lines.push(`response: ${e.responseSnippet}`);
	return {
		kind: "lesson",
		project: args.scope,
		subject: `${args.source} failure ${shortId} ${dayOf(e.tsMs)}: ${e.model} HTTP ${e.statusCode ?? "?"}`,
		body: lines.join("\n"),
		evidence: [`db=${args.source} request_payloads.id=${e.id}`],
		tags: ["payload-distill", "failure-corpus", args.source, e.model],
	};
}

interface Rollup {
	model: string;
	account: string;
	day: string;
	requests: number;
	failures: number;
	costUsd: number;
	totalTokens: number;
}

function rollupObservation(r: Rollup, runId: string, args: Args): Observation {
	return {
		kind: "fact",
		project: args.scope,
		subject: `${args.source} cost rollup ${r.day} ${r.model} acct=${r.account.slice(0, 8)} (run ${runId})`,
		body: `requests=${r.requests} failures=${r.failures} cost_usd=${r.costUsd.toFixed(4)} total_tokens=${r.totalTokens} model=${r.model} account=${r.account} day=${r.day} source=${args.source}. Partial per-run rollup: covers only rows distilled in run ${runId}; sum rollup rows for full-day totals.`,
		tags: ["payload-distill", "cost-rollup", args.source, r.model],
	};
}

// --------------------------------------------------------- transports

const FETCH_TIMEOUT_MS = 15_000;
const RETRIES = 3;

async function postJson(
	url: string,
	body: unknown,
	headers: Record<string, string>,
): Promise<Response> {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json", ...headers },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
}

async function postWithRetry(
	url: string,
	body: unknown,
	headers: Record<string, string>,
	label: string,
): Promise<boolean> {
	for (let attempt = 1; attempt <= RETRIES; attempt++) {
		try {
			const res = await postJson(url, body, headers);
			if (res.ok) return true;
			// 4xx (other than 429) will not heal on retry
			if (res.status >= 400 && res.status < 500 && res.status !== 429) {
				console.error(
					`[distill] ${label}: HTTP ${res.status} (permanent) ${truncate(await res.text(), 200)}`,
				);
				return false;
			}
			console.error(`[distill] ${label}: HTTP ${res.status} (attempt ${attempt}/${RETRIES})`);
		} catch (err) {
			console.error(
				`[distill] ${label}: ${err instanceof Error ? err.message : String(err)} (attempt ${attempt}/${RETRIES})`,
			);
		}
		if (attempt < RETRIES) await Bun.sleep(500 * 2 ** (attempt - 1));
	}
	return false;
}

export function getEngramToken(): string {
	const env = process.env.ENGRAM_API_TOKEN;
	if (env) return env;
	const proc = Bun.spawnSync(["cal-infisical", "get", "/engram/ENGRAM_API_TOKEN"]);
	const out = proc.stdout?.toString().trim();
	if (proc.exitCode === 0 && out) return out;
	throw new Error(
		"engram token unavailable: set ENGRAM_API_TOKEN or ensure cal-infisical works",
	);
}

/**
 * The SQL fragment for the json body column.
 *
 * In `--rollup-only` mode the distiller substitutes `'{}'::text AS json` so a
 * full-corpus pass never loads the (potentially large) payload bodies into
 * memory — the OOM guard. In normal mode it selects the real `rp.json` column.
 * Returning a plain string keeps both the test and the call site trivially
 * honest: Bun's sql tagged template inlines raw SQL fragments, so the rendered
 * query is identical to the pre-refactor behavior.
 */
export function jsonColumnExpression(rollupOnly: boolean): string {
	return rollupOnly ? "'{}'::text AS json" : "rp.json";
}

/**
 * POST a single rollup observation and, in `--rollup-only` mode, mark each of
 * the rollup's payload ids as distilled ONLY after the POST succeeds.
 *
 * Marking order is the load-bearing claim: rows are NOT marked before the
 * rollup POST succeeds, and a failed POST leaves rows unmarked so the prune
 * gate will not delete them. Extracted to make this guarantee testable with
 * mocked `postFn` / `markFn` injection.
 *
 * `postFn` and `markFn` are injected so tests can drive the success/failure
 * outcome without touching the network or a real database. In production,
 * `postFn` is `postWithRetry` and `markFn` is the `INSERT INTO payload_distilled`
 * call; throws from `markFn` propagate so the caller can abort the run.
 */
export async function postRollupAndMark(
	rollup: Rollup,
	ids: string[],
	args: Args,
	runId: string,
	postFn: (observation: Observation) => Promise<boolean>,
	markFn: (id: string) => Promise<void>,
): Promise<{ distilled: number; skipped: number }> {
	const result = { distilled: 0, skipped: 0 };
	if (args.dryRun) {
		if (args.rollupOnly) result.distilled = ids.length;
		return result;
	}
	const ok = await postFn(rollupObservation(rollup, runId, args));
	if (!args.rollupOnly) {
		return result;
	}
	if (!ok) {
		result.skipped = ids.length;
		return result;
	}
	for (const id of ids) {
		await markFn(id);
		result.distilled++;
	}
	return result;
}

// -------------------------------------------------------------- main

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
	console.log(
		`[distill] run=${runId} source=${args.source} scope=${args.scope} limit=${args.limit} dry_run=${args.dryRun}`,
	);

	let token = "";
	if (!args.dryRun) {
		token = getEngramToken();
		// fail-closed: engram must be reachable before we touch anything
		const health = await fetch(`${args.engramUrl}/health`, {
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		}).catch(() => null);
		if (!health || !health.ok) {
			console.error(
				`[distill] ABORT: engram health check failed (${args.engramUrl}/health -> ${health ? health.status : "unreachable"}); nothing written, nothing marked`,
			);
			return 2;
		}
	}

	const sql = new SQL({ url: args.dbUrl, max: 1, connectionTimeout: 15 });

	const sidecarExists =
		(
			await sql`SELECT to_regclass('payload_distilled') IS NOT NULL AS present`
		)[0]?.present === true;

	if (!args.dryRun && !sidecarExists) {
		await sql`CREATE TABLE IF NOT EXISTS payload_distilled (
			payload_id TEXT PRIMARY KEY,
			distilled_at BIGINT NOT NULL
		)`;
		console.log("[distill] created sidecar table payload_distilled");
	}

	const useSidecarFilter = sidecarExists || !args.dryRun;
	const sidecarClause = useSidecarFilter
		? sql`AND NOT EXISTS (SELECT 1 FROM payload_distilled d WHERE d.payload_id = rp.id)`
		: sql``;
	const failedClause = args.onlyFailed ? sql`AND r.success = false` : sql``;
	// --rollup-only needs only the metadata (from the requests join + timestamp);
	// substitute an empty-object literal for the potentially-large json body so a
	// big backfill can't OOM the box. '{}' (not NULL) keeps extractRow's payload
	// parsing null-safe; rollups read the join columns + timestamp, never json.
	const jsonCol = sql([jsonColumnExpression(args.rollupOnly)]);
	const rows: DbRow[] = await sql`
		SELECT rp.id, rp.timestamp, ${jsonCol},
		       r.model, r.cost_usd, r.success, r.status_code, r.error_message,
		       r.account_used, r.input_tokens, r.output_tokens, r.total_tokens,
		       r.response_time_ms, r.path
		FROM request_payloads rp
		LEFT JOIN requests r ON r.id = rp.id
		WHERE TRUE ${sidecarClause} ${failedClause}
		ORDER BY rp.timestamp ASC NULLS FIRST
		LIMIT ${args.limit}`;

	console.log(`[distill] fetched ${rows.length} undistilled rows`);

	const engramHeaders = { authorization: `Bearer ${token}` };
	const observationsUrl = `${args.engramUrl}/v1/observations`;

	let distilled = 0;
	let skipped = 0;
	let factCount = 0;
	let lessonCount = 0;
	const rollups = new Map<string, Rollup>();
	const rollupIds = new Map<string, string[]>();
	const failureSignatures = new Map<string, number>();
	const marked: Extracted[] = [];

	for (const row of rows) {
		const e = extractRow(row);

		// rollups aggregate ONLY rows processed in this run (idempotent across runs).
		// Done first so it runs for every row in both normal and rollup-only modes.
		const key = `${e.model}|${e.account}|${dayOf(e.tsMs)}`;
		const r = rollups.get(key) ?? {
			model: e.model,
			account: e.account,
			day: dayOf(e.tsMs),
			requests: 0,
			failures: 0,
			costUsd: 0,
			totalTokens: 0,
		};
		r.requests++;
		if (e.success === false) {
			r.failures++;
			const sig = `${e.statusCode ?? "?"}:${(e.errorMessage ?? "").slice(0, 80)}`;
			failureSignatures.set(sig, (failureSignatures.get(sig) ?? 0) + 1);
		}
		r.costUsd += e.costUsd;
		r.totalTokens += e.totalTokens ?? 0;
		rollups.set(key, r);

		// --rollup-only: emit no per-row fact/lesson; record the id under its rollup
		// key and defer marking until that rollup POSTs OK (rollup loop below),
		// preserving the emit-then-mark fail-closed guarantee.
		if (args.rollupOnly) {
			const ids = rollupIds.get(key) ?? [];
			ids.push(e.id);
			rollupIds.set(key, ids);
			continue;
		}

		const obs: Observation[] = [factOf(e, args)];
		if (e.success === false) obs.push(lessonOf(e, args));

		if (args.dryRun) {
			for (const o of obs) {
				console.log(`\n--- DRY RUN would POST ${observationsUrl}`);
				console.log(`kind=${o.kind} project=${o.project}`);
				console.log(`subject: ${o.subject}`);
				console.log(o.body);
			}
			factCount++;
			if (obs.length > 1) lessonCount++;
			marked.push(e);
			distilled++;
		} else {
			let allOk = true;
			for (const o of obs) {
				const ok = await postWithRetry(
					observationsUrl,
					o,
					engramHeaders,
					`engram ${o.kind} for ${e.id.slice(0, 8)}`,
				);
				if (!ok) {
					allOk = false;
					break;
				}
			}
			if (!allOk) {
				skipped++;
				continue; // not marked -> retried next run
			}
			factCount++;
			if (obs.length > 1) lessonCount++;
			try {
				await sql`INSERT INTO payload_distilled (payload_id, distilled_at)
					VALUES (${e.id}, ${Date.now()})
					ON CONFLICT (payload_id) DO NOTHING`;
			} catch (err) {
				console.error(
					`[distill] ABORT: failed to mark ${e.id} distilled (${err instanceof Error ? err.message : err}); stopping to bound double-writes`,
				);
				await sql.end();
				return 3;
			}
			marked.push(e);
			distilled++;
		}
	}

	// (c) cost rollups
	for (const [key, r] of rollups.entries()) {
		const ids = rollupIds.get(key) ?? [];
		if (args.dryRun) {
			const o = rollupObservation(r, runId, args);
			console.log(`\n--- DRY RUN would POST ${observationsUrl} (rollup)`);
			console.log(`kind=${o.kind} subject: ${o.subject}`);
			console.log(o.body);
			if (args.rollupOnly) distilled += ids.length;
			continue;
		}
		// --rollup-only: mark this rollup's rows ONLY after the rollup POST
		// succeeded. A failed rollup leaves its rows undistilled -> retried,
		// never deleted by the prune gate. Fail-closed. The markFn's INSERT
		// throw is the abort signal: bind it to exit code 3 here so the
		// run halts and a re-run can't double-write.
		let sub: { distilled: number; skipped: number };
		try {
			sub = await postRollupAndMark(
				r,
				ids,
				args,
				runId,
				(obs) =>
					postWithRetry(
						observationsUrl,
						obs,
						engramHeaders,
						`engram rollup ${r.day}/${r.model}`,
					),
				async (id) => {
					await sql`INSERT INTO payload_distilled (payload_id, distilled_at)
						VALUES (${id}, ${Date.now()})
						ON CONFLICT (payload_id) DO NOTHING`;
				},
			);
		} catch (err) {
			console.error(
				`[distill] ABORT: failed to mark distilled (${err instanceof Error ? err.message : err}); stopping to bound double-writes`,
			);
			await sql.end();
			return 3;
		}
		distilled += sub.distilled;
		skipped += sub.skipped;
	}

	// (d) godkb seeds for recurring failure signatures — sparingly
	if (args.godkb) {
		const recurring = [...failureSignatures.entries()]
			.filter(([, n]) => n >= 3)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 3);
		for (const [sig, n] of recurring) {
			const seed = {
				kind: "pattern",
				name: `ccflare-failure-signature: ${truncate(sig, 90)}`,
				description: `Recurring proxy failure through ${args.source}: signature "${sig}" hit ${n}x in one distill batch (run ${runId}, ${rows.length} rows). Distilled from request_payloads by payload-distiller.`,
				project: "ccflare",
			};
			if (args.dryRun) {
				console.log(`\n--- DRY RUN would POST ${args.godkbUrl}/seed`);
				console.log(JSON.stringify(seed, null, 1));
			} else {
				// godkb is best-effort: failure never blocks distillation
				await postWithRetry(`${args.godkbUrl}/seed`, seed, {}, "godkb seed");
			}
		}
	}

	await sql.end();
	console.log(
		`\n[distill] done run=${runId}: rows=${rows.length} distilled=${distilled} skipped=${skipped} facts=${factCount} lessons=${lessonCount} rollups=${rollups.size}${args.dryRun ? " (DRY RUN — nothing written)" : ""}`,
	);
	return skipped > 0 ? 1 : 0;
}

// Only run when invoked as a script. Importing this module (e.g. from tests)
// must not execute main() — bun:test imports the module file to access the
// exported parseArgs / scrubSecrets / getEngramToken / jsonColumnExpression /
// postRollupAndMark helpers.
if (import.meta.main) {
	main()
		.then((code) => process.exit(code))
		.catch((err) => {
			console.error(`[distill] fatal: ${err instanceof Error ? err.message : err}`);
			process.exit(4);
		});
}

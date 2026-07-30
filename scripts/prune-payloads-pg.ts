#!/usr/bin/env bun
/**
 * prune-payloads-pg — the fail-closed, distill-gated retention prune for the
 * POSTGRES request_payloads store (supabase-db). This is the postgres sibling of
 * packages/database/src/prune-gate.ts (which targets the app's bun:sqlite DB); the
 * production payload corpus that the payload-distiller reads lives in postgres, so
 * the destructive retention delete for THAT store must run here.
 *
 * The gate is identical in spirit and NEVER deletes:
 *   - anything when the `payload_distilled` marker table is absent (fail closed),
 *   - a payload that is past retention but NOT marked distilled (kept + counted),
 *   - anything at all in the default DRY mode.
 * A payload is deleted ONLY when it is BOTH older than the retention window AND
 * present in `payload_distilled` (i.e. its knowledge is durably in engram).
 *
 * Distillation strictly precedes deletion. Run the distiller first; this second.
 *
 * Usage:
 *   bun scripts/prune-payloads-pg.ts                 # DRY report (nothing deleted)
 *   bun scripts/prune-payloads-pg.ts --apply         # actually delete old+distilled
 *   [--retention-days N] [--batch N] [--max-batches N] [--time-budget-ms N]
 *   [--db-url URL]   (defaults to $DATABASE_URL)
 */
import { SQL } from "bun";

interface Args {
	apply: boolean;
	retentionDays: number;
	batch: number;
	maxBatches: number;
	timeBudgetMs: number;
	dbUrl: string | undefined;
}

function parseArgs(argv: string[]): Args {
	const args: Args = {
		apply: false,
		retentionDays: 7,
		batch: 2000,
		maxBatches: 10000,
		timeBudgetMs: 10 * 60 * 1000,
		dbUrl: process.env.DATABASE_URL,
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
			case "--apply":
				args.apply = true;
				break;
			case "--retention-days":
				args.retentionDays = Math.max(0, Number.parseInt(next(), 10));
				break;
			case "--batch":
				args.batch = Math.max(1, Number.parseInt(next(), 10) || 2000);
				break;
			case "--max-batches":
				args.maxBatches = Math.max(1, Number.parseInt(next(), 10) || 10000);
				break;
			case "--time-budget-ms":
				args.timeBudgetMs = Math.max(1000, Number.parseInt(next(), 10) || 600000);
				break;
			case "--db-url":
				args.dbUrl = next();
				break;
			case "--help":
				console.log(
					"prune-payloads-pg [--apply] [--retention-days N] [--batch N] [--max-batches N] [--time-budget-ms N] [--db-url URL]",
				);
				process.exit(0);
			default:
				throw new Error(`unknown arg: ${a}`);
		}
	}
	if (!args.dbUrl) throw new Error("DATABASE_URL (or --db-url) is required");
	return args;
}

async function main(): Promise<number> {
	const args = parseArgs(process.argv.slice(2));
	// timestamp column is bigint epoch-ms; verified against the live schema.
	const cutoff = Date.now() - args.retentionDays * 86_400_000;
	const mode = args.apply ? "APPLY (deleting)" : "DRY (report only)";
	console.log(
		`[prune] mode=${mode} retention_days=${args.retentionDays} cutoff_ms=${cutoff} batch=${args.batch}`,
	);

	const sql = new SQL({ url: args.dbUrl, max: 1, connectionTimeout: 15 });

	// FAIL CLOSED: without the marker table we cannot prove anything is distilled.
	const markerPresent =
		(
			await sql`SELECT to_regclass('payload_distilled') IS NOT NULL AS present`
		)[0]?.present === true;
	if (!markerPresent) {
		const oldTotal = (
			await sql`SELECT count(*)::int n FROM request_payloads WHERE timestamp < ${cutoff}`
		)[0].n;
		console.error(
			`[prune] FAIL_CLOSED: marker table 'payload_distilled' missing — the distiller has not run here. Deleting nothing. ${oldTotal} old payload(s) would be at risk.`,
		);
		await sql.end();
		return 2;
	}

	// Report counters (computed BEFORE any deletion).
	const oldTotal = (
		await sql`SELECT count(*)::int n FROM request_payloads WHERE timestamp < ${cutoff}`
	)[0].n;
	const oldDistilled = (
		await sql`SELECT count(*)::int n FROM request_payloads rp
			JOIN payload_distilled pd ON pd.payload_id = rp.id
			WHERE rp.timestamp < ${cutoff}`
	)[0].n;
	const oldUndistilled = oldTotal - oldDistilled;

	console.log(
		`[prune] old=${oldTotal} deletable(old+distilled)=${oldDistilled} KEPT(old+undistilled)=${oldUndistilled}`,
	);
	if (oldUndistilled > 0) {
		console.warn(
			`[prune] ALERT: ${oldUndistilled} payload(s) are past retention but NOT distilled — KEPT (fail-closed). Run the distiller to make them prune-eligible; they will NOT be deleted until then.`,
		);
	}

	if (!args.apply) {
		console.log(
			`[prune] DRY: would delete ${oldDistilled} payload(s); nothing deleted. Re-run with --apply to delete.`,
		);
		await sql.end();
		return 0;
	}

	// APPLY: batched delete of old + distilled only. Fail-closed on any error.
	let deletedTotal = 0;
	let batches = 0;
	const startedAt = Date.now();
	try {
		for (;;) {
			if (batches >= args.maxBatches) {
				console.warn(`[prune] stopped: hit max-batches=${args.maxBatches}`);
				break;
			}
			if (Date.now() - startedAt > args.timeBudgetMs) {
				console.warn(`[prune] stopped: hit time budget ${args.timeBudgetMs}ms`);
				break;
			}
			const r = await sql`
				WITH victims AS (
					SELECT rp.id FROM request_payloads rp
					JOIN payload_distilled pd ON pd.payload_id = rp.id
					WHERE rp.timestamp < ${cutoff}
					LIMIT ${args.batch}
				), del AS (
					DELETE FROM request_payloads WHERE id IN (SELECT id FROM victims) RETURNING 1
				)
				SELECT count(*)::int AS n FROM del`;
			const n = r[0].n as number;
			deletedTotal += n;
			batches++;
			if (n === 0) break;
		}
	} catch (err) {
		console.error(
			`[prune] FAIL_CLOSED: error mid-run (${err instanceof Error ? err.message : String(err)}); deleted ${deletedTotal} so far, stopping.`,
		);
		await sql.end();
		return 3;
	}

	await sql.end();
	console.log(
		`[prune] done: deleted ${deletedTotal} old+distilled payload(s) in ${batches} batch(es); kept ${oldUndistilled} undistilled.`,
	);
	return 0;
}

main()
	.then((code) => process.exit(code))
	.catch((err) => {
		console.error(`[prune] fatal: ${err instanceof Error ? err.message : err}`);
		process.exit(4);
	});

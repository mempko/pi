/**
 * Aggregate a cache-research JSONL run into chart-ready tables for the paper.
 *
 * Reads --in <jsonl>, groups by (model, size, idle, condition), takes medians
 * across samples, and writes to --outdir (default paper/data):
 *   - hit-<size>.dat / ttft-<size>.dat / cost-<size>.dat  (pgfplots wide tables)
 *   - summary.csv                                          (every aggregated cell)
 *   - summary.json                                         (structured aggregates)
 *   - macros.tex                                           (headline \newcommands)
 *
 * Decay series share a common idle=0 origin (the "warm" reference), so each
 * provider gets a baseline curve and a keepalive curve from the same start.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

interface CallResult {
	promptTokens: number;
	cachedTokens: number;
	costUsd: number;
	ttftMs?: number;
	completedAtMs: number;
	provider?: string;
	error?: string;
}
interface CellResult {
	v: 2;
	model: string;
	transport: string;
	sizeTokens: number;
	idleSeconds: number;
	condition: "warm" | "baseline" | "keepalive";
	sample: number;
	pings: CallResult[];
	pingsPlanned: number;
	reqA?: CallResult;
	reqB?: CallResult;
	trueIdleSeconds?: number;
	reqBQueueWaitMs?: number;
	maxRefreshGapMs?: number;
	validity: { overall: boolean } & Record<string, boolean>;
	cost: { reqA: number; pings: number; reqB: number; total: number };
	error?: string;
}

function parseArgs(argv: string[]): { in: string; outdir: string } {
	let input = "";
	let outdir = "paper/data";
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--in") input = argv[++i] ?? "";
		else if (argv[i] === "--outdir") outdir = argv[++i] ?? outdir;
	}
	if (!input) throw new Error("--in <jsonl> required");
	return { in: input, outdir };
}

function median(values: number[]): number {
	if (values.length === 0) return Number.NaN;
	const s = [...values].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 === 0 ? (s[m - 1]! + s[m]!) / 2 : s[m]!;
}

function vendor(model: string): string {
	// "anthropic:claude-sonnet-4-5" -> anthropic ; "deepseek/deepseek-v3.2" -> deepseek
	return model.split(":")[0]?.split("/")[0] ?? model;
}

interface Agg {
	model: string;
	vendor: string;
	sizeTokens: number;
	idleSeconds: number;
	condition: string;
	n: number;
	warm: number;
	hitPct: number;
	ttftMs: number;
	costUsd: number;
	costTotalUsd: number;
	pings: number;
	provider: string;
}

function main(): void {
	const args = parseArgs(process.argv.slice(2));
	mkdirSync(args.outdir, { recursive: true });

	const cells: CellResult[] = readFileSync(args.in, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line))
		.filter((c) => c && typeof c === "object" && (c as Record<string, unknown>).v === 2 && !(c as Record<string, unknown>).type);

	// Group VALID reqB observations only: cells that failed a measurement-integrity
	// gate (queue delay, idle slip, backend change, broken keepalive schedule,
	// call error) are excluded and counted, never silently averaged in.
	const groups = new Map<string, CellResult[]>();
	let dropped = 0;
	for (const cell of cells) {
		if (!cell.reqB || cell.reqB.error || cell.reqB.promptTokens <= 0 || !cell.validity?.overall) {
			dropped++;
			continue;
		}
		const key = `${cell.model}|${cell.sizeTokens}|${cell.idleSeconds}|${cell.condition}`;
		(groups.get(key) ?? groups.set(key, []).get(key)!).push(cell);
	}

	const aggs: Agg[] = [];
	for (const [key, group] of groups) {
		const [model, size, idle, condition] = key.split("|");
		const hit = group.map((c) => (c.reqB!.cachedTokens / c.reqB!.promptTokens) * 100);
		const ttft = group.map((c) => c.reqB!.ttftMs ?? c.reqB!.completedAtMs - c.reqB!.queuedAtMs);
		const cost = group.map((c) => c.reqB!.costUsd);
		const costTotal = group.map((c) => c.cost.total);
		const pings = group.map((c) => c.pings.length);
		aggs.push({
			model: model!,
			vendor: vendor(model!),
			sizeTokens: Number(size),
			idleSeconds: Number(idle),
			condition: condition!,
			n: group.length,
			warm: hit.filter((h) => h >= 90).length,
			hitPct: median(hit),
			ttftMs: median(ttft),
			costUsd: median(cost),
			costTotalUsd: median(costTotal),
			pings: median(pings),
			provider: group[0]!.reqB!.provider ?? "?",
		});
	}
	aggs.sort(
		(a, b) =>
			a.vendor.localeCompare(b.vendor) ||
			a.sizeTokens - b.sizeTokens ||
			a.idleSeconds - b.idleSeconds ||
			a.condition.localeCompare(b.condition),
	);

	// summary.csv + summary.json
	const csvHeader = "vendor,model,provider,sizeTokens,idleSeconds,condition,n,hitPct,ttftMs,costUsd,costTotalUsd,pings";
	const csvRows = aggs.map(
		(a) =>
			`${a.vendor},${a.model},${a.provider},${a.sizeTokens},${a.idleSeconds},${a.condition},${a.n},` +
			`${a.hitPct.toFixed(1)},${a.ttftMs.toFixed(0)},${a.costUsd.toFixed(6)},${a.costTotalUsd.toFixed(6)},${a.pings}`,
	);
	writeFileSync(`${args.outdir}/summary.csv`, `${csvHeader}\n${csvRows.join("\n")}\n`);
	writeFileSync(`${args.outdir}/summary.json`, JSON.stringify(aggs, null, 2));

	// pgfplots wide tables: rows = idle, columns = <vendor>_<baseline|keepalive>.
	const vendors = [...new Set(aggs.map((a) => a.vendor))].sort();
	const sizes = [...new Set(aggs.map((a) => a.sizeTokens))].sort((a, b) => a - b);
	const idles = [...new Set(aggs.map((a) => a.idleSeconds))].sort((a, b) => a - b);
	const conditions = ["baseline", "keepalive"];

	const pick = (size: number, idle: number, cond: string, vend: string): Agg | undefined =>
		aggs.find(
			(a) => a.sizeTokens === size && a.idleSeconds === idle && a.condition === cond && a.vendor === vend,
		);
	// idle=0 has only "warm"; use it as the shared origin for both curves.
	const originHit = (size: number, vend: string) => pick(size, 0, "warm", vend)?.hitPct;
	const originTtft = (size: number, vend: string) => pick(size, 0, "warm", vend)?.ttftMs;
	const originCost = (size: number, vend: string) => pick(size, 0, "warm", vend)?.costUsd;

	const metricValue = (
		metric: "hit" | "ttft" | "cost",
		size: number,
		idle: number,
		cond: string,
		vend: string,
	): number | undefined => {
		if (idle === 0) {
			if (metric === "hit") return originHit(size, vend);
			if (metric === "ttft") return originTtft(size, vend);
			return originCost(size, vend);
		}
		const a = pick(size, idle, cond, vend);
		if (!a) return undefined;
		return metric === "hit" ? a.hitPct : metric === "ttft" ? a.ttftMs : a.costUsd;
	};

	const columnKeys = vendors.flatMap((v) => conditions.map((c) => `${v}_${c}`));
	for (const metric of ["hit", "ttft", "cost"] as const) {
		for (const size of sizes) {
			const header = `idle ${columnKeys.join(" ")}`;
			const rows = idles.map((idle) => {
				const cols = vendors.flatMap((v) =>
					conditions.map((c) => {
						const value = metricValue(metric, size, idle, c, v);
						return value === undefined || Number.isNaN(value) ? "nan" : value.toFixed(metric === "cost" ? 6 : 2);
					}),
				);
				return `${idle} ${cols.join(" ")}`;
			});
			writeFileSync(`${args.outdir}/${metric}-${size}.dat`, `${header}\n${rows.join("\n")}\n`);
		}
	}

	// Vendor styling and per-figure pgfplots plot snippets, so the paper adapts
	// to any number of providers without editing the LaTeX.
	const VENDOR_META: Record<string, { display: string; rgb: string; markBase: string; markKa: string }> = {
		anthropic: { display: "Anthropic", rgb: "198,93,42", markBase: "o", markKa: "*" },
		openai: { display: "OpenAI", rgb: "16,140,110", markBase: "triangle", markKa: "triangle*" },
		google: { display: "Google", rgb: "58,120,216", markBase: "square", markKa: "square*" },
		deepseek: { display: "DeepSeek", rgb: "150,80,190", markBase: "diamond", markKa: "diamond*" },
	};
	const FALLBACK = [
		{ rgb: "120,120,120", markBase: "pentagon", markKa: "pentagon*" },
		{ rgb: "200,150,0", markBase: "x", markKa: "x" },
	];
	const meta = (v: string, i: number) =>
		VENDOR_META[v] ?? {
			display: v.charAt(0).toUpperCase() + v.slice(1),
			...FALLBACK[i % FALLBACK.length]!,
		};
	const colorName = (v: string) => `vc${v.replace(/[^a-zA-Z]/g, "")}`;

	writeFileSync(
		`${args.outdir}/palette.tex`,
		`${vendors.map((v, i) => `\\definecolor{${colorName(v)}}{RGB}{${meta(v, i).rgb}}`).join("\n")}\n`,
	);
	for (const metric of ["hit", "ttft", "cost"] as const) {
		for (const size of sizes) {
			const lines = vendors.flatMap((v, i) => {
				const m = meta(v, i);
				const c = colorName(v);
				const file = `data/${metric}-${size}.dat`;
				return [
					`\\addplot[${c}, dashed, mark=${m.markBase}, mark size=1.4pt] table[x=idle, y=${v}_baseline] {${file}}; \\addlegendentry{${m.display} base}`,
					`\\addplot[${c}, thick, mark=${m.markKa}, mark size=1.4pt] table[x=idle, y=${v}_keepalive] {${file}}; \\addlegendentry{${m.display} KA}`,
				];
			});
			writeFileSync(`${args.outdir}/plot-${metric}-${size}.tex`, `${lines.join("\n")}\n`);
		}
	}

	// Warm-rate (fraction of samples >=90% cached) tables + small-multiple plot
	// snippets. The data is bimodal, so the warm RATE, not median hit%, is the
	// metric the paper argues in; one panel per provider keeps the three
	// regimes readable where a single overlaid chart is not.
	for (const size of sizes) {
		const header = `idle ${columnKeys.join(" ")}`;
		const rows = idles.map((idle) => {
			const cols = vendors.flatMap((v) =>
				conditions.map((c) => {
					const a = idle === 0 ? pick(size, 0, "warm", v) : pick(size, idle, c, v);
					const wr = a && a.n > 0 ? (100 * a.warm) / a.n : undefined;
					return wr === undefined || Number.isNaN(wr) ? "nan" : wr.toFixed(1);
				}),
			);
			return `${idle} ${cols.join(" ")}`;
		});
		writeFileSync(`${args.outdir}/warm-${size}.dat`, `${header}\n${rows.join("\n")}\n`);
		for (const [i, v] of vendors.entries()) {
			const m = meta(v, i);
			const c = colorName(v);
			const file = `data/warm-${size}.dat`;
			const lines = [
				`\\addplot[${c}, dashed, mark=${m.markBase}, mark size=1.6pt] table[x=idle, y=${v}_baseline] {${file}};`,
				`\\addplot[${c}, thick, mark=${m.markKa}, mark size=1.6pt] table[x=idle, y=${v}_keepalive] {${file}};`,
			];
			writeFileSync(`${args.outdir}/plot-warm-${size}-${v}.tex`, `${lines.join("\n")}\n`);
		}
	}

	// Headline macros for the paper prose.
	const macro = (name: string, value: string) => `\\newcommand{\\${name}}{${value}}`;
	const worstBaseline = aggs
		.filter((a) => a.condition === "baseline")
		.reduce((min, a) => (a.hitPct < min.hitPct ? a : min), { hitPct: Number.POSITIVE_INFINITY } as Agg);
	const keepaliveMinHit = aggs
		.filter((a) => a.condition === "keepalive")
		.reduce((min, a) => (a.hitPct < min.hitPct ? a : min), { hitPct: Number.POSITIVE_INFINITY } as Agg);
	// Largest cost gaps at max idle: (a) on the post-idle request alone (reqB),
	// and (b) net of the keepalive's own ping traffic (whole-strategy cost) --
	// the honest number v1 omitted.
	const maxIdle = Math.max(...idles);
	let bestSavingRatio = 1;
	let bestSavingDesc = "";
	let bestNetSavingRatio = 1;
	let bestNetSavingDesc = "";
	for (const size of sizes) {
		for (const v of vendors) {
			const base = pick(size, maxIdle, "baseline", v);
			const ka = pick(size, maxIdle, "keepalive", v);
			if (base && ka && ka.costUsd > 0 && base.costUsd / ka.costUsd > bestSavingRatio) {
				bestSavingRatio = base.costUsd / ka.costUsd;
				bestSavingDesc = `${v} at ${size} tokens, ${maxIdle}s idle (post-idle request only)`;
			}
			if (base && ka && ka.costTotalUsd > 0 && base.costTotalUsd / ka.costTotalUsd > bestNetSavingRatio) {
				bestNetSavingRatio = base.costTotalUsd / ka.costTotalUsd;
				bestNetSavingDesc = `${v} at ${size} tokens, ${maxIdle}s idle (net of keepalive pings)`;
			}
		}
	}
	const maxN = aggs.reduce((m, a) => Math.max(m, a.n), 0);
	const displayName = (v: string) =>
		({ anthropic: "Anthropic", openai: "OpenAI", google: "Google", deepseek: "DeepSeek" })[v] ??
		v.charAt(0).toUpperCase() + v.slice(1);
	const macros = [
		macro("dataRunCells", String(cells.length)),
		macro("dataSamples", String(maxN)),
		macro("dataProviderCount", String(vendors.length)),
		macro("dataVendorsNice", vendors.map(displayName).join(", ")),
		macro("dataVendors", vendors.join(", ")),
		macro("dataSizes", sizes.map((s) => `${Math.round(s / 1000)}k`).join(", ")),
		macro("dataIdles", idles.join(", ")),
		macro("worstBaselineHit", Number.isFinite(worstBaseline.hitPct) ? worstBaseline.hitPct.toFixed(0) : "n/a"),
		macro(
			"worstBaselineDesc",
			Number.isFinite(worstBaseline.hitPct)
				? `${worstBaseline.vendor} at ${Math.round(worstBaseline.sizeTokens / 1000)}k tokens after ${worstBaseline.idleSeconds}s`
				: "n/a",
		),
		macro("keepaliveMinHit", Number.isFinite(keepaliveMinHit.hitPct) ? keepaliveMinHit.hitPct.toFixed(0) : "n/a"),
		macro("bestSavingRatio", `\\ensuremath{${bestSavingRatio.toFixed(1)}\\times}`),
		macro("bestSavingDesc", bestSavingDesc || "n/a"),
		macro("bestNetSavingRatio", `\\ensuremath{${bestNetSavingRatio.toFixed(1)}\\times}`),
		macro("bestNetSavingDesc", bestNetSavingDesc || "n/a"),
	];
	writeFileSync(`${args.outdir}/macros.tex`, `${macros.join("\n")}\n`);

	// Summary table: warm-rate PROPORTIONS (fraction of samples with a cache hit),
	// the honest metric for bimodal warm/cold data, baseline vs keepalive.
	const disp: Record<string, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google", deepseek: "DeepSeek" };
	const fmtWarm = (a?: Agg) => (a ? `${a.warm}/${a.n}` : "--");
	const tableRows: string[] = [];
	for (const v of vendors) {
		for (const size of sizes) {
			for (const idle of idles.filter((i) => i > 0)) {
				const b = pick(size, idle, "baseline", v);
				const k = pick(size, idle, "keepalive", v);
				if (!b && !k) continue;
				tableRows.push(
					`${disp[v] ?? v} & ${Math.round(size / 1000)}k & ${idle} & ${fmtWarm(b)} & ${fmtWarm(k)} \\\\`,
				);
			}
		}
	}
	const table = [
		"\\begin{table}[t]",
		"\\centering\\footnotesize",
		"\\caption{Fraction of samples whose post-idle \\texttt{reqB} was warm (cache hit $\\geq 90\\%$), baseline vs.\\ keepalive. Only cells passing all measurement-integrity gates are counted; conditions were collected in separate time blocks.}",
		"\\label{tab:summary}",
		"\\begin{tabular}{llrrr}",
		"\\toprule",
		"Provider & Size & Idle & Warm$_{base}$ & Warm$_{ka}$ \\\\",
		"\\midrule",
		...tableRows,
		"\\bottomrule",
		"\\end{tabular}",
		"\\end{table}",
		"",
	].join("\n");
	writeFileSync(`${args.outdir}/summary-table.tex`, table);

	console.log(`wrote ${args.outdir}/{summary.csv,summary.json,macros.tex,hit-*.dat,ttft-*.dat,cost-*.dat}`);
	console.log(`aggregated ${aggs.length} cells from ${cells.length} observations (${dropped} invalid/gated dropped)`);
	console.log(`vendors=${vendors.join(",")} sizes=${sizes.join(",")} idles=${idles.join(",")}`);
}

main();

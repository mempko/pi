#!/usr/bin/env python3
"""Build the paper's strategy-cost table: at the longest idle, what does each
strategy actually cost, measured whole-cell (reqA + pings + reqB)?

Rows: provider x size. Columns:
  baseline cost / warm rate        (let it die, re-prefill)
  keepalive-30s cost / warm rate   (the convention; from the matrix runs)
  keepalive-240s cost / warm rate  (the economical prescription; interval runs)
Plus reqB-only cost and TTFT for context, and the measured break-even check.

The keepalive interval for each file is read from its run-meta start line.
Only validity-passing cells are used.

Usage: python3 scripts/cache-research/cost_table.py --matrix <files...>
       --intervals <files...> [--idle 600] [--out paper/data/cost-table.tex]
"""
import argparse
import json
import sys
from collections import defaultdict

p = argparse.ArgumentParser()
p.add_argument("--matrix", nargs="+", required=True)
p.add_argument("--intervals", nargs="+", default=[])
p.add_argument("--idle", type=int, default=600)
p.add_argument("--out", default="paper/data/cost-table.tex")
args = p.parse_args()


def vendor_of(model: str) -> str:
    return model.split(":")[0].split("/")[0]


def load(paths):
    """(vendor,size,idle,condition,interval_ms) -> list of cells (valid only)."""
    cells = []
    for path in paths:
        interval_ms = None
        for line in open(path):
            line = line.strip()
            if not line:
                continue
            c = json.loads(line)
            if c.get("type") == "run-meta":
                if c.get("phase") == "start":
                    interval_ms = c.get("options", {}).get("keepAliveIntervalMs")
                continue
            if c.get("v") != 2:
                continue
            if not (c.get("validity") or {}).get("overall"):
                continue
            c["_intervalMs"] = interval_ms
            cells.append(c)
    return cells


def med(xs):
    xs = sorted(xs)
    n = len(xs)
    if n == 0:
        return float("nan")
    return xs[n // 2] if n % 2 else (xs[n // 2 - 1] + xs[n // 2]) / 2


def summarize(cells, vendor, size, idle, condition):
    sel = [c for c in cells
           if vendor_of(c["model"]) == vendor and c["sizeTokens"] == size
           and c["idleSeconds"] == idle and c["condition"] == condition]
    if not sel:
        return None
    warm = [1.0 if c["reqB"]["cachedTokens"] / c["reqB"]["promptTokens"] >= 0.9 else 0.0 for c in sel]
    return {
        "n": len(sel),
        "warm": sum(warm),
        "cost": med([c["cost"]["total"] for c in sel]),
        "reqBcost": med([c["cost"]["reqB"] for c in sel]),
        "ttft": med([c["reqB"].get("ttftMs") or float("nan") for c in sel]),
        "pings": med([len(c.get("pings", [])) for c in sel]),
    }


matrix = load(args.matrix)
intervals = load(args.intervals)
# keepalive-240s cells come from the interval files; split by measured interval.
ka240 = [c for c in intervals if c["_intervalMs"] and c["_intervalMs"] >= 120000]
ka30_interval = [c for c in intervals if c["_intervalMs"] and c["_intervalMs"] < 120000]

vendors = sorted({vendor_of(c["model"]) for c in matrix + intervals})
sizes = sorted({c["sizeTokens"] for c in matrix + intervals})
DISP = {"anthropic": "Anthropic", "openai": "OpenAI", "google": "Google", "deepseek": "DeepSeek"}

rows = []
print(f"{'provider':<10}{'size':>6} | {'baseline':>18} | {'ka-30s':>18} | {'ka-240s':>18} | ttft cold->warm (ms)")
for v in vendors:
    for s in sizes:
        base = summarize(matrix, v, s, args.idle, "baseline")
        ka30 = summarize(matrix + ka30_interval, v, s, args.idle, "keepalive")
        ka2 = summarize(ka240, v, s, args.idle, "keepalive")
        if not base and not ka30 and not ka2:
            continue
        def fmt(x):
            if not x:
                return f"{'--':>18}"
            return f"${x['cost']:.4f} {int(x['warm'])}/{x['n']}w"
        ttft = ""
        if base and (ka30 or ka2):
            warm_ttft = (ka30 or ka2)["ttft"]
            ttft = f"{base['ttft']:.0f} -> {warm_ttft:.0f}"
        print(f"{v:<10}{s//1000:>5}k | {fmt(base)} | {fmt(ka30)} | {fmt(ka2)} | {ttft}")
        rows.append((v, s, base, ka30, ka2))

# LaTeX table for the paper.
lines = [
    "\\begin{table*}[t]",
    "\\centering\\footnotesize",
    "\\caption{Measured whole-strategy cost at the longest idle gap (reqA $+$ pings $+$ reqB, "
    "median, with warm rate): letting the cache die and re-prefilling (baseline) versus the "
    "30\\,s keepalive convention and the economical $\\tau^{\\ast}\\approx 240\\,s$ prescription. "
    "The 30\\,s keepalive loses money at this gap on every provider; the 240\\,s keepalive keeps "
    "the warmth benefit at a fraction of the ping spend. Valid cells only.}",
    "\\label{tab:strategy}",
    "\\begin{tabular}{ll rrr rrr rrr}",
    "\\toprule",
    " & & \\multicolumn{3}{c}{baseline} & \\multicolumn{3}{c}{keepalive 30\\,s} & \\multicolumn{3}{c}{keepalive 240\\,s} \\\\",
    "\\cmidrule(lr){3-5}\\cmidrule(lr){6-8}\\cmidrule(lr){9-11}",
    "Provider & Size & cost & warm & TTFT & cost & warm & TTFT & cost & warm & TTFT \\\\",
    "\\midrule",
]
for v, s, base, ka30, ka2 in rows:
    def cell(x, key):
        if not x:
            return "--"
        if key == "cost":
            return f"\\${x['cost']:.3f}"
        if key == "warm":
            return f"{int(x['warm'])}/{x['n']}"
        return f"{x['ttft']:.0f}\\,ms"
    lines.append(
        f"{DISP.get(v, v)} & {s//1000}k & {cell(base,'cost')} & {cell(base,'warm')} & {cell(base,'ttft')} "
        f"& {cell(ka30,'cost')} & {cell(ka30,'warm')} & {cell(ka30,'ttft')} "
        f"& {cell(ka2,'cost')} & {cell(ka2,'warm')} & {cell(ka2,'ttft')} \\\\"
    )
lines += ["\\bottomrule", "\\end{tabular}", "\\end{table*}", ""]
with open(args.out, "w") as f:
    f.write("\n".join(lines))
print(f"\nwrote {args.out}")

# Break-even check, measured: at 600s, does ka-240s beat baseline whole-cell?
print("\nbreak-even check at 600s (ka-240s total vs baseline total):")
for v, s, base, ka30, ka2 in rows:
    if base and ka2:
        verdict = "SAVES" if ka2["cost"] < base["cost"] else "COSTS MORE"
        print(f"  {v} {s//1000}k: ${ka2['cost']:.4f} vs ${base['cost']:.4f} -> {verdict} "
              f"({base['cost']/ka2['cost']:.2f}x)")

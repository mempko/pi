#!/usr/bin/env python3
"""Significance + replication analysis for v2 cache-research runs.

What changed vs v1 (which was invalidated by review):
  * Only cells passing the harness VALIDITY gates are analyzed (reqB executed on
    schedule: bounded local queue wait; true idle within tolerance of nominal;
    single serving backend across reqA/pings/reqB; keepalive schedule kept).
    Excluded cells are reported by reason -- no silent drops.
  * Conditions were time-blocked during collection, so keepalive traffic cannot
    contaminate same-run baseline cells (v1's interference defect).
  * The unit of independence is the RUN (replicates separated in time), not the
    sample: within-run observations share tier conditions and local scheduling,
    so they are NOT independent. We therefore report per-run Fisher exact tests
    and credit a claim only when it is Bonferroni-significant with a >=10pp
    effect in EVERY run. We do not pool runs into an inflated n.
  * The warm-reference gate (idle=0 immediate re-read must be warm) is checked
    per run; a run failing it has broken timing and its cells are still shown
    but flagged.

Usage: python3 scripts/cache-research/stats.py <run1.jsonl> [run2.jsonl ...]
       [--warm-threshold 90] [--json out.json]
"""
import json
import sys
from collections import defaultdict

import numpy as np
from scipy.stats import fisher_exact, mannwhitneyu

args = [a for a in sys.argv[1:]]
WARM = 90.0
MIN_EFFECT_PP = 10.0
json_out = None
paths = []
i = 0
while i < len(args):
    if args[i] == "--warm-threshold":
        WARM = float(args[i + 1]); i += 2
    elif args[i] == "--json":
        json_out = args[i + 1]; i += 2
    else:
        paths.append(args[i]); i += 1


def vendor_of(model: str) -> str:
    # "anthropic:claude-sonnet-4-5" -> anthropic ; "deepseek/deepseek-v3.2" -> deepseek
    return model.split(":")[0].split("/")[0]


# (vendor,size,idle,condition,runId) -> list of hit%
obs = defaultdict(list)
runs = {}  # runId -> {"gate_ok": bool|None, "file": str}
dropped = defaultdict(int)
timing = defaultdict(lambda: {"qwait": [], "slip": [], "maxgap": []})
skipped_v1 = 0

for path in paths:
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        c = json.loads(line)
        if c.get("type") == "run-meta":
            if c.get("phase") == "end":
                rid = c.get("runId", path)
                runs.setdefault(rid, {"gate_ok": None, "file": path})
                runs[rid]["gate_ok"] = bool(c.get("warmRefGateOk"))
            continue
        if c.get("v") != 2:
            skipped_v1 += 1
            continue
        rid = c.get("runId", path)
        runs.setdefault(rid, {"gate_ok": None, "file": path})
        v = c.get("validity") or {}
        if not v.get("overall"):
            for reason, ok in v.items():
                if reason != "overall" and not ok:
                    dropped[reason] += 1
            continue
        b = c.get("reqB")
        hit = 100.0 * b["cachedTokens"] / b["promptTokens"]
        key = (vendor_of(c["model"]), c["sizeTokens"], c["idleSeconds"], c["condition"], rid)
        obs[key].append(hit)
        t = timing[rid]
        t["qwait"].append(c.get("reqBQueueWaitMs", 0))
        t["slip"].append(c.get("trueIdleSeconds", c["idleSeconds"]) - c["idleSeconds"])
        if c.get("maxRefreshGapMs") is not None and c["condition"] == "keepalive":
            t["maxgap"].append(c["maxRefreshGapMs"])

run_ids = sorted(runs)
vendors = sorted({k[0] for k in obs})
sizes = sorted({k[1] for k in obs})
idles = sorted({k[2] for k in obs if k[2] > 0})

comparisons = [(v, s, i) for v in vendors for s in sizes for i in idles]
alpha = 0.05
bonf = alpha / max(1, len(comparisons))

print(f"runs: {len(run_ids)}   comparisons: {len(comparisons)}   warm threshold: hit>={WARM:.0f}%")
if skipped_v1:
    print(f"skipped {skipped_v1} v1-format lines (invalid methodology; analyze v2 runs only)")
if dropped:
    print(f"dropped invalid cells by gate: {dict(dropped)}")
print(f"alpha=0.05   Bonferroni alpha={bonf:.5f}")

print("\n=== timing fidelity per run (validity gates already applied) ===")
for rid in run_ids:
    t = timing.get(rid)
    gate = runs[rid]["gate_ok"]
    gate_s = {True: "PASS", False: "*** FAIL ***", None: "?"}[gate]
    if not t or not t["qwait"]:
        print(f"  {rid}: no valid cells   warm-ref gate: {gate_s}")
        continue
    gap = f" maxRefreshGap med={np.median(t['maxgap'])/1000:.1f}s p95={np.percentile(t['maxgap'],95)/1000:.1f}s" if t["maxgap"] else ""
    print(f"  {rid}: qWait med={np.median(t['qwait']):.0f}ms p95={np.percentile(t['qwait'],95):.0f}ms "
          f"idleSlip med={np.median(t['slip']):.1f}s p95={np.percentile(t['slip'],95):.1f}s{gap}  "
          f"warm-ref gate: {gate_s}")

print()
results = []
hdr = (f"{'vendor':<10}{'size':>5}{'idle':>5}{'run':>5}  {'base warm':>10} {'ka warm':>9} "
       f"{'dHit(pp)':>9} {'fisher p':>9} {'mw p':>8}  sig")
print(hdr)
print("-" * len(hdr))

for (v, s, idle) in comparisons:
    per_run = []
    for r_i, run in enumerate(run_ids, 1):
        base = obs.get((v, s, idle, "baseline", run), [])
        ka = obs.get((v, s, idle, "keepalive", run), [])
        if not base or not ka:
            continue
        bw, kw = sum(x >= WARM for x in base), sum(x >= WARM for x in ka)
        table = [[kw, len(ka) - kw], [bw, len(base) - bw]]
        try:
            _, p = fisher_exact(table)
        except ValueError:
            p = 1.0
        d_hit = float(np.mean(ka) - np.mean(base))
        try:
            _, p_mw = mannwhitneyu(ka, base, alternative="two-sided")
        except ValueError:
            p_mw = 1.0
        # Fisher is the primary test: the data is bimodal, and Mann-Whitney
        # separates perfectly on single-rank artifacts (e.g. one machine-scatter
        # miss in 8), manufacturing tiny p on non-findings. MW is reported as a
        # descriptive secondary column only. NOTE the samples within a run are
        # correlated (shared tier moment); per-run tests are descriptive and the
        # replication bar below is the claim.
        best_p = p
        practical = abs(d_hit) >= MIN_EFFECT_PP
        if best_p < bonf and practical:
            sig = "** bonf"
        elif best_p < alpha and practical:
            sig = "*  unc"
        elif best_p < alpha:
            sig = "ns(trivial)"
        else:
            sig = "ns"
        print(f"{v:<10}{s//1000:>4}k{idle:>5}{r_i:>5}  {bw:>4}/{len(base):<5} {kw:>4}/{len(ka):<4} "
              f"{d_hit:>9.1f} {p:>9.5f} {p_mw:>8.5f}  {sig}")
        per_run.append({"run": run, "base_warm": bw, "base_n": len(base), "ka_warm": kw,
                        "ka_n": len(ka), "delta_hit_pp": d_hit, "fisher_p": p, "mw_p": float(p_mw)})
    if per_run:
        n_bonf = sum(
            1
            for r in per_run
            if r["fisher_p"] < bonf and abs(r["delta_hit_pp"]) >= MIN_EFFECT_PP
        )
        replicated = all(
            r["fisher_p"] < bonf and r["delta_hit_pp"] >= MIN_EFFECT_PP
            for r in per_run
        )
        results.append({"vendor": v, "size": s, "idle": idle, "runs": per_run,
                        "n_runs_bonf": n_bonf, "replicated_all_runs": replicated})
        print(f"{'':>25}-> significant in {n_bonf}/{len(per_run)} runs; "
              f"replicated(all runs, >10pp): {replicated}\n")

print("\n=== summary ===")
full = [r for r in results if r["replicated_all_runs"]]
print(f"comparisons replicating in ALL runs with Bonferroni significance and >10pp effect: "
      f"{len(full)}/{len(results)}")
for r in full:
    print(f"  {r['vendor']} {r['size']//1000}k idle={r['idle']}s")

if json_out:
    with open(json_out, "w") as f:
        json.dump({"warm_threshold": WARM, "alpha": alpha, "bonferroni": bonf,
                   "runs": run_ids, "results": results,
                   "dropped_invalid": dict(dropped)}, f, indent=2)
    print(f"\nwrote {json_out}")

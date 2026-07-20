#!/usr/bin/env python3
"""DEPRECATED (2026-07-17): this built the retracted v1 "load-dependent eviction"
figure. The v1 data it consumes was invalidated by review: the harness's own
semaphore queue delayed probes past the TTL (idle=0 warm 0/72 for Anthropic --
the tell), so "eviction earlier under load" was a queueing artifact, not a cache
property. Do not regenerate this figure from v1 data.

The honest version of the experiment is the pressure-arm design in
run-pressure.sh: fixed probe schedule + an independent junk-prefix pressure
injector, arms alternated in time. Analyze that v2 data with stats.py instead.

Historical docstring: build the load-dependence figure: Anthropic 40k cache-hit
warm-rate vs idle, at low concurrency (controls, conc=1) vs high concurrency
(replicates, conc=8). Emits paper/data/loaddep.dat and blog/img/loaddep.png.
"""
import glob
import json
import os
from collections import defaultdict

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

WARM = 90.0


def warmrate(files, cond):
    """idle -> (warm, n) for anthropic 40k, given condition, over files."""
    d = defaultdict(lambda: [0, 0])
    for f in files:
        for line in open(f):
            c = json.loads(line)
            b = c.get("reqB"); a = c.get("reqA")
            if not b or b.get("error") or not b.get("promptTokens"):
                continue
            if a and a.get("provider") and b.get("provider") and a["provider"] != b["provider"]:
                continue
            if not c["model"].startswith("anthropic") or c["sizeTokens"] != 40000 or c["condition"] != cond:
                continue
            hit = 100.0 * b["cachedTokens"] / b["promptTokens"]
            d[c["idleSeconds"]][0] += hit >= WARM
            d[c["idleSeconds"]][1] += 1
    return {k: 100.0 * v[0] / v[1] for k, v in d.items() if v[1] > 0}


low_files = glob.glob("scripts/cache-research/data/controlA-lowload-*.jsonl") + \
            glob.glob("scripts/cache-research/data/controlA2-lowload60-*.jsonl")
high_files = glob.glob("scripts/cache-research/data/rep*.jsonl")

series = {
    "low_baseline": warmrate(low_files, "baseline"),
    "low_keepalive": warmrate(low_files, "keepalive"),
    "high_baseline": warmrate(high_files, "baseline"),
    "high_keepalive": warmrate(high_files, "keepalive"),
}
idles = sorted({k for s in series.values() for k in s})

os.makedirs("paper/data", exist_ok=True)
cols = ["low_baseline", "low_keepalive", "high_baseline", "high_keepalive"]
with open("paper/data/loaddep.dat", "w") as f:
    f.write("idle " + " ".join(cols) + "\n")
    for idle in idles:
        row = [str(idle)] + [f"{series[c][idle]:.1f}" if idle in series[c] else "nan" for c in cols]
        f.write(" ".join(row) + "\n")

os.makedirs("blog/img", exist_ok=True)
fig, ax = plt.subplots(figsize=(6.4, 4.0), dpi=160)
styles = {
    "low_baseline": ("#c65d2a", "--", "o", "Low load (conc=1) baseline"),
    "high_baseline": ("#7a1f1f", "--", "s", "High load (conc=8) baseline"),
    "low_keepalive": ("#108c6e", "-", "o", "Low load keepalive"),
    "high_keepalive": ("#0b5c49", "-", "s", "High load keepalive"),
}
for key, (color, ls, mk, label) in styles.items():
    xs = [i for i in idles if i in series[key]]
    ys = [series[key][i] for i in xs]
    if xs:
        ax.plot(xs, ys, color=color, ls=ls, marker=mk, ms=6, lw=2.0, label=label)
ax.axvspan(120, 180, color="gray", alpha=0.10)
ax.set_xlabel("Idle time (s)")
ax.set_ylabel("Cache hit rate (% of samples warm)")
ax.set_title("Anthropic 40k: eviction point slides earlier under load")
ax.set_ylim(-4, 106)
ax.grid(True, ls=":", alpha=0.4)
ax.legend(fontsize=8, loc="center right", frameon=False)
fig.tight_layout()
fig.savefig("blog/img/loaddep.png", bbox_inches="tight")
print("wrote paper/data/loaddep.dat and blog/img/loaddep.png")
for idle in idles:
    print(f"  idle={idle:>3}s  " + "  ".join(
        f"{c}={series[c].get(idle,'-')}" for c in cols))

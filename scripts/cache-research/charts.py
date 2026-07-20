#!/usr/bin/env python3
"""Render blog charts (PNG) from the pgfplots .dat tables analyze.ts produced.

Reads paper/data/{hit,ttft,cost}-<size>.dat and writes blog/img/<metric>-<size>.png.
Uses the same data the LaTeX paper plots, so the blog and paper agree exactly.
"""
import os
import sys
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

DATA_DIR = sys.argv[1] if len(sys.argv) > 1 else "paper/data"
OUT_DIR = sys.argv[2] if len(sys.argv) > 2 else "blog/img"
os.makedirs(OUT_DIR, exist_ok=True)

COLORS = {"anthropic": "#c65d2a", "openai": "#108c6e", "google": "#3a78d8", "deepseek": "#9650be"}
VLABEL = {"anthropic": "Anthropic", "openai": "OpenAI", "google": "Google", "deepseek": "DeepSeek"}
MARK = {"anthropic": "o", "openai": "^", "google": "s", "deepseek": "D"}
FALLBACK_COLORS = ["#777777", "#c8960a", "#0a9c8b", "#b0457a"]
FALLBACK_MARKS = ["p", "X", "v", "P"]


def style(vend, idx):
    return (
        COLORS.get(vend, FALLBACK_COLORS[idx % len(FALLBACK_COLORS)]),
        MARK.get(vend, FALLBACK_MARKS[idx % len(FALLBACK_MARKS)]),
        VLABEL.get(vend, vend.capitalize()),
    )
METRIC_LABEL = {
    "hit": "Cache hit (%)",
    "ttft": "Time to first token (ms)",
    "cost": "reqB cost (USD)",
}


def read_dat(path):
    with open(path) as f:
        header = f.readline().split()
        rows = [line.split() for line in f if line.strip()]
    cols = {h: [] for h in header}
    for r in rows:
        for h, v in zip(header, r):
            cols[h].append(float("nan") if v == "nan" else float(v))
    return {h: np.array(v) for h, v in cols.items()}


def plot(metric, size):
    path = os.path.join(DATA_DIR, f"{metric}-{size}.dat")
    if not os.path.exists(path):
        return None
    d = read_dat(path)
    idle = d["idle"]
    vendors = sorted(k[:-len("_baseline")] for k in d if k.endswith("_baseline"))
    fig, ax = plt.subplots(figsize=(6.2, 4.0), dpi=160)
    for idx, vend in enumerate(vendors):
        color, mark, label = style(vend, idx)
        base, ka = f"{vend}_baseline", f"{vend}_keepalive"
        if base in d:
            ax.plot(idle, d[base], color=color, ls="--", marker=mark,
                    ms=5, lw=1.6, alpha=0.85, label=f"{label} baseline")
        if ka in d:
            ax.plot(idle, d[ka], color=color, ls="-", marker=mark,
                    ms=6, lw=2.2, label=f"{label} keepalive")
    ax.set_xlabel("Idle time (s)")
    ax.set_ylabel(METRIC_LABEL.get(metric, metric))
    ax.set_title(f"{METRIC_LABEL.get(metric, metric)} — {int(size)//1000}k-token prefix")
    if metric == "hit":
        ax.set_ylim(-4, 106)
    if metric == "cost":
        ax.set_yscale("log")
    ax.grid(True, which="both", ls=":", alpha=0.4)
    ax.legend(fontsize=7, ncol=3, loc="lower center", bbox_to_anchor=(0.5, -0.32), frameon=False)
    fig.tight_layout()
    out = os.path.join(OUT_DIR, f"{metric}-{size}.png")
    fig.savefig(out, bbox_inches="tight")
    plt.close(fig)
    return out


def main():
    sizes = set()
    for name in os.listdir(DATA_DIR):
        if name.startswith("hit-") and name.endswith(".dat"):
            sizes.add(name[len("hit-"):-len(".dat")])
    written = []
    for metric in ("hit", "cost", "ttft"):
        for size in sorted(sizes):
            out = plot(metric, size)
            if out:
                written.append(out)
    print("wrote:", *written, sep="\n  ")


if __name__ == "__main__":
    main()

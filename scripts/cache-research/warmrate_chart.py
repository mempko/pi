#!/usr/bin/env python3
"""Render the per-provider warm-rate small multiples (matching paper Figure 1)
as a single PNG for the blog/socials.

Reads paper/data/warm-<size>.dat (written by analyze.ts) and writes
blog/img/warmrate-<size>.png.
"""
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

SIZE = sys.argv[1] if len(sys.argv) > 1 else "100000"
VENDORS = [("anthropic", "Anthropic", "#c65d2a"), ("deepseek", "DeepSeek", "#9650be"),
           ("openai", "OpenAI", "#108c6e"), ("google", "Google", "#3a78d8")]

idles = []
series = {}
with open(f"paper/data/warm-{SIZE}.dat") as f:
    header = f.readline().split()
    for line in f:
        parts = line.split()
        idles.append(int(parts[0]))
        for name, val in zip(header[1:], parts[1:]):
            series[name] = series.get(name, []) + [float(val) if val != "nan" else None]

fig, axes = plt.subplots(2, 2, figsize=(7.6, 5.2), dpi=160, sharex=True, sharey=True)
for ax, (v, label, color) in zip(axes.flat, VENDORS):
    base = series[f"{v}_baseline"]
    ka = series[f"{v}_keepalive"]
    ax.plot(idles, base, color=color, ls="--", marker="o", ms=4, lw=1.6, label="baseline")
    ax.plot(idles, ka, color=color, ls="-", marker="s", ms=4, lw=2.0, label="keepalive")
    ax.set_title(label, fontsize=10)
    ax.set_ylim(-4, 106)
    ax.set_yticks([0, 50, 100])
    ax.tick_params(labelsize=8)
    ax.grid(True, ls=":", alpha=0.4)
for ax in axes[1, :]:
    ax.set_xlabel("Idle (s)", fontsize=9)
for ax in axes[:, 0]:
    ax.set_ylabel("Samples warm (%)", fontsize=9)
axes[1, 1].legend(fontsize=8, frameon=False, loc="lower left")
fig.suptitle(f"Prompt-cache warm rate vs. idle gap ({int(SIZE)//1000}k prefix)", fontsize=11)
fig.tight_layout()
import os
os.makedirs("blog/img", exist_ok=True)
fig.savefig(f"blog/img/warmrate-{SIZE}.png", bbox_inches="tight")
print(f"wrote blog/img/warmrate-{SIZE}.png")

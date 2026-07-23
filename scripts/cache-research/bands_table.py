#!/usr/bin/env python3
"""Build the paying-bands table (paper Table: keepalive at a 30-minute pause).

Compact single-column layout: warm + cost per arm, saving ratio. TTFT lives in
the prose. Marginal accounting: the pause decision only (cold reqB vs.
pings + warm reqB); the sunk reqA is excluded from both arms.

Usage: python3 scripts/cache-research/bands_table.py [--idle 1800]
       [--out paper/data/bands-table.tex]
"""
import argparse
import glob
import json
import statistics as st

p = argparse.ArgumentParser()
p.add_argument("--idle", type=int, default=1800)
p.add_argument("--files", nargs="+", default=None)
p.add_argument("--out", default="paper/data/bands-table.tex")
args = p.parse_args()

files = args.files or sorted(glob.glob("scripts/cache-research/data/v2band-*.jsonl"))


def vend(m):
    return m.split(":")[0].split("/")[0]


data = {}
for f in files:
    for line in open(f):
        c = json.loads(line)
        if c.get("v") != 2 or c.get("type") or not (c.get("validity") or {}).get("overall"):
            continue
        if c["idleSeconds"] != args.idle:
            continue
        data.setdefault((vend(c["model"]), c["condition"]), []).append(c)

DISP = {"anthropic": "Anthropic", "openai": "OpenAI", "deepseek": "DeepSeek", "google": "Google"}
rows = []
for v in ["anthropic", "openai", "deepseek", "google"]:
    b = data.get((v, "baseline"))
    k = data.get((v, "keepalive"))
    if not b or not k:
        continue
    bc = st.median([x["cost"]["reqB"] for x in b])
    kc = st.median([x["cost"]["pings"] + x["cost"]["reqB"] for x in k])
    bw = f"{sum(x['reqB']['cachedTokens']/x['reqB']['promptTokens'] >= 0.9 for x in b)}/{len(b)}"
    kw = f"{sum(x['reqB']['cachedTokens']/x['reqB']['promptTokens'] >= 0.9 for x in k)}/{len(k)}"
    rows.append(
        f"{DISP[v]} & {bw} & \\${bc:.3f} & {kw} & \\${kc:.3f} & {bc/kc:.2f}$\\times$ \\\\"
    )

mins = args.idle // 60
table = (
    r"""\begin{table}[t]
\centering\footnotesize
\caption{The same $\tau^{\ast}{=}240$\,s keepalive as Table~\ref{tab:strategy},
now at a \textbf{"""
    + f"{mins}-minute"
    + r"""} pause (idle $"""
    + f"{args.idle}"
    + r"""$\,s, 100k prefix), where every evicting provider's baseline is fully
cold. Marginal accounting: the pause decision only (cold \texttt{reqB} vs.\
pings${}+{}$warm \texttt{reqB}); the sunk \texttt{reqA} is excluded. What lost
money at 10 minutes on OpenAI (still warm, nothing to insure) wins here:
inside its band the keepalive saves on Anthropic \emph{and} OpenAI, while
DeepSeek's re-prefill stays too cheap to insure at any gap.}
\label{tab:bands}
\begin{tabular}{lrrrrr}
\toprule
 & \multicolumn{2}{c}{let die} & \multicolumn{2}{c}{keepalive} & saving \\
\cmidrule(lr){2-3}\cmidrule(lr){4-5}
Provider & warm & cost & warm & cost & (marginal) \\
\midrule
"""
    + "\n".join(rows)
    + r"""
\bottomrule
\end{tabular}
\end{table}
"""
)
open(args.out, "w").write(table)
print(f"wrote {args.out} ({len(rows)} providers at idle={args.idle}s)")

"""Plot retained synthetic action comparisons; no model calls or live data."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

parser = argparse.ArgumentParser()
parser.add_argument('results', type=Path)
parser.add_argument('--output', type=Path, default=Path('docs/figures/operational-replay.png'))
args = parser.parse_args()
data = json.loads(args.results.read_text())
rows = [r for r in data['rows'] if r['mode'] == 'deterministic' and r['comparison']['status'] == 'ready']
labels = {'ordinary': 'Even service', 'disruption': 'Uneven spacing', 'loaded-bus': 'High onboard load'}
colors = ['#687884', '#b3bd50', '#56681a']
fig, axes = plt.subplots(1, 2, figsize=(10, 4), layout='constrained')
for j, name in enumerate(['No additional hold', 'Target-headway baseline', 'Passenger-time comparison']):
    x = [i + (j - 1) * .24 for i in range(len(rows))]
    for ax, field in zip(axes, ['holdSeconds', 'changePassengerMinutes']):
        values = [r['comparison']['candidates'][j][field] for r in rows]
        ax.bar(x, values, width=.22, color=colors[j], label=name)
for ax in axes:
    ax.set_xticks(range(len(rows)), [labels[r['caseId']] for r in rows], fontsize=9)
    ax.spines[['top', 'right']].set_visible(False)
    ax.grid(axis='y', alpha=.15); ax.set_axisbelow(True)
axes[0].set_ylabel('Additional hold (seconds)')
axes[1].set_ylabel('Change in modeled passenger-minutes')
axes[1].axhline(0, color='#687884', linewidth=.8)
axes[0].set_title('What would staff authorize?', loc='left', fontsize=11)
axes[1].set_title('Does the hold help in this model?', loc='left', fontsize=11)
axes[0].legend(loc='upper left', fontsize=7, frameon=False)
fig.suptitle('Synthetic decision replay · no observed service impact', fontsize=13, x=.05, ha='left')
args.output.parent.mkdir(parents=True, exist_ok=True)
fig.savefig(args.output, dpi=180, facecolor='white')

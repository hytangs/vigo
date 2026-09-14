#!/usr/bin/env python3
"""Render the saved LAMP evaluation. No new fitting, fetching or filtering."""
import argparse
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('study')
parser.add_argument('output')
args = parser.parse_args()
study = json.loads(Path(args.study).read_text())
background, foreground, muted = '#0d1419', '#eef2f4', '#a6b0b8'
green, gray = '#b0c43b', '#647682'
plt.rcParams.update({'font.family':'DejaVu Sans','font.size':11,'text.color':foreground,'axes.labelcolor':muted,'xtick.color':muted,'ytick.color':foreground,'axes.edgecolor':gray,'axes.facecolor':background,'figure.facecolor':background})
fig, (left, right) = plt.subplots(1,2,figsize=(13.5,6.5),gridspec_kw={'width_ratios':[1.2,1]})
routes=study['routes']; y=np.arange(len(routes))
left.barh(y-.17,[r['scheduled']['maeSeconds'] for r in routes],height=.28,color=gray,label='Timetable')
left.barh(y+.17,[r['historical']['maeSeconds'] for r in routes],height=.28,color=green,label='Historical predictor')
left.set_yticks(y,[r['routeId'].replace('Green-','Green ') for r in routes]); left.invert_yaxis()
left.set_title('Average error by route',loc='left',pad=18); left.set_xlabel('Mean absolute error · seconds')
days=study['days']; x=np.arange(len(days))
right.bar(x-.18,[r['scheduled']['maeSeconds'] for r in days],width=.3,color=gray)
right.bar(x+.18,[r['historical']['maeSeconds'] for r in days],width=.3,color=green)
right.set_xticks(x,[f"{d['serviceDate'][4:6]}/{d['serviceDate'][6:]}" for d in days]); right.set_ylabel('Mean absolute error · seconds'); right.set_title('Later dates, held out of training',loc='left',pad=18)
for ax in (left,right):
    ax.spines[['top','right']].set_visible(False)
    ax.grid(axis='x' if ax is left else 'y',alpha=.13); ax.set_axisbelow(True)
fig.suptitle('Running time: history versus timetable',x=.07,ha='left',fontsize=23,fontweight='bold')
range_=study['range']; comparison=study['comparison']
fig.text(.07,.88,f"Training {range_['start']}–{range_['trainEnd']}  ·  Test through {range_['end']}  ·  {comparison['scoredTestSegments']:,} matched segments",color=muted)
fig.legend(*left.get_legend_handles_labels(),loc='lower left',bbox_to_anchor=(.06,.085),frameon=False,ncol=2)
fig.text(.07,.055,'MBTA LAMP reconstructed events + applicable archived GTFS. Retrospective evaluation; segments within trips are dependent.',fontsize=9,color=muted)
missing = sorted(set(study.get('filters',{}).get('inputRowsByRoute',{})) - {route['routeId'] for route in routes})
note = f"No eligible held-out comparisons: {', '.join(missing)}. " if missing else ''
fig.text(.07,.025,note + 'This is not a live arrival or departure-delay validation.',fontsize=9,color=muted)
fig.subplots_adjust(left=.12,right=.96,top=.78,bottom=.24,wspace=.38)
output=Path(args.output); output.parent.mkdir(parents=True,exist_ok=True)
fig.savefig(output,dpi=160,facecolor=background)

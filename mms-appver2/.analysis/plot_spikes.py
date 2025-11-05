"""
plot_spikes.py

Reads a spike events JSON (export) and creates:
 - histogram of spike maxMag
 - timeline scatter: spike time vs nearest rapid_notification recentCount
 - waveform thumbnails (raw1s/raw2s) for representative spikes

Saves PNGs and an index.html into .analysis/plots/

Usage:
 python ./.analysis/plot_spikes.py <path-to-spike-json> <out-dir>

If <out-dir> omitted, defaults to ./mms-appver2/.analysis/plots/
"""
import sys
import os
import json
import math
from statistics import median

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    import numpy as np
except Exception as e:
    print("Missing plotting dependencies. Install with: pip install matplotlib numpy")
    raise


def load_json(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def find_nearest_recent_count(spike_time, rapid_list):
    # rapid_list is sorted by time
    if not rapid_list:
        return None
    # Binary search by time
    import bisect
    times = [r['time'] for r in rapid_list]
    i = bisect.bisect_left(times, spike_time)
    cand = []
    if i < len(times):
        cand.append((abs(times[i]-spike_time), rapid_list[i]))
    if i > 0:
        cand.append((abs(times[i-1]-spike_time), rapid_list[i-1]))
    if not cand:
        return None
    cand.sort(key=lambda x: x[0])
    return cand[0][1].get('recentCount')


def main():
    if len(sys.argv) < 2:
        print("Usage: python plot_spikes.py <spike_json_path> [out_dir]")
        sys.exit(1)
    spike_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) >= 3 else os.path.join(os.path.dirname(__file__), 'plots')
    os.makedirs(out_dir, exist_ok=True)

    data = load_json(spike_path)
    spikes = [e for e in data if e.get('type') == 'spike']
    rapid = [e for e in data if e.get('type') == 'rapid_notifications']
    # sort rapid
    rapid.sort(key=lambda r: r['time'])

    if not spikes:
        print('No spike events found in JSON.')
        return

    maxmags = [s.get('maxMag', 0) for s in spikes]
    times = [s['time'] for s in spikes]
    # assign recentCount per spike
    recent_counts = [find_nearest_recent_count(t, rapid) for t in times]

    # --- Histogram of maxMag ---
    fig, ax = plt.subplots(figsize=(6,4))
    ax.hist(maxmags, bins='auto', color='#2b8cbe', edgecolor='black')
    ax.set_title('Histogram of spike maxMag')
    ax.set_xlabel('maxMag')
    ax.set_ylabel('count')
    plt.tight_layout()
    hist_path = os.path.join(out_dir, 'maxmag_hist.png')
    fig.savefig(hist_path, dpi=150)
    plt.close(fig)

    # --- Timeline scatter (time vs recentCount) ---
    fig, ax = plt.subplots(figsize=(10,3))
    xs = times
    ys = [rc if rc is not None else 0 for rc in recent_counts]
    sc = ax.scatter(xs, ys, c=ys, cmap='viridis', s=30)
    ax.set_title('Spike time vs nearest rapid_notifications.recentCount')
    ax.set_xlabel('time (s)')
    ax.set_ylabel('recentCount')
    plt.colorbar(sc, ax=ax, label='recentCount')
    plt.tight_layout()
    timeline_path = os.path.join(out_dir, 'timeline_scatter.png')
    fig.savefig(timeline_path, dpi=150)
    plt.close(fig)

    # --- Waveform thumbnails ---
    # pick largest, median, and a duplicated example if present
    spikes_sorted = sorted(spikes, key=lambda s: s.get('maxMag',0))
    largest = spikes_sorted[-1]
    med = spikes_sorted[len(spikes_sorted)//2]

    # find duplicate groups by raw arrays (raw1s+raw2s tuple)
    def raw_key(s):
        r1 = tuple(s.get('raw1s') or [])
        r2 = tuple(s.get('raw2s') or [])
        return (r1, r2)

    from collections import defaultdict
    groups = defaultdict(list)
    for s in spikes:
        groups[raw_key(s)].append(s)
    dup_example = None
    for k,g in groups.items():
        if len(g) > 1:
            dup_example = g[0]
            break
    if dup_example is None:
        # fallback: choose one near median
        dup_example = spikes_sorted[max(0, len(spikes_sorted)//2 - 1)]

    examples = [('largest', largest), ('median', med), ('duplicate', dup_example)]
    waveform_files = []
    for tag, s in examples:
        r1 = s.get('raw1s') or []
        r2 = s.get('raw2s') or []
        # plot samples
        fig, ax = plt.subplots(figsize=(4,2.5))
        x = list(range(len(r1)))
        if r1:
            ax.plot(x, r1, '-o', label='raw1', color='#e41a1c')
        if r2:
            ax.plot(x, r2, '-s', label='raw2', color='#377eb8')
        ax.set_title(f"{tag} spike: time={s.get('time')}, maxMag={s.get('maxMag')}")
        ax.set_xlabel('sample index')
        ax.set_ylabel('raw ADC')
        ax.grid(alpha=0.2)
        ax.legend(fontsize='small')
        plt.tight_layout()
        fname = os.path.join(out_dir, f'waveform_{tag}.png')
        fig.savefig(fname, dpi=150)
        plt.close(fig)
        waveform_files.append((tag, fname))

    # Also create a small gallery of all spike thumbnails (first 20)
    gallery_files = []
    max_thumb = 20
    sample_ids = spikes[:max_thumb]
    thumbs = []
    for idx, s in enumerate(sample_ids):
        fig, ax = plt.subplots(figsize=(2.2,1.2))
        r1 = s.get('raw1s') or []
        r2 = s.get('raw2s') or []
        x = list(range(max(len(r1), len(r2))))
        if r1:
            ax.plot(x[:len(r1)], r1, '-', color='#e41a1c', linewidth=1)
        if r2:
            ax.plot(x[:len(r2)], r2, '-', color='#377eb8', linewidth=1)
        ax.set_xticks([])
        ax.set_yticks([])
        ax.set_title(f"{s.get('maxMag')}", fontsize=6)
        plt.tight_layout()
        fname = os.path.join(out_dir, f'thumb_{idx}.png')
        fig.savefig(fname, dpi=120)
        plt.close(fig)
        thumbs.append(fname)

    # create index.html
    index_path = os.path.join(out_dir, 'index.html')
    with open(index_path, 'w', encoding='utf-8') as f:
        f.write('<html><head><meta charset="utf-8"><title>Spike Visualizations</title></head><body>')
        f.write('<h2>Spike Visualizations</h2>')
        f.write(f'<p>Total spike events: {len(spikes)}. MaxMag median: {median(maxmags):.1f}, max: {max(maxmags):.0f}</p>')
        f.write('<h3>Histogram: maxMag</h3>')
        f.write(f'<img src="{os.path.basename(hist_path)}" style="max-width:100%">')
        f.write('<h3>Timeline: spike time vs recentCount</h3>')
        f.write(f'<img src="{os.path.basename(timeline_path)}" style="max-width:100%">')
        f.write('<h3>Representative waveforms</h3>')
        for tag,fname in waveform_files:
            f.write(f'<div style="display:inline-block;margin:8px;text-align:center;"><img src="{os.path.basename(fname)}"/><div>{tag}</div></div>')
        f.write('<h3>Thumbnails (first 20 spikes)</h3>')
        f.write('<div style="display:flex;flex-wrap:wrap">')
        for t in thumbs:
            f.write(f'<div style="margin:4px"><img src="{os.path.basename(t)}" width="120"/></div>')
        f.write('</div>')
        f.write('<hr><p>Generated by plot_spikes.py</p>')
        f.write('</body></html>')

    print('Plots and index written to', out_dir)

if __name__ == '__main__':
    main()

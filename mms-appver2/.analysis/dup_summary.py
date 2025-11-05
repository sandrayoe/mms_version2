"""
dup_summary.py

Groups spike events by their raw payload (raw1s + raw2s), writes a CSV with counts and example times, and
saves a bar chart of the top duplicate groups to .analysis/plots/duplicate_groups.png

Usage:
 python ./.analysis/dup_summary.py <spike_json> [out_dir]
"""
import sys, os, json, csv
from collections import defaultdict

try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
except Exception:
    print('matplotlib not available; please install matplotlib')
    raise


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def canonical_key(s):
    # raw1s and raw2s arrays (order matters). Use tuple string to be safe.
    r1 = s.get('raw1s') or []
    r2 = s.get('raw2s') or []
    return (tuple(r1), tuple(r2))


def main():
    if len(sys.argv) < 2:
        print('Usage: python dup_summary.py <spike_json> [out_dir]')
        sys.exit(1)
    spike_path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'plots')
    os.makedirs(out_dir, exist_ok=True)

    data = load(spike_path)
    spikes = [e for e in data if e.get('type') == 'spike']
    if not spikes:
        print('No spike events found!')
        return

    groups = defaultdict(list)
    for s in spikes:
        key = canonical_key(s)
        groups[key].append(s)

    # Prepare CSV
    csv_path = os.path.join(out_dir, 'duplicate_groups.csv')
    with open(csv_path, 'w', newline='', encoding='utf-8') as cf:
        w = csv.writer(cf)
        w.writerow(['group_id','count','example_time','sampleCount','maxMag','times_sample(<=10)','raw1s_example','raw2s_example'])
        gid = 0
        rows = []
        for k,v in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            gid += 1
            count = len(v)
            ex = v[0]
            times = [str(int(round(x))) for x in [s['time'] for s in v]]
            times_sample = ','.join(times[:10])
            rows.append((gid, count, ex.get('time'), ex.get('sampleCount'), ex.get('maxMag'), times_sample, list(k[0]), list(k[1])))
            w.writerow([gid, count, ex.get('time'), ex.get('sampleCount'), ex.get('maxMag'), times_sample, json.dumps(list(k[0])), json.dumps(list(k[1]))])

    # Print concise summary
    total_groups = len(groups)
    total_spikes = len(spikes)
    duplicate_groups = sum(1 for g in groups.values() if len(g) > 1)
    duplicates_count = sum(len(g) for g in groups.values() if len(g) > 1)

    print(f'Total spikes: {total_spikes}')
    print(f'Total unique payload groups: {total_groups}')
    print(f'Groups with duplicates (>1): {duplicate_groups}  (total duplicate events: {duplicates_count})')
    if duplicate_groups:
        print('Top duplicate groups (group_id,count,example_time,maxMag):')
        for gid, count, etime, sc, mg, *_ in rows[:10]:
            print(f'  {gid}: {count}  time={etime}  maxMag={mg}  sampleCount={sc}')

    # Bar chart of top groups
    topN = min(12, len(rows))
    if topN == 0:
        print('No duplicate groups to plot')
        return
    top = rows[:topN]
    labels = [f'G{r[0]}\n{r[1]}' for r in top]
    counts = [r[1] for r in top]
    fig, ax = plt.subplots(figsize=(max(6, topN),4))
    bars = ax.bar(range(len(counts)), counts, color='tab:orange')
    ax.set_xticks(range(len(counts)))
    ax.set_xticklabels(labels, rotation=45, ha='right')
    ax.set_ylabel('count')
    ax.set_title('Top duplicate raw payload groups (group_id\ncount)')
    for i, b in enumerate(bars):
        ax.text(b.get_x() + b.get_width()/2, b.get_height()+0.1, str(counts[i]), ha='center', va='bottom')
    plt.tight_layout()
    png_path = os.path.join(out_dir, 'duplicate_groups.png')
    fig.savefig(png_path, dpi=150)
    plt.close(fig)

    print('\nWrote:')
    print('  ', csv_path)
    print('  ', png_path)

if __name__ == '__main__':
    main()

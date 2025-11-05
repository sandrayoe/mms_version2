"""
sudden_increase.py

Compute per-spike sudden sample-to-sample deltas and correlate with rapid_notifications.
Outputs a CSV and prints a short summary.

Usage:
 python sudden_increase.py <spike_json> [out_dir]
"""
import sys, os, json, csv
from bisect import bisect_left


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def nearest_recent_count(t, rapid):
    if not rapid:
        return None
    times = [r['time'] for r in rapid]
    i = bisect_left(times, t)
    cand = []
    if i < len(times): cand.append((abs(times[i]-t), rapid[i]))
    if i > 0: cand.append((abs(times[i-1]-t), rapid[i-1]))
    if not cand: return None
    cand.sort(key=lambda x: x[0])
    return cand[0][1].get('recentCount')


def max_adj_diff(arr):
    if not arr or len(arr) < 2: return 0
    m = 0
    for i in range(1, len(arr)):
        d = abs(arr[i] - arr[i-1])
        if d > m: m = d
    return m

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python sudden_increase.py <spike_json> [out_dir]')
        sys.exit(1)
    path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'plots')
    os.makedirs(out_dir, exist_ok=True)

    data = load(path)
    spikes = [e for e in data if e.get('type') == 'spike']
    rapid = sorted([e for e in data if e.get('type') == 'rapid_notifications'], key=lambda r: r['time'])

    out_csv = os.path.join(out_dir, 'sudden_increase_summary.csv')
    with open(out_csv, 'w', newline='', encoding='utf-8') as cf:
        w = csv.writer(cf)
        w.writerow(['time','maxMag','sampleCount','perSampleInterval_ms','maxDelta1','maxDelta2','nearestRecentCount','deduped'])
        for s in spikes:
            t = s.get('time')
            maxMag = s.get('maxMag')
            sc = s.get('sampleCount')
            psi = s.get('perSampleInterval')
            r1 = s.get('raw1s') or []
            r2 = s.get('raw2s') or []
            d1 = max_adj_diff(r1)
            d2 = max_adj_diff(r2)
            rc = nearest_recent_count(t, rapid)
            ded = s.get('deduped', False)
            w.writerow([t, maxMag, sc, psi, d1, d2, rc, ded])

    # summarize
    rows = []
    import csv as _csv
    with open(out_csv, 'r', encoding='utf-8') as f:
        rdr = _csv.DictReader(f)
        for r in rdr:
            rows.append(r)

    n = len(rows)
    # thresholds
    th1 = 500
    th2 = 1000
    cnt_th1 = sum(1 for r in rows if int(r['maxDelta1']) >= th1 or int(r['maxDelta2']) >= th1)
    cnt_th2 = sum(1 for r in rows if int(r['maxDelta1']) >= th2 or int(r['maxDelta2']) >= th2)

    print('Processed spikes:', n)
    print(f'Spikes with any adjacent-sample delta >= {th1}: {cnt_th1} ({cnt_th1/n*100:.1f}%)')
    print(f'Spikes with any adjacent-sample delta >= {th2}: {cnt_th2} ({cnt_th2/n*100:.1f}%)')

    # print top 8 by max delta
    rows_sorted = sorted(rows, key=lambda r: max(int(r['maxDelta1']), int(r['maxDelta2'])), reverse=True)
    print('\nTop spikes by adjacent-sample delta:')
    for r in rows_sorted[:8]:
        print(f"time={r['time']} maxMag={r['maxMag']} maxDelta1={r['maxDelta1']} maxDelta2={r['maxDelta2']} recentCount={r['nearestRecentCount']} deduped={r['deduped']}")

    print('\nCSV written to', out_csv)

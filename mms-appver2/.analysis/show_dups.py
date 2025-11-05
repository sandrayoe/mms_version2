"""
show_dups.py

Prints concrete examples of duplicate spike payloads from a spike events JSON export and
writes a proof report to .analysis/plots/dedupe_proof.txt

Usage:
 python ./.analysis/show_dups.py <spike_json> [out_dir]
"""
import sys, os, json
from collections import defaultdict

def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)

def canonical_key(s):
    r1 = s.get('raw1s') or []
    r2 = s.get('raw2s') or []
    return (tuple(r1), tuple(r2))

def format_array(a, limit=64):
    if not a:
        return '[]'
    if len(a) <= limit:
        return str(list(a))
    return str(list(a[:limit])) + '...'

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print('Usage: python show_dups.py <spike_json> [out_dir]')
        sys.exit(1)
    path = sys.argv[1]
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), 'plots')
    os.makedirs(out_dir, exist_ok=True)

    data = load(path)
    spikes = [e for e in data if e.get('type') == 'spike']

    groups = defaultdict(list)
    for s in spikes:
        groups[canonical_key(s)].append(s)

    # filter to groups with >1 occurrence
    dup_groups = [(k,v) for k,v in groups.items() if len(v) > 1]
    dup_groups.sort(key=lambda kv: -len(kv[1]))

    report_lines = []
    report_lines.append('Duplicate payload proof report')
    report_lines.append('Source: ' + path)
    report_lines.append('Total spikes: %d' % len(spikes))
    report_lines.append('Duplicate groups (count > 1): %d' % len(dup_groups))
    report_lines.append('')

    # choose up to 5 example groups (top by count)
    n_show = min(5, len(dup_groups))
    for i in range(n_show):
        key, items = dup_groups[i]
        report_lines.append('=== Group %d: occurrences=%d ===' % (i+1, len(items)))
        times = [s['time'] for s in items]
        report_lines.append('Example times: %s' % ', '.join([str(t) for t in times]))
        sampleCount = items[0].get('sampleCount')
        maxMag = items[0].get('maxMag')
        report_lines.append('sampleCount=%s, maxMag=%s' % (sampleCount, maxMag))
        report_lines.append('raw1s: %s' % format_array(key[0], limit=200))
        report_lines.append('raw2s: %s' % format_array(key[1], limit=200))
        report_lines.append('')

    if not dup_groups:
        report_lines.append('(no duplicate groups found)')

    out_text = '\n'.join(report_lines)
    print(out_text)

    out_file = os.path.join(out_dir, 'dedupe_proof.txt')
    with open(out_file, 'w', encoding='utf-8') as f:
        f.write(out_text)
    print('\nWrote proof to:', out_file)

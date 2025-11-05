import json
import statistics
from collections import Counter, defaultdict
from pathlib import Path

# Update this path if needed
INPUT = Path(r"C:\Users\sandr\Downloads\spike_events_NA_NA_2025-11-04T17-27-44.json")
OUT_DIR = Path(r".") / ".analysis"
OUT_DIR.mkdir(parents=True, exist_ok=True)

with INPUT.open('r', encoding='utf-8') as fh:
    data = json.load(fh)

total = len(data)
by_type = Counter(item.get('type') for item in data)

spikes = [e for e in data if e.get('type')=='spike']
bursts = [e for e in data if e.get('type')=='burst']
rapid = [e for e in data if e.get('type')=='rapid_notifications']

# Spike stats
maxmags = [e.get('maxMag', 0) for e in spikes]
perints = [e.get('perSampleInterval') for e in spikes if 'perSampleInterval' in e]

sample_counts = Counter(e.get('sampleCount') for e in spikes)
len_counts = Counter(e.get('len') for e in spikes)

raw_vals = []
raw_min = None
raw_max = None
raw_count = 0

# Hash raw arrays to detect duplicates
import hashlib
hash_counts = Counter()

for e in spikes:
    r1 = e.get('raw1s', [])
    r2 = e.get('raw2s', [])
    concat = ','.join(map(str,r1)) + '|' + ','.join(map(str,r2))
    h = hashlib.sha1(concat.encode('utf-8')).hexdigest()
    hash_counts[h] += 1
    for v in r1 + r2:
        raw_count += 1
        if raw_min is None or v < raw_min:
            raw_min = v
        if raw_max is None or v > raw_max:
            raw_max = v
        raw_vals.append(v)

# compute duplicates
dup_counts = [cnt for cnt in hash_counts.values() if cnt>1]
most_dup = hash_counts.most_common(5)

# summary stats helpers
def stats_list(nums):
    if not nums:
        return {}
    return {
        'count': len(nums),
        'min': min(nums),
        'max': max(nums),
        'mean': statistics.mean(nums),
        'median': statistics.median(nums),
        'stdev': statistics.pstdev(nums) if len(nums)>1 else 0,
        'p25': statistics.quantiles(nums, n=4)[0],
        'p75': statistics.quantiles(nums, n=4)[2],
    }

summary = {
    'total_events': total,
    'by_type': dict(by_type),
    'spike_count': len(spikes),
    'burst_count': len(bursts),
    'rapid_count': len(rapid),
    'spike_maxMag_stats': stats_list(maxmags),
    'spike_perSampleInterval_stats': stats_list([x for x in perints if x is not None]),
    'spike_sampleCount_counts': dict(sample_counts),
    'spike_len_counts': dict(len_counts),
    'raw_values_count': raw_count,
    'raw_min': raw_min,
    'raw_max': raw_max,
    'duplicate_spike_groups': len(dup_counts),
    'top_duplicate_groups': most_dup[:5],
}

# write summary JSON
with (OUT_DIR / 'spike_summary.json').open('w', encoding='utf-8') as fh:
    json.dump(summary, fh, indent=2)

# write spikes CSV (one row per spike with id,time,maxMag,sampleCount,perSampleInterval,len,raw_min,raw_max)
import csv
with (OUT_DIR / 'spikes_summary.csv').open('w', newline='', encoding='utf-8') as fh:
    writer = csv.writer(fh)
    writer.writerow(['id','time','maxMag','sampleCount','perSampleInterval','len','raw_min','raw_max'])
    for e in spikes:
        r1 = e.get('raw1s', [])
        r2 = e.get('raw2s', [])
        rmin = min(r1 + r2) if (r1 + r2) else ''
        rmax = max(r1 + r2) if (r1 + r2) else ''
        writer.writerow([e.get('id'), e.get('time'), e.get('maxMag'), e.get('sampleCount'), e.get('perSampleInterval'), e.get('len'), rmin, rmax])

# write duplicates CSV
with (OUT_DIR / 'spike_duplicate_groups.csv').open('w', newline='', encoding='utf-8') as fh:
    writer = csv.writer(fh)
    writer.writerow(['hash','count'])
    for h,c in hash_counts.most_common():
        if c>1:
            writer.writerow([h,c])

# print concise summary
print('Summary written to .analysis/spike_summary.json and spikes_summary.csv')
print('\nOverall summary:')
for k,v in [('total_events',total), ('spike_count', len(spikes)), ('burst_count', len(bursts)), ('rapid_count', len(rapid))]:
    print(f'{k}: {v}')
print('\nSpike maxMag stats:')
for k,v in summary['spike_maxMag_stats'].items():
    print(f'  {k}: {v}')
print('\nRaw values min/max:', raw_min, raw_max)
print('Top duplicate groups (hash,count):')
for h,c in most_dup[:10]:
    if c>1:
        print(' ',h,c)

print('\nDone.')

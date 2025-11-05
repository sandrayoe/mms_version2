const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const INPUT = path.resolve('C:/Users/sandr/Downloads/spike_events_NA_NA_2025-11-04T17-27-44.json');
const OUT_DIR = path.resolve('.','.analysis');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const data = JSON.parse(fs.readFileSync(INPUT,'utf8'));
const total = data.length;
const byType = {};
for (const e of data) byType[e.type] = (byType[e.type]||0)+1;

const spikes = data.filter(e => e.type === 'spike');
const bursts = data.filter(e => e.type === 'burst');
const rapid = data.filter(e => e.type === 'rapid_notifications');

const maxmags = spikes.map(e => e.maxMag || 0).filter(x => x!=null);
const perints = spikes.map(e => e.perSampleInterval).filter(x => x!=null);

function mean(arr){ if(arr.length===0) return null; return arr.reduce((a,b)=>a+b,0)/arr.length; }
function median(arr){ if(arr.length===0) return null; const s = arr.slice().sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2 ? s[m] : (s[m-1]+s[m])/2; }
function quantiles(arr){ if(arr.length<4) return [null,null]; const s = arr.slice().sort((a,b)=>a-b); const p25 = s[Math.floor(s.length*0.25)]; const p75 = s[Math.floor(s.length*0.75)]; return [p25, p75]; }
function pstdev(arr){ if(arr.length<=1) return 0; const mu = mean(arr); return Math.sqrt(arr.reduce((acc,x)=>acc+(x-mu)*(x-mu),0)/arr.length); }

const sampleCountCounts = {};
const lenCounts = {};
let rawMin = null, rawMax = null, rawCount = 0;
const hashCounts = {};
for (const e of spikes){
  sampleCountCounts[e.sampleCount] = (sampleCountCounts[e.sampleCount]||0)+1;
  lenCounts[e.len] = (lenCounts[e.len]||0)+1;
  const r1 = e.raw1s||[]; const r2 = e.raw2s||[]; const all = r1.concat(r2);
  if (all.length){
    rawCount += all.length;
    for (const v of all){ if (rawMin===null||v<rawMin) rawMin=v; if(rawMax===null||v>rawMax) rawMax=v; }
  }
  const concat = (r1.join(',')+'|'+r2.join(','));
  const h = crypto.createHash('sha1').update(concat).digest('hex');
  hashCounts[h] = (hashCounts[h]||0)+1;
}

const dupGroups = Object.entries(hashCounts).filter(([h,c])=>c>1).sort((a,b)=>b[1]-a[1]);

const summary = {
  total_events: total,
  by_type: byType,
  spike_count: spikes.length,
  burst_count: bursts.length,
  rapid_count: rapid.length,
  spike_maxMag_stats: {
    count: maxmags.length,
    min: maxmags.length? Math.min(...maxmags):null,
    max: maxmags.length? Math.max(...maxmags):null,
    mean: mean(maxmags),
    median: median(maxmags),
    stdev: pstdev(maxmags),
    p25: quantiles(maxmags)[0],
    p75: quantiles(maxmags)[1],
  },
  spike_perSampleInterval_stats: {
    count: perints.length,
    min: perints.length? Math.min(...perints):null,
    max: perints.length? Math.max(...perints):null,
    mean: mean(perints),
    median: median(perints),
    stdev: pstdev(perints),
    p25: quantiles(perints)[0],
    p75: quantiles(perints)[1],
  },
  spike_sampleCount_counts: sampleCountCounts,
  spike_len_counts: lenCounts,
  raw_values_count: rawCount,
  raw_min: rawMin,
  raw_max: rawMax,
  duplicate_spike_groups: dupGroups.length,
  top_duplicate_groups: dupGroups.slice(0,10).map(([h,c])=>({hash:h,count:c})),
};

fs.writeFileSync(path.join(OUT_DIR,'spike_summary.json'), JSON.stringify(summary,null,2));

// write spikes CSV
const csv = ['id,time,maxMag,sampleCount,perSampleInterval,len,raw_min,raw_max'];
for (const e of spikes){
  const r1 = e.raw1s||[]; const r2 = e.raw2s||[]; const all = r1.concat(r2);
  const rmin = all.length? Math.min(...all):''; const rmax = all.length? Math.max(...all):'';
  csv.push([e.id,e.time,e.maxMag,e.sampleCount,e.perSampleInterval,e.len,rmin,rmax].join(','));
}
fs.writeFileSync(path.join(OUT_DIR,'spikes_summary.csv'), csv.join('\n'));

// duplicates CSV
const dlines = ['hash,count'];
for (const [h,c] of dupGroups){ if(c>1) dlines.push(`${h},${c}`); }
fs.writeFileSync(path.join(OUT_DIR,'spike_duplicate_groups.csv'), dlines.join('\n'));

console.log('Wrote .analysis/spike_summary.json and spikes_summary.csv and spike_duplicate_groups.csv');
console.log('Overall: total events=%d, spikes=%d, bursts=%d, rapid=%d', total, spikes.length, bursts.length, rapid.length);
console.log('Spike maxMag stats:', summary.spike_maxMag_stats);
console.log('Raw min/max:', rawMin, rawMax);
console.log('Duplicate spike groups:', dupGroups.length, 'Top (hash,count):', dupGroups.slice(0,5));

const fs = require('fs');
const path = require('path');

const INPUT = path.resolve('C:/Users/sandr/Downloads/spike_events_NA_NA_2025-11-04T17-27-44.json');
const OUT_DIR = path.resolve('.','.analysis');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const data = JSON.parse(fs.readFileSync(INPUT,'utf8'));
const spikes = data.filter(e => e.type === 'spike');
const rapid = data.filter(e => e.type === 'rapid_notifications').sort((a,b)=>a.time - b.time);

function findNearestRapid(t){
  // binary search in rapid by time
  let lo = 0, hi = rapid.length - 1;
  if (rapid.length === 0) return null;
  while (lo <= hi){
    const mid = Math.floor((lo+hi)/2);
    if (rapid[mid].time === t) return rapid[mid];
    if (rapid[mid].time < t) lo = mid+1; else hi = mid-1;
  }
  // lo is insertion index; consider lo and lo-1
  const candidates = [];
  if (rapid[lo]) candidates.push(rapid[lo]);
  if (rapid[lo-1]) candidates.push(rapid[lo-1]);
  if (candidates.length===0) return null;
  candidates.sort((a,b)=>Math.abs(a.time-t)-Math.abs(b.time-t));
  return candidates[0];
}

const rows = [];
let spikesWithNearbyRapid = 0;
let sumRecentCount = 0;
for (const s of spikes){
  const nearest = findNearestRapid(s.time);
  let delta = null, recentCount = null, nearestTime = null;
  if (nearest){
    delta = s.time - nearest.time;
    recentCount = nearest.recentCount;
    nearestTime = nearest.time;
  }
  if (recentCount !== null && recentCount !== undefined) {
    spikesWithNearbyRapid += 1;
    sumRecentCount += recentCount;
  }
  rows.push({
    id: s.id,
    time: s.time,
    maxMag: s.maxMag,
    sampleCount: s.sampleCount,
    deduped: !!s.deduped,
    nearestRapidTime: nearestTime,
    recentCount,
    deltaMs: delta,
  });
}

fs.writeFileSync(path.join(OUT_DIR,'spikes_with_rapid_counts.csv'), ['id,time,maxMag,sampleCount,deduped,nearestRapidTime,recentCount,deltaMs', ...rows.map(r=>`${r.id},${r.time},${r.maxMag},${r.sampleCount},${r.deduped},${r.nearestRapidTime||''},${r.recentCount||''},${r.deltaMs||''}`)].join('\n'));
fs.writeFileSync(path.join(OUT_DIR,'spikes_with_rapid_counts.json'), JSON.stringify(rows,null,2));

const totalSpikes = spikes.length;
const pctWithRapid = totalSpikes ? (spikesWithNearbyRapid/totalSpikes*100).toFixed(1) : '0';
const avgRecent = spikesWithNearbyRapid ? (sumRecentCount/spikesWithNearbyRapid).toFixed(2) : '0';

console.log(`Wrote .analysis/spikes_with_rapid_counts.csv and .analysis/spikes_with_rapid_counts.json`);
console.log(`spikes: ${totalSpikes}, spikes matched to rapid_notifications: ${spikesWithNearbyRapid} (${pctWithRapid}%), avg recentCount=${avgRecent}`);

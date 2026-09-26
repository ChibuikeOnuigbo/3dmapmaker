import { densify } from '../js/worlds/willow-parish.js';
import fs from 'fs';
const r = densify();
const have = new Set(fs.readdirSync('assets/willow/day').filter(f=>f.endsWith('.jpg')).map(f=>+f.slice(1,-4)));
const adj = {};
for (const [a,b] of r.edges){ (adj[a]??=[]).push(b); (adj[b]??=[]).push(a); }
const flagged = new Set();
try {
  for (const line of fs.readFileSync('tools-render/chain-audit.txt','utf8').split('\n')) {
    const m = line.match(/n(\d+) <-> n(\d+):/);
    if (m) flagged.add(m[1]+'|'+m[2]), flagged.add(m[2]+'|'+m[1]);
  }
} catch {}
// nearest existing frame within `maxHops` along branch via node `from`, avoiding node `away`
function nearest(from, away, maxHops){
  let prev = away, cur = from, hops = 1;
  const seen = new Set([away]);
  while (!have.has(cur) && hops <= maxHops){
    if (seen.has(cur)) return null;
    seen.add(cur);
    const nx = (adj[cur]||[]).filter(x=>x!==prev);
    if (nx.length !== 1) return null;
    prev = cur; cur = nx[0]; hops++;
  }
  return have.has(cur) ? {frame: cur, hops} : null;
}
const out = [];
for (const n of Object.keys(adj).map(Number).sort((a,b)=>a-b)){
  if (have.has(n)) continue;
  const cands = (adj[n]||[]).map(x=>nearest(x,n,4)).filter(Boolean);
  if (!cands.length) continue;
  cands.sort((a,b)=>a.hops-b.hops || a.frame-b.frame);
  const s = cands[0];
  out.push({node:n, source:s.frame, hops:s.hops, both: cands.length>1 ? cands[1].frame : null,
            seamOk: !cands[1] || !flagged.has(s.frame+'|'+cands[1].frame)});
}
// prefer: adjacent (1 hop), both-side pair unflagged; then 2-hop
const rank = o => (o.hops!==1) + (!o.seamOk)*0.5;
out.sort((a,b)=> rank(a)-rank(b) || a.node-b.node);
console.log(JSON.stringify(out.slice(0,60)));

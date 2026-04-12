/**
 * pandora-worker.js — Pandora Distributed Simulation Engine v2
 *
 * LOAD-BALANCING MODEL:
 *   - Each visiting computer claims up to MAX_BIOMES_PER_WORKER biomes
 *   - Claims coordinated through Firebase /pandora/workers/{id}
 *   - Biomes actively viewed by a visitor are yielded (page takes priority)
 *   - On disconnect, onDisconnect() releases all claims instantly
 *   - Stale workers (>90s without heartbeat) have claims reclaimed
 *
 * GENERATION CYCLING:
 *   - Worker tracks tier stagnation per biome
 *   - After STAGNATION_DEATH ticks without tier progress → death cycle
 *   - Death: saves archive to Firebase, increments currentGeneration,
 *     evolves genome, re-inits simulation
 *   - Biome pages will pick up the new generation when they load
 *
 * EXAMPLE DISTRIBUTION (100 biomes):
 *   1 computer  → 10 running, 90 paused
 *   5 computers → 50 running, 50 paused
 *  10 computers → 100 running, 0 paused
 */

'use strict';

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js');

// ── Config ─────────────────────────────────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            'AIzaSyANFCI2Uyehrezru2TxZ8jOP_V9lVSYkGA',
  authDomain:        'pandora-68637.firebaseapp.com',
  databaseURL:       'https://pandora-68637-default-rtdb.firebaseio.com',
  projectId:         'pandora-68637',
  storageBucket:     'pandora-68637.firebasestorage.app',
  messagingSenderId: '244482446708',
  appId:             '1:244482446708:web:7bec4962611f8c4a224821',
};

const MAX_BIOMES_PER_WORKER = 17;      // cover all live biomes on a single visitor
const HEARTBEAT_MS          = 25000;
const STALE_THRESHOLD_MS    = 75000;
const CLAIM_RETRY_MS        = 60000;
const TICK_BATCH            = 8;       // physics ticks per interval
const LOOP_HZ               = 50;      // interval ms → ~160 ticks/s per biome
const SAVE_MS               = 20000;   // save state to Firebase every 20s
const POST_MS               = 1000;    // post stats to main thread every 1s
const STAGNATION_DEATH      = 28000;   // ticks without tier change → death (~175s at 160tps)

const W = 900, H = 650, CELL = 32;

// ── Biome definitions ──────────────────────────────────────────────────────────
// bonds: [typeA, typeB, probability, maxBondsA, maxBondsB, minDist, maxDist]
const BIOME_DEFS = {
  '0': {
    name:'Terra', t:['AA','LP','PH'], n:[185,100,28],
    noise:0.22, T0:350,
    bonds:[[0,0,0.007,3,3,7,19],[0,1,0.004,3,2,7,18],[0,2,0.012,3,4,7,20],[1,1,0.005,2,2,8,16]],
    breakDist:24, breakProb:0.0008,
  },
  '2': {
    name:'Hydrothermal', t:['H2S','FE','SU'], n:[160,120,30],
    noise:0.30, T0:480,
    bonds:[[0,1,0.010,3,3,7,20],[1,2,0.008,3,2,8,18],[0,0,0.005,3,3,8,19]],
    breakDist:25, breakProb:0.0009,
  },
  '3': {
    name:'Primordial Ocean', t:['LH','LT','AA'], n:[165,115,35],
    noise:0.18, T0:320,
    bonds:[[0,1,0.012,3,2,7,18],[1,1,0.009,2,2,8,16],[0,0,0.004,3,3,8,20]],
    breakDist:23, breakProb:0.0007,
  },
  '4': {
    name:'Warm Soup', t:['AA','LP','PH'], n:[170,80,25],
    noise:0.22, T0:360,
    bonds:[[0,0,0.008,3,3,7,19],[0,2,0.013,3,4,7,20],[1,1,0.006,2,2,8,16]],
    breakDist:24, breakProb:0.0008,
  },
  '6': {
    name:'Tidal Pool', t:['NA','CL','OR'], n:[175,125,28],
    noise:0.25, T0:310,
    bonds:[[0,1,0.009,3,3,7,19],[0,2,0.007,3,3,7,18],[1,2,0.006,3,2,8,17]],
    breakDist:23, breakProb:0.0007,
  },
  '8': {
    name:'Clay Lattice', t:['SI','CL','AA'], n:[160,140,25],
    noise:0.15, T0:280,
    bonds:[[0,1,0.011,4,3,8,21],[0,2,0.007,4,4,7,19],[1,1,0.004,3,3,9,22]],
    breakDist:27, breakProb:0.0006,
  },
  '10': {
    name:'Siliconia', t:['SI','OX','SC'], n:[160,120,24],
    noise:0.28, T0:900,
    bonds:[[0,1,0.009,4,2,8,20],[0,0,0.004,4,4,9,22],[1,2,0.006,2,3,7,18]],
    breakDist:26, breakProb:0.0007,
  },
  '12': {
    name:'Phospho World', t:['PH','AD','NU'], n:[155,110,30],
    noise:0.20, T0:330,
    bonds:[[0,1,0.013,4,3,7,19],[1,2,0.010,3,4,7,18],[0,0,0.005,4,4,8,20]],
    breakDist:24, breakProb:0.0008,
  },
  '16': {
    name:'Nitrogen Sea', t:['N2','NH','NI'], n:[170,130,22],
    noise:0.24, T0:400,
    bonds:[[0,1,0.010,3,3,7,19],[1,1,0.007,3,3,8,18],[0,2,0.006,3,3,7,19]],
    breakDist:25, breakProb:0.0007,
  },
  '20': {
    name:'Freeze Frame', t:['NM','HB','AM'], n:[160,130,22],
    noise:0.10, T0:200,
    bonds:[[0,1,0.010,3,3,7,18],[0,0,0.006,3,3,8,20],[1,2,0.008,3,2,7,17]],
    breakDist:23, breakProb:0.0006,
  },
  '22': {
    name:'Methane Cloud', t:['CH','RA','PO'], n:[155,125,25],
    noise:0.35, T0:500,
    bonds:[[0,0,0.007,3,3,8,20],[0,1,0.010,3,2,7,19],[1,2,0.008,2,3,7,18]],
    breakDist:26, breakProb:0.0010,
  },
  '30': {
    name:'Sulfur Springs', t:['SU','HS','TH'], n:[165,120,28],
    noise:0.26, T0:420,
    bonds:[[0,1,0.011,3,3,7,19],[1,2,0.009,3,3,8,18],[0,0,0.005,3,3,8,21]],
    breakDist:25, breakProb:0.0009,
  },
  '40': {
    name:'Copper Web', t:['CU','OX','CH'], n:[150,140,25],
    noise:0.22, T0:380,
    bonds:[[0,1,0.012,4,2,8,20],[0,2,0.008,4,3,7,18],[1,1,0.005,2,2,9,21]],
    breakDist:26, breakProb:0.0008,
  },
  '50': {
    name:'Boronia', t:['BO','NB','WC'], n:[150,130,25],
    noise:0.18, T0:320,
    bonds:[[0,1,0.009,3,3,7,19],[0,0,0.005,3,3,8,20],[1,2,0.007,3,2,7,18]],
    breakDist:24, breakProb:0.0007,
  },
  '62': {
    name:'Plasma Arc', t:['IO','PL','RA'], n:[145,125,28],
    noise:0.40, T0:600,
    bonds:[[0,1,0.014,3,2,7,18],[0,2,0.009,3,3,6,17],[1,1,0.006,2,2,8,19]],
    breakDist:24, breakProb:0.0012,
  },
  '70': {
    name:'Iron Veil', t:['FE','SU','OW'], n:[140,120,25],
    noise:0.20, T0:400,
    bonds:[[0,1,0.007,4,2,8,20],[0,0,0.003,4,4,9,22],[1,2,0.005,2,3,7,18]],
    breakDist:25, breakProb:0.0009,
  },
  '80': {
    name:'Deep Crystal', t:['CR','SI','DE'], n:[145,135,22],
    noise:0.08, T0:150,
    bonds:[[0,1,0.013,4,3,8,22],[0,0,0.007,4,4,9,24],[1,2,0.005,3,3,7,19]],
    breakDist:28, breakProb:0.0005,
  },
};

const ALL_BIOME_IDS = Object.keys(BIOME_DEFS).map(Number);

const TIER_NAMES = [
  'Void','First Chemistry','Molecular Drift','Chain Formation',
  'Branched Network','Ring Closure','Dense Assembly','Reaction Cascade',
  'Amphiphilic Order','Core-Shell Phase','Closed Compartment',
  'Proto-Division','Inherited State','Cooperative Colony',
  'Differentiation','Chemical Signalling','Adaptive Memory',
  'Symbiosis','Layered Metabolism','Directed Motion','✦ Sentience',
];

// ── Genome evolution ──────────────────────────────────────────────────────────
function evolveGenome(archives, g) {
  const ng = { ...(g || { n1:1, n2:1, n3:1, noiseScale:1 }) };
  if (!archives || !archives.length) return ng;
  const maxH = Math.max(...archives.map(a => a.maxTier || 0));
  const last  = archives[archives.length - 1];
  const ms    = (last.maxTier >= maxH && last.maxTier >= 4) ? 0.015 : 0.08;
  const mu    = () => 1 + (Math.random() - 0.5) * 2 * ms;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  ['n1','n2','n3','noiseScale'].forEach(k => {
    ng[k] = clamp((ng[k] || 1) * mu(), 0.4, 2.2);
  });
  const avg = archives.reduce((s, a) => s + (a.maxTier || 0), 0) / archives.length;
  if (avg < 6)       ng.n1 = clamp(ng.n1 * 1.05, 0.4, 2.2);
  else if (avg < 10) ng.n1 = clamp(ng.n1 * 1.03, 0.4, 2.2);
  else               ng.noiseScale = clamp(ng.noiseScale * 0.97, 0.4, 2.2);
  return ng;
}

// ── Generic particle simulation ───────────────────────────────────────────────
function mkSim(def, genome) {
  const g  = genome || { n1:1, n2:1, n3:1, noiseScale:1 };
  const ns = [
    Math.round(def.n[0] * (g.n1 || 1)),
    Math.round(def.n[1] * (g.n2 || 1)),
    Math.round(def.n[2] * (g.n3 || 1)),
  ];
  let noise    = def.noise * (g.noiseScale || 1);
  const T0     = def.T0;
  const BOND_K = 0.008;

  const A     = [];
  let uid     = 0;
  const BONDS = new Set();
  const bkey  = (i, j) => i < j ? `${i},${j}` : `${j},${i}`;

  for (let t = 0; t < 3; t++)
    for (let k = 0; k < ns[t]; k++)
      A.push({ id:uid++, type:t,
               x:  Math.random() * W,
               y:  Math.random() * H,
               vx: (Math.random() - 0.5) * 0.8,
               vy: (Math.random() - 0.5) * 0.8,
               bonds: new Set() });

  let tick = 0, currentTier = 0, peakComplexity = 0, peakTick = 0;

  // Spatial hash grid
  let gh = {};
  function buildGrid() {
    gh = {};
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      const k = `${(a.x / CELL) | 0},${(a.y / CELL) | 0}`;
      (gh[k] = gh[k] || []).push(i);
    }
  }
  function nearby(x, y, r = 1) {
    const cx = (x / CELL) | 0, cy = (y / CELL) | 0, out = [];
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++) {
        const nb = gh[`${cx + dx},${cy + dy}`];
        if (nb) for (const i of nb) out.push(i);
      }
    return out;
  }

  function addBond(i, j) { const k = bkey(i,j); if(BONDS.has(k)) return; BONDS.add(k); A[i].bonds.add(j); A[j].bonds.add(i); }
  function rmBond(i, j)  { const k = bkey(i,j); if(!BONDS.has(k)) return; BONDS.delete(k); A[i].bonds.delete(j); A[j].bonds.delete(i); }

  function step() {
    tick++;
    buildGrid();
    const toBreak = [];
    const lTemp = (x, y) => T0 * (1 + 0.4 * Math.max(0, 1 - Math.hypot(x - W*0.5, y - H) / (H * 0.6)));

    for (let i = 0; i < A.length; i++) {
      const a  = A[i];
      const Tl = lTemp(a.x, a.y);
      const br = Math.sqrt(Tl / T0) * noise;

      a.vx += (Math.random() - 0.5) * br;
      a.vy += (Math.random() - 0.5) * br;

      for (const j of a.bonds) {
        const b = A[j];
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
        const stretch = d - 14;
        if (Math.abs(stretch) > 0.01) { const f = BOND_K * stretch / d; a.vx += dx*f; a.vy += dy*f; }
        if (d > def.breakDist && Math.random() < def.breakProb * d) toBreak.push([i, j]);
      }

      for (const j of nearby(a.x, a.y)) {
        if (j <= i) continue;
        const b = A[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < 1) continue;
        const d = Math.sqrt(d2);
        if (a.type === b.type && d < 15) {
          const f = 0.18 * (1 - d/15) / d;
          a.vx -= dx*f; a.vy -= dy*f; b.vx += dx*f; b.vy += dy*f;
        }
        if (!BONDS.has(bkey(i, j))) {
          const rule = def.bonds.find(r =>
            (r[0] === a.type && r[1] === b.type) || (r[0] === b.type && r[1] === a.type));
          if (rule) {
            const [,, prob, maxA, maxB, minD, maxD] = rule;
            if (d >= minD && d <= maxD && a.bonds.size < maxA && b.bonds.size < maxB && Math.random() < prob)
              addBond(i, j);
          }
        }
      }

      a.vx *= 0.96; a.vy *= 0.96;
      const spd = Math.hypot(a.vx, a.vy);
      if (spd > 3.5) { a.vx = a.vx/spd*3.5; a.vy = a.vy/spd*3.5; }
      a.x += a.vx; a.y += a.vy;
      if (a.x < 4)   { a.x = 4;   a.vx =  Math.abs(a.vx); }
      if (a.x > W-4) { a.x = W-4; a.vx = -Math.abs(a.vx); }
      if (a.y < 4)   { a.y = 4;   a.vy =  Math.abs(a.vy); }
      if (a.y > H-4) { a.y = H-4; a.vy = -Math.abs(a.vy); }
    }
    for (const [i, j] of toBreak) rmBond(i, j);
  }

  function analyse() {
    const vis = new Uint8Array(A.length);
    const comps = [];
    for (let i = 0; i < A.length; i++) {
      if (vis[i] || A[i].bonds.size === 0) continue;
      const comp = { nodes:[], bonds:0, typeCount:[0,0,0] };
      const q = [i];
      while (q.length) {
        const c = q.pop(); if (vis[c]) continue; vis[c] = 1;
        comp.nodes.push(c); comp.typeCount[A[c].type]++;
        for (const nb of A[c].bonds) { comp.bonds++; if (!vis[nb]) q.push(nb); }
      }
      comp.bonds = Math.floor(comp.bonds / 2);
      if (comp.nodes.length >= 2) comps.push(comp);
    }
    const totalBonded  = comps.reduce((s, c) => s + c.nodes.length, 0);
    const longestChain = comps.length ? Math.max(...comps.map(c => c.nodes.length)) : 0;
    const branchPoints = A.filter(a => a.bonds.size >= 3).length;
    const mixedComps   = comps.filter(c => c.typeCount.filter(x => x > 0).length > 1).length;
    const N = A.length || 1;

    let cx = 0;
    cx += (totalBonded / N) * 2.5;
    cx += Math.min(longestChain / 20, 1) * 2.0;
    cx += Math.min(branchPoints / 10, 1) * 1.5;
    cx += Math.min(mixedComps   / 5,  1) * 2.0;
    cx += Math.min(BONDS.size   / 80, 1) * 2.0;

    if (cx > peakComplexity) { peakComplexity = cx; peakTick = tick; }

    const bl = BONDS.size, lc = longestChain, bp = branchPoints, mc = mixedComps;
    let tier = 0;
    if (bl >= 3)                              tier = 1;
    if (bl >= 20   && mc >= 1)               tier = 2;
    if (bl >= 50   && lc >= 6  && mc >= 2)   tier = 3;
    if (bl >= 100  && lc >= 10 && bp >= 3)   tier = 4;
    if (bl >= 180  && mc >= 4  && bp >= 8)   tier = 5;
    if (cx >= 4.5  && bl >= 250)             tier = 6;
    if (cx >= 5.5  && lc >= 18 && bp >= 15)  tier = 7;
    if (cx >= 6.5  && mc >= 8  && bl >= 350) tier = 8;
    if (cx >= 7.5  && bp >= 25)              tier = 9;
    if (cx >= 8.5  && mc >= 12)              tier = 10;
    if (cx >= 9.5  && bl >= 500)             tier = 11;
    if (cx >= 10.5 && lc >= 30)              tier = 12;
    currentTier = Math.max(currentTier, tier);
    return { cx, tier: currentTier, longestChain, branchPoints, mixedComps, bonds: bl };
  }

  function getSnapshot() {
    const m = analyse();
    return { tick, currentTier, peakComplexity, peakTick,
             complexity: m.cx, bonds: m.bonds, worldStatus: 'active', lastUpdated: Date.now() };
  }
  function restoreFrom(s) {
    if (!s || (s.tick || 0) < 100) return;
    tick = s.tick || 0;
    currentTier = s.currentTier || 0;
    peakComplexity = s.peakComplexity || 0;
    peakTick = s.peakTick || 0;
  }

  return { step, getSnapshot, restoreFrom,
           getTick: () => tick, getTier: () => currentTier };
}

// ── Worker coordination state ─────────────────────────────────────────────────
let db            = null;
const WORKER_ID   = Math.random().toString(36).slice(2, 12);
let claimedBiomes = [];
let workerRef     = null;
const sims        = {};       // biomeId → sim
const lastSave    = {};       // biomeId → timestamp
const currentGenomes = {};    // biomeId → genome
const tierStaleTicks = {};    // biomeId → ticks without tier change
const lastTierCheck  = {};    // biomeId → tier at last check
// The highest tier ever confirmed from Firebase for this biome.
// The worker NEVER writes a lower currentTier — prevents simplified physics
// (capped at T12) from overwriting T17+ values saved by the full simulation.
const tierFloor   = {};       // biomeId → highest Firebase-confirmed tier
const _dying         = new Set(); // biomes currently in death cycle
let activeViewerIds  = new Set();

// ── Death cycle ───────────────────────────────────────────────────────────────
async function workerDeathCycle(bid, snap, reason) {
  if (!db) {
    // No Firebase: just reinit
    const def = BIOME_DEFS[String(bid)];
    if (def) sims[bid] = mkSim(def, currentGenomes[bid]);
    tierStaleTicks[bid] = 0;
    lastTierCheck[bid]  = 0;
    return;
  }

  const idStr = String(bid);
  let curGen  = 1;
  try {
    const gs = await db.ref(`pandora/biomes/${idStr}/currentGeneration`).once('value');
    curGen = gs.val() || 1;
  } catch(e) {}

  const nextGen = curGen + 1;
  const genome  = currentGenomes[bid] || { n1:1, n2:1, n3:1, noiseScale:1 };

  // Save archive entry — use a transaction so we never overwrite a higher maxTier
  // written by the full simulation (worker is capped at T12; full sim can reach T50).
  const workerMaxTier = snap.currentTier;
  try {
    await db.ref(`pandora/biomes/${idStr}/archives/${curGen}`).transaction(existing => {
      const archive = {
        generation:  curGen,
        maxTier:     workerMaxTier,
        genome:      genome,
        deathReason: reason,
        timestamp:   Date.now(),
        source:      'background-worker',
      };
      if (!existing) return archive;
      // Preserve any higher maxTier already written by the full simulation
      return { ...archive, maxTier: Math.max(workerMaxTier, existing.maxTier || 0) };
    });
    await db.ref(`pandora/biomes/${idStr}/currentGeneration`).set(nextGen);
    // Update peakTier in case full simulation hasn't run yet for this generation
    db.ref(`pandora/biomes/${idStr}/peakTier`)
      .transaction(prev => workerMaxTier > (prev || 0) ? workerMaxTier : undefined)
      .catch(() => {});
  } catch(e) { console.warn(`[Worker] Archive save failed for biome ${bid}:`, e); }

  // Load all archives, evolve genome
  let archives = [];
  try {
    const as = await db.ref(`pandora/biomes/${idStr}/archives`).once('value');
    if (as.val()) archives = Object.values(as.val());
  } catch(e) {}

  const newGenome = evolveGenome(archives, genome);
  currentGenomes[bid] = newGenome;

  // Save new genome
  try {
    await db.ref(`pandora/biomes/${idStr}/genome/${nextGen}`).set(newGenome);
  } catch(e) {}

  // Re-init simulation with evolved genome
  const def = BIOME_DEFS[idStr];
  if (def) sims[bid] = mkSim(def, newGenome);
  tierStaleTicks[bid] = 0;
  lastTierCheck[bid]  = 0;
  tierFloor[bid]      = 0;   // new generation starts from T0

  console.log(`[Worker] Biome ${bid}: Gen ${curGen} → ${nextGen} (${reason}). Tier reached: T${snap.currentTier}`);
  self.postMessage({ type: 'generation', biomeId: bid, fromGen: curGen, toGen: nextGen, maxTier: snap.currentTier, reason });
}

// ── Biome claim coordination ──────────────────────────────────────────────────
async function claimBiomes() {
  if (!db) return [];
  const now = Date.now();
  const [workersSnap, presenceSnap] = await Promise.all([
    db.ref('pandora/workers').once('value'),
    db.ref('pandora/presence').once('value'),
  ]);
  const workers  = workersSnap.val()  || {};
  const presence = presenceSnap.val() || {};
  const covered  = new Set();

  for (const [wid, w] of Object.entries(workers)) {
    if (wid === WORKER_ID) continue;
    if (now - (w.lastHeartbeat || 0) < STALE_THRESHOLD_MS)
      for (const bid of (w.assignedBiomes || [])) covered.add(bid);
  }
  activeViewerIds.clear();
  for (const v of Object.values(presence)) {
    const m = (v.page || '').match(/biome-(\d+)/);
    if (m) { const bid = parseInt(m[1]); covered.add(bid); activeViewerIds.add(bid); }
  }

  const available = ALL_BIOME_IDS.filter(id => !covered.has(id));
  const claims    = available.slice(0, MAX_BIOMES_PER_WORKER);

  workerRef = db.ref(`pandora/workers/${WORKER_ID}`);
  await workerRef.set({ assignedBiomes:claims, lastHeartbeat:now, joinedAt:now, biomeCount:claims.length });
  workerRef.onDisconnect().remove();
  claimedBiomes = claims;
  return claims;
}

function releaseViewedBiomes() {
  claimedBiomes = claimedBiomes.filter(id => !activeViewerIds.has(id));
  if (workerRef) workerRef.update({ assignedBiomes:claimedBiomes, biomeCount:claimedBiomes.length }).catch(()=>{});
}

function startHeartbeat() {
  setInterval(() => {
    if (workerRef) workerRef.update({ lastHeartbeat: Date.now() }).catch(()=>{});
  }, HEARTBEAT_MS);
}

function startClaimRefresh() {
  setInterval(async () => {
    if (!db) return;
    const prev = [...claimedBiomes];
    await claimBiomes();
    for (const bid of claimedBiomes) {
      if (!sims[bid]) await initBiomeSim(bid);
    }
    const gained = claimedBiomes.filter(id => !prev.includes(id));
    const lost   = prev.filter(id => !claimedBiomes.includes(id));
    if (gained.length || lost.length)
      self.postMessage({ type:'claims', claimed:claimedBiomes, gained, lost });
  }, CLAIM_RETRY_MS);
}

// ── Simulation initialisation ─────────────────────────────────────────────────
async function initBiomeSim(bid) {
  const def = BIOME_DEFS[String(bid)];
  if (!def) return;

  let state = null, genome = null, savedPeakTier = 0;
  if (db) {
    try {
      const [stSnap, bmSnap] = await Promise.all([
        db.ref(`pandora/biomes/${String(bid)}/state`).once('value'),
        db.ref(`pandora/biomes/${String(bid)}`).once('value'),
      ]);
      state = stSnap.val();
      const bm  = bmSnap.val() || {};
      const gen = bm.currentGeneration || 1;
      genome = bm.genome ? (bm.genome[String(gen)] || null) : null;
      // peakTier is the all-time high across all generations — use as hard floor
      savedPeakTier = bm.peakTier || state?.currentTier || 0;
    } catch(e) {}
  }

  currentGenomes[bid] = genome || { n1:1, n2:1, n3:1, noiseScale:1 };
  const sim = mkSim(def, currentGenomes[bid]);
  if (state && state.worldStatus !== 'dead') sim.restoreFrom(state);
  sims[bid]          = sim;
  lastSave[bid]      = Date.now();
  tierStaleTicks[bid] = 0;
  lastTierCheck[bid]  = sim.getTier();
  // tierFloor = max(current state tier, all-time peakTier) — worker NEVER writes lower
  tierFloor[bid]     = savedPeakTier;
}

// ── Main simulation loop ──────────────────────────────────────────────────────
let lastPost = Date.now();

function startLoop() {
  setInterval(() => {
    const now = Date.now();

    for (const bid of claimedBiomes) {
      const sim = sims[bid];
      if (!sim || activeViewerIds.has(bid) || _dying.has(bid)) continue;

      for (let i = 0; i < TICK_BATCH; i++) sim.step();

      // Track tier stagnation
      const tier = sim.getTier();
      if (tier !== (lastTierCheck[bid] ?? -1)) {
        lastTierCheck[bid]  = tier;
        tierStaleTicks[bid] = 0;
      } else {
        tierStaleTicks[bid] = (tierStaleTicks[bid] || 0) + TICK_BATCH;
      }

      // Stagnation death: fire if world has been at same tier too long
      if (tierStaleTicks[bid] >= STAGNATION_DEATH) {
        const snap = sim.getSnapshot();
        // Only die if tier >= 1 (T0 worlds get a longer grace period)
        const threshold = tier === 0 ? STAGNATION_DEATH * 2 : STAGNATION_DEATH;
        if (tierStaleTicks[bid] >= threshold) {
          _dying.add(bid);
          workerDeathCycle(bid, snap, `stagnation at T${tier}`)
            .then(() => _dying.delete(bid))
            .catch(e => { console.warn(e); _dying.delete(bid); });
        }
      }

      // Periodic Firebase save
      // Worker physics is simplified (capped T12). tierFloor = all-time peakTier.
      // Never write a currentTier lower than the floor.
      // If worker achieves a new high, update both floor and peakTier.
      if (db && now - (lastSave[bid] || 0) > SAVE_MS) {
        const snap   = sim.getSnapshot();
        const idStr  = String(bid);
        const floor  = tierFloor[bid] || 0;
        if (snap.currentTier < floor) {
          snap.currentTier = floor;   // protect all-time peak
        } else if (snap.currentTier > floor) {
          tierFloor[bid] = snap.currentTier;
          // Persist new peak at biome root (survives generation resets)
          db.ref(`pandora/biomes/${idStr}/peakTier`)
            .transaction(prev => snap.currentTier > (prev||0) ? snap.currentTier : undefined)
            .catch(() => {});
        }
        db.ref(`pandora/biomes/${idStr}/state`).update(snap).catch(() => {});
        lastSave[bid] = now;
      }
    }

    // Post stats to main thread
    if (now - lastPost > POST_MS) {
      const stats = {};
      for (const bid of claimedBiomes) {
        if (sims[bid] && !_dying.has(bid)) stats[bid] = sims[bid].getSnapshot();
      }
      self.postMessage({ type:'stats', stats, claimed:claimedBiomes });
      lastPost = now;
    }
  }, LOOP_HZ);
}

// ── Startup ───────────────────────────────────────────────────────────────────
async function start() {
  try {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FB_CONFIG);
    db = firebase.database();
  } catch(e) {
    console.warn('[Worker] Firebase init failed — running offline:', e);
  }

  const claimed = db ? await claimBiomes() : ALL_BIOME_IDS.slice(0, MAX_BIOMES_PER_WORKER);

  // Initialise sims in parallel
  await Promise.all(claimed.map(bid => initBiomeSim(bid)));

  // Watch presence so we yield to active visitors
  if (db) {
    db.ref('pandora/presence').on('value', snap => {
      activeViewerIds.clear();
      if (snap.exists()) {
        snap.forEach(child => {
          const m = (child.val().page || '').match(/biome-(\d+)/);
          if (m) activeViewerIds.add(parseInt(m[1]));
        });
      }
      releaseViewedBiomes();
    });
  }

  startHeartbeat();
  startClaimRefresh();
  startLoop();

  self.postMessage({ type:'ready', workerId:WORKER_ID, claimed, total:ALL_BIOME_IDS.length });
}

self.onmessage = function(e) {
  if (e.data.type === 'start') start();
  if (e.data.type === 'stop') {
    if (workerRef) workerRef.remove().catch(() => {});
  }
};

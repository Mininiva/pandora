/**
 * pandora-worker.js — Pandora Distributed Simulation Engine
 *
 * LOAD-BALANCING MODEL:
 *   - Each visiting computer claims up to MAX_BIOMES_PER_WORKER (10) biomes
 *   - Claims are coordinated through Firebase /pandora/workers/{id}
 *   - Biomes actively watched by a visitor are excluded (page takes priority)
 *   - Biomes with no claimant simply pause — no worker wastes CPU on them
 *   - On disconnect, onDisconnect() releases all claims instantly
 *   - Stale workers (>90s without heartbeat) have their claims reclaimed
 *
 * EXAMPLE DISTRIBUTION (100 biomes):
 *   1 computer  →  10 running, 90 paused
 *   5 computers →  50 running, 50 paused
 *  10 computers → 100 running, 0 paused  (full coverage)
 * 20 computers → 100 running, 0 paused  (surplus — idle after claiming)
 */

'use strict';

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js');

// ── Config ─────────────────────────────────────────────────────────────────
const FB_CONFIG = {
  apiKey:            'AIzaSyANFCI2Uyehrezru2TxZ8jOP_V9lVSYkGA',
  authDomain:        'pandora-68637.firebaseapp.com',
  databaseURL:       'https://pandora-68637-default-rtdb.firebaseio.com',
  projectId:         'pandora-68637',
  storageBucket:     'pandora-68637.firebasestorage.app',
  messagingSenderId: '244482446708',
  appId:             '1:244482446708:web:7bec4962611f8c4a224821',
};

const MAX_BIOMES_PER_WORKER  = 10;      // max biomes any one computer may claim
const HEARTBEAT_MS           = 25000;   // heartbeat interval
const STALE_THRESHOLD_MS     = 75000;   // worker is stale after this long without heartbeat
const CLAIM_RETRY_MS         = 60000;   // re-evaluate claims every 60s (handles new biomes / stale workers)
const TICK_BATCH             = 8;       // physics ticks per interval
const LOOP_HZ                = 50;      // worker loop interval (ms) → ~160 ticks/s per biome
const SAVE_MS                = 90000;   // save biome state to Firebase every 90s
const POST_MS                = 1000;    // post stats to main thread every 1s

const W = 900, H = 650;
const CELL = 32;

// ── Biome definitions ───────────────────────────────────────────────────────
// Extend this to 100 as more biomes are added.
// Each entry: { name, t:[type names], n:[base counts], noise, T0, bonds:[[tA,tB,prob,maxA,maxB,minD,maxD],...], breakDist, breakProb }
const BIOME_DEFS = {
  '0': {
    name:'Terra', t:['AA','LP','PH'], n:[185,100,28],
    noise:0.22, T0:350,
    bonds:[
      [0,0, 0.007, 3,3,  7,19],
      [0,1, 0.004, 3,2,  7,18],
      [0,2, 0.012, 3,4,  7,20],
      [1,1, 0.005, 2,2,  8,16],
    ],
    breakDist:24, breakProb:0.0008,
  },
  '4': {
    name:'Warm Soup', t:['AA','LP','PH'], n:[170,80,25],
    noise:0.22, T0:360,
    bonds:[
      [0,0, 0.008, 3,3,  7,19],
      [0,2, 0.013, 3,4,  7,20],
      [1,1, 0.006, 2,2,  8,16],
    ],
    breakDist:24, breakProb:0.0008,
  },
  '10': {
    name:'Siliconia', t:['SI','OX','SC'], n:[160,120,24],
    noise:0.28, T0:900,
    bonds:[
      [0,1, 0.009, 4,2,  8,20],
      [0,0, 0.004, 4,4,  9,22],
      [1,2, 0.006, 2,3,  7,18],
    ],
    breakDist:26, breakProb:0.0007,
  },
  '20': {
    name:'Freeze Frame', t:['NM','HB','AM'], n:[160,130,22],
    noise:0.10, T0:200,
    bonds:[
      [0,1, 0.010, 3,3,  7,18],
      [0,0, 0.006, 3,3,  8,20],
      [1,2, 0.008, 3,2,  7,17],
    ],
    breakDist:23, breakProb:0.0006,
  },
  '50': {
    name:'Boronia', t:['BO','NB','WC'], n:[150,130,25],
    noise:0.18, T0:320,
    bonds:[
      [0,1, 0.009, 3,3,  7,19],
      [0,0, 0.005, 3,3,  8,20],
      [1,2, 0.007, 3,2,  7,18],
    ],
    breakDist:24, breakProb:0.0007,
  },
  '70': {
    name:'Iron Veil', t:['FE','SU','OW'], n:[140,120,25],
    noise:0.20, T0:400,
    bonds:[
      [0,1, 0.007, 4,2,  8,20],
      [0,0, 0.003, 4,4,  9,22],
      [1,2, 0.005, 2,3,  7,18],
    ],
    breakDist:25, breakProb:0.0009,
  },
};

const ALL_BIOME_IDS = Object.keys(BIOME_DEFS).map(Number);

// Tier names — kept in sync with biome pages
const TIER_NAMES = [
  'Inert','Molecular Activity','Persistent Structures','Reaction Diversity',
  'Spatial Heterogeneity','Spontaneous Assembly','Sustained Complexity',
  'Coupled Reactions','Emergent Catalysis','Boundary Formation',
  'Closed Compartment','Interior Differentiation','Protocell Stability'
];

// ── Generic particle simulation ─────────────────────────────────────────────
function mkSim(def, genome) {
  const g  = genome || { n1:1, n2:1, n3:1, noiseScale:1 };
  const ns = [
    Math.round(def.n[0] * g.n1),
    Math.round(def.n[1] * g.n2),
    Math.round(def.n[2] * g.n3),
  ];
  let noise  = def.noise * g.noiseScale;
  const T0   = def.T0;
  const BOND_K = 0.008;

  const A     = [];
  let uid     = 0;
  const BONDS = new Set();
  const bkey  = (i,j) => i < j ? `${i},${j}` : `${j},${i}`;

  for (let t = 0; t < 3; t++)
    for (let k = 0; k < ns[t]; k++)
      A.push({ id:uid++, type:t,
               x: Math.random()*W, y: Math.random()*H,
               vx:(Math.random()-0.5)*0.8, vy:(Math.random()-0.5)*0.8,
               bonds: new Set() });

  let tick=0, currentTier=0, peakComplexity=0, peakTick=0;
  const hist = [];

  // Spatial hash
  let gh = {};
  function buildGrid() {
    gh = {};
    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      const k = `${(a.x/CELL)|0},${(a.y/CELL)|0}`;
      (gh[k] = gh[k]||[]).push(i);
    }
  }
  function nearby(x, y, r=1) {
    const cx=(x/CELL)|0, cy=(y/CELL)|0, out=[];
    for (let dx=-r; dx<=r; dx++)
      for (let dy=-r; dy<=r; dy++) {
        const nb = gh[`${cx+dx},${cy+dy}`];
        if (nb) for (const i of nb) out.push(i);
      }
    return out;
  }

  function addBond(i,j){ const k=bkey(i,j); if(BONDS.has(k))return; BONDS.add(k); A[i].bonds.add(j); A[j].bonds.add(i); }
  function rmBond(i,j) { const k=bkey(i,j); if(!BONDS.has(k))return; BONDS.delete(k); A[i].bonds.delete(j); A[j].bonds.delete(i); }

  // One physics tick
  function step() {
    tick++;
    buildGrid();
    const toBreak = [];
    const lTemp = (x,y) => T0*(1 + 0.4*Math.max(0, 1 - Math.hypot(x-W*0.5, y-H)/(H*0.6)));

    for (let i = 0; i < A.length; i++) {
      const a  = A[i];
      const Tl = lTemp(a.x, a.y);
      const br = Math.sqrt(Tl/T0) * noise;

      // Brownian kick
      a.vx += (Math.random()-0.5)*br;
      a.vy += (Math.random()-0.5)*br;

      // Bond springs + break check
      for (const j of a.bonds) {
        const b = A[j];
        const dx=b.x-a.x, dy=b.y-a.y, d=Math.hypot(dx,dy)||0.01;
        const stretch = d-14;
        if (Math.abs(stretch)>0.01) { const f=BOND_K*stretch/d; a.vx+=dx*f; a.vy+=dy*f; }
        if (d > def.breakDist && Math.random() < def.breakProb*d) toBreak.push([i,j]);
      }

      // Neighbour interactions
      for (const j of nearby(a.x, a.y)) {
        if (j<=i) continue;
        const b  = A[j];
        const dx = b.x-a.x, dy=b.y-a.y;
        const d2 = dx*dx+dy*dy;
        if (d2<1) continue;
        const d = Math.sqrt(d2);

        // Steric repulsion within same type
        if (a.type===b.type && d<15) {
          const f=0.18*(1-d/15)/d;
          a.vx-=dx*f; a.vy-=dy*f; b.vx+=dx*f; b.vy+=dy*f;
        }

        // Bond formation
        if (!BONDS.has(bkey(i,j))) {
          const rule = def.bonds.find(r =>
            (r[0]===a.type&&r[1]===b.type)||(r[0]===b.type&&r[1]===a.type));
          if (rule) {
            const [,, prob, maxA, maxB, minD, maxD] = rule;
            if (d>=minD && d<=maxD && a.bonds.size<maxA && b.bonds.size<maxB && Math.random()<prob)
              addBond(i,j);
          }
        }
      }

      // Damping + speed cap
      a.vx*=0.96; a.vy*=0.96;
      const spd=Math.hypot(a.vx,a.vy); if(spd>3.5){a.vx=a.vx/spd*3.5; a.vy=a.vy/spd*3.5;}
      // Boundary
      a.x+=a.vx; a.y+=a.vy;
      if(a.x<4)  {a.x=4;   a.vx=Math.abs(a.vx);}
      if(a.x>W-4){a.x=W-4; a.vx=-Math.abs(a.vx);}
      if(a.y<4)  {a.y=4;   a.vy=Math.abs(a.vy);}
      if(a.y>H-4){a.y=H-4; a.vy=-Math.abs(a.vy);}
    }
    for (const [i,j] of toBreak) rmBond(i,j);
  }

  // Complexity + tier analysis
  function analyse() {
    const vis  = new Uint8Array(A.length);
    const comps = [];
    for (let i=0; i<A.length; i++) {
      if (vis[i]||A[i].bonds.size===0) continue;
      const comp={nodes:[],bonds:0,typeCount:[0,0,0]};
      const q=[i];
      while(q.length){const c=q.pop();if(vis[c])continue;vis[c]=1;comp.nodes.push(c);comp.typeCount[A[c].type]++;for(const nb of A[c].bonds){comp.bonds++;if(!vis[nb])q.push(nb);}}
      comp.bonds=Math.floor(comp.bonds/2);
      if(comp.nodes.length>=2) comps.push(comp);
    }
    const totalBonded  = comps.reduce((s,c)=>s+c.nodes.length,0);
    const longestChain = comps.length ? Math.max(...comps.map(c=>c.nodes.length)) : 0;
    const branchPoints = A.filter(a=>a.bonds.size>=3).length;
    const mixedComps   = comps.filter(c=>c.typeCount.filter(x=>x>0).length>1).length;
    const N = A.length || 1;

    let cx = 0;
    cx += (totalBonded/N)*2.5;
    cx += Math.min(longestChain/20,1)*2.0;
    cx += Math.min(branchPoints/10,1)*1.5;
    cx += Math.min(mixedComps/5,1)*2.0;
    cx += Math.min(BONDS.size/80,1)*2.0;

    if (cx>peakComplexity){peakComplexity=cx; peakTick=tick;}
    if (hist.length>220) hist.shift();
    hist.push(cx);

    // Tier
    const bl=BONDS.size, lc=longestChain, bp=branchPoints, mc=mixedComps;
    let tier=0;
    if(bl>=3)                              tier=1;
    if(bl>=20  &&mc>=1)                    tier=2;
    if(bl>=50  &&lc>=6 &&mc>=2)            tier=3;
    if(bl>=100 &&lc>=10&&bp>=3)            tier=4;
    if(bl>=180 &&mc>=4 &&bp>=8)            tier=5;
    if(cx>=4.5 &&bl>=250)                  tier=6;
    if(cx>=5.5 &&lc>=18&&bp>=15)           tier=7;
    if(cx>=6.5 &&mc>=8 &&bl>=350)          tier=8;
    if(cx>=7.5 &&bp>=25)                   tier=9;
    if(cx>=8.5 &&mc>=12)                   tier=10;
    if(cx>=9.5 &&bl>=500)                  tier=11;
    if(cx>=10.5&&lc>=30)                   tier=12;
    currentTier = Math.max(currentTier, tier);
    return { cx, tier:currentTier, longestChain, branchPoints, mixedComps, bonds:bl };
  }

  function getSnapshot() {
    const m = analyse();
    return { tick, currentTier, peakComplexity, peakTick,
             complexity:m.cx, bonds:m.bonds, worldStatus:'active', lastUpdated:Date.now() };
  }
  function restoreFrom(s) {
    if (!s||(s.tick||0)<100) return;
    tick=s.tick||0; currentTier=s.currentTier||0;
    peakComplexity=s.peakComplexity||0; peakTick=s.peakTick||0;
  }
  function applyGenome(g) {
    noise = def.noise * (g.noiseScale||1);
    // Particle count changes would need full reset — skip for live reconfig
  }

  return { step, getSnapshot, restoreFrom, applyGenome,
           getTick:()=>tick, getTier:()=>currentTier };
}

// ── Worker coordination ──────────────────────────────────────────────────────

let db           = null;
const WORKER_ID  = Math.random().toString(36).slice(2,12);  // unique per browser tab
let claimedBiomes = [];    // biome IDs this worker currently owns
let workerRef    = null;
const sims       = {};     // biomeId → sim instance
const lastSave   = {};     // biomeId → ms timestamp
let activeViewerIds = new Set();  // biome IDs being directly watched by visitors

// Determine which biomes to claim:
//  - Not claimed by a live (non-stale) other worker
//  - Not being actively viewed by a visitor on the biome page
//  - First MAX_BIOMES_PER_WORKER unclaimed
async function claimBiomes() {
  if (!db) return [];

  const now = Date.now();
  const [workersSnap, presenceSnap] = await Promise.all([
    db.ref('pandora/workers').once('value'),
    db.ref('pandora/presence').once('value'),
  ]);

  const workers  = workersSnap.val()  || {};
  const presence = presenceSnap.val() || {};

  // Build set of biome IDs already covered
  const covered = new Set();

  // — by live workers
  for (const [wid, w] of Object.entries(workers)) {
    if (wid === WORKER_ID) continue;
    if (now - (w.lastHeartbeat||0) < STALE_THRESHOLD_MS) {
      for (const bid of (w.assignedBiomes||[])) covered.add(bid);
    }
  }

  // — by active visitors (page open = direct simulation running there)
  activeViewerIds.clear();
  for (const v of Object.values(presence)) {
    const m = (v.page||'').match(/biome-(\d+)/);
    if (m) { const bid = parseInt(m[1]); covered.add(bid); activeViewerIds.add(bid); }
  }

  // Claim up to MAX_BIOMES_PER_WORKER uncovered biomes
  const available = ALL_BIOME_IDS.filter(id => !covered.has(id));
  const claims    = available.slice(0, MAX_BIOMES_PER_WORKER);

  // Write claim to Firebase
  workerRef = db.ref(`pandora/workers/${WORKER_ID}`);
  await workerRef.set({
    assignedBiomes: claims,
    lastHeartbeat:  now,
    joinedAt:       now,
    biomeCount:     claims.length,
  });
  // Release claims on disconnect
  workerRef.onDisconnect().remove();

  claimedBiomes = claims;
  return claims;
}

// Release a biome if a visitor opens its page while we're running it
function releaseViewedBiomes() {
  claimedBiomes = claimedBiomes.filter(id => !activeViewerIds.has(id));
  if (workerRef) {
    workerRef.update({ assignedBiomes: claimedBiomes, biomeCount: claimedBiomes.length }).catch(()=>{});
  }
}

// Heartbeat — keeps claim alive
function startHeartbeat() {
  setInterval(() => {
    if (workerRef) workerRef.update({ lastHeartbeat: Date.now() }).catch(()=>{});
  }, HEARTBEAT_MS);
}

// Periodically re-evaluate claims (pick up orphaned biomes when workers leave)
function startClaimRefresh() {
  setInterval(async () => {
    if (!db) return;
    const prev = [...claimedBiomes];
    await claimBiomes();
    // Initialise any newly claimed biomes
    for (const bid of claimedBiomes) {
      if (!sims[bid]) await initBiomeSim(bid);
    }
    const gained = claimedBiomes.filter(id => !prev.includes(id));
    const lost   = prev.filter(id => !claimedBiomes.includes(id));
    if (gained.length||lost.length)
      self.postMessage({ type:'claims', claimed:claimedBiomes, gained, lost });
  }, CLAIM_RETRY_MS);
}

// ── Simulation initialisation ────────────────────────────────────────────────

async function initBiomeSim(bid) {
  const def = BIOME_DEFS[String(bid)];
  if (!def) return;

  // Load state + genome from Firebase
  let state  = null;
  let genome = null;
  if (db) {
    try {
      const [stSnap, bmSnap] = await Promise.all([
        db.ref(`pandora/biomes/${String(bid).padStart(2,'0')}/state`).once('value'),
        db.ref(`pandora/biomes/${String(bid).padStart(2,'0')}`).once('value'),
      ]);
      state = stSnap.val();
      const bm = bmSnap.val() || {};
      const curGen = bm.currentGeneration || 1;
      genome = bm.genome ? (bm.genome[curGen] || null) : null;
    } catch(e) {}
  }

  const sim = mkSim(def, genome);
  if (state && state.worldStatus !== 'dead') sim.restoreFrom(state);
  sims[bid] = sim;
  lastSave[bid] = Date.now();
}

// ── Main simulation loop ─────────────────────────────────────────────────────
let lastPost = Date.now();

function startLoop() {
  setInterval(() => {
    const now = Date.now();

    for (const bid of claimedBiomes) {
      const sim = sims[bid];
      if (!sim) continue;
      // Skip if a visitor has opened this biome directly
      if (activeViewerIds.has(bid)) continue;

      for (let i = 0; i < TICK_BATCH; i++) sim.step();

      // Periodic Firebase save
      if (db && now - (lastSave[bid]||0) > SAVE_MS) {
        const snap = sim.getSnapshot();
        const idStr = String(bid).padStart(2,'0');
        db.ref(`pandora/biomes/${idStr}/state`).update(snap).catch(()=>{});
        lastSave[bid] = now;
      }
    }

    // Post stats to main thread
    if (now - lastPost > POST_MS) {
      const stats = {};
      for (const bid of claimedBiomes) {
        if (sims[bid]) stats[bid] = sims[bid].getSnapshot();
      }
      self.postMessage({ type:'stats', stats, claimed:claimedBiomes });
      lastPost = now;
    }
  }, LOOP_HZ);
}

// ── Startup ──────────────────────────────────────────────────────────────────

async function start() {
  try {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FB_CONFIG);
    db = firebase.database();
  } catch(e) {
    console.warn('[Worker] Firebase init failed — running offline:', e);
  }

  // Claim biomes
  const claimed = db ? await claimBiomes() : ALL_BIOME_IDS.slice(0, MAX_BIOMES_PER_WORKER);

  // Initialise simulations for claimed biomes (parallel)
  await Promise.all(claimed.map(bid => initBiomeSim(bid)));

  // Watch presence for live visitors (so we can yield to them)
  if (db) {
    db.ref('pandora/presence').on('value', snap => {
      activeViewerIds.clear();
      if (snap.exists()) {
        snap.forEach(child => {
          const m = (child.val().page||'').match(/biome-(\d+)/);
          if (m) activeViewerIds.add(parseInt(m[1]));
        });
      }
      releaseViewedBiomes();
    });
  }

  startHeartbeat();
  startClaimRefresh();
  startLoop();

  self.postMessage({
    type:    'ready',
    workerId: WORKER_ID,
    claimed,
    total:   ALL_BIOME_IDS.length,
  });
}

self.onmessage = function(e) {
  if (e.data.type === 'start') start();
  if (e.data.type === 'stop') {
    if (workerRef) workerRef.remove().catch(()=>{});
  }
};

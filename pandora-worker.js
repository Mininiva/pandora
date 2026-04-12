/**
 * pandora-worker.js — Pandora Background Simulation Engine
 *
 * Runs as a Web Worker on every visitor's browser (even just the homepage).
 * Advances ALL 6 biome simulations simultaneously using real particle physics.
 * Skips any biome that has an active visitor already simulating it (uses Firebase
 * presence to detect this — no conflicts, visitor page always takes priority).
 * Saves state to Firebase every 90 seconds for each unobserved biome.
 *
 * This means: any visitor to the Pandora homepage contributes CPU cycles to
 * all living worlds, even without opening a single biome page.
 */

'use strict';

// ── Firebase SDK (compat) ──────────────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-database-compat.js');

const FB_CONFIG = {
  apiKey:            'AIzaSyANFCI2Uyehrezru2TxZ8jOP_V9lVSYkGA',
  authDomain:        'pandora-68637.firebaseapp.com',
  databaseURL:       'https://pandora-68637-default-rtdb.firebaseio.com',
  projectId:         'pandora-68637',
  storageBucket:     'pandora-68637.firebasestorage.app',
  messagingSenderId: '244482446708',
  appId:             '1:244482446708:web:7bec4962611f8c4a224821',
};

// ── Simulation constants ────────────────────────────────────────────────────
const W = 900, H = 650;          // simulation space (matches canvas dimensions)
const CELL = 32;                  // spatial hash cell size
const TICK_BATCH = 8;             // physics steps per worker interval
const WORKER_HZ  = 50;            // worker interval (ms) — ~20 batches/s = ~160 ticks/s per biome
const SAVE_EVERY = 90000;         // save to Firebase every 90s (ms)
const POST_EVERY = 1000;          // post stats to main thread every 1s

// ── Biome definitions ────────────────────────────────────────────────────────
// Each biome has: particle types (T0/T1/T2), base counts, bond rules, noise
const BIOME_DEFS = {
  '0': {
    name: 'Terra',
    t: ['AA','LP','PH'],
    n: [185, 100, 28],
    noise: 0.22, T0: 350,
    // Bond rules: [typeA, typeB, prob, maxBondsA, maxBondsB, minDist, maxDist]
    bonds: [
      [0, 0, 0.007, 3, 3, 7, 19],   // AA-AA peptide
      [0, 1, 0.004, 3, 2, 7, 18],   // AA-LP head attachment
      [0, 2, 0.012, 3, 4, 7, 20],   // AA-PH catalysed
      [1, 1, 0.005, 2, 2, 8, 16],   // LP-LP membrane clustering
    ],
    breakDist: 24, breakProb: 0.0008,
  },
  '4': {
    name: 'Warm Soup',
    t: ['AA','LP','PH'],
    n: [170, 80, 25],
    noise: 0.22, T0: 360,
    bonds: [
      [0, 0, 0.008, 3, 3, 7, 19],
      [0, 2, 0.013, 3, 4, 7, 20],
      [1, 1, 0.006, 2, 2, 8, 16],
    ],
    breakDist: 24, breakProb: 0.0008,
  },
  '10': {
    name: 'Siliconia',
    t: ['SI','OX','SC'],
    n: [160, 120, 24],
    noise: 0.28, T0: 900,
    bonds: [
      [0, 1, 0.009, 4, 2, 8, 20],   // Si-O silicate bond
      [0, 0, 0.004, 4, 4, 9, 22],   // Si-Si chain
      [1, 2, 0.006, 2, 3, 7, 18],   // O-catalyst
    ],
    breakDist: 26, breakProb: 0.0007,
  },
  '20': {
    name: 'Freeze Frame',
    t: ['NM','HB','AM'],
    n: [160, 130, 22],
    noise: 0.10, T0: 200,
    bonds: [
      [0, 1, 0.010, 3, 3, 7, 18],   // N-H hydrogen bond
      [0, 0, 0.006, 3, 3, 8, 20],   // N-N covalent
      [1, 2, 0.008, 3, 2, 7, 17],   // H-ammonia
    ],
    breakDist: 23, breakProb: 0.0006,
  },
  '50': {
    name: 'Boronia',
    t: ['BO','NB','WC'],
    n: [150, 130, 25],
    noise: 0.18, T0: 320,
    bonds: [
      [0, 1, 0.009, 3, 3, 7, 19],   // B-N bond
      [0, 0, 0.005, 3, 3, 8, 20],   // B-B
      [1, 2, 0.007, 3, 2, 7, 18],   // N-catalyst
    ],
    breakDist: 24, breakProb: 0.0007,
  },
  '70': {
    name: 'Iron Veil',
    t: ['FE','SU','OW'],
    n: [140, 120, 25],
    noise: 0.20, T0: 400,
    bonds: [
      [0, 1, 0.007, 4, 2, 8, 20],   // Fe-S iron-sulfur
      [0, 0, 0.003, 4, 4, 9, 22],   // Fe-Fe network
      [1, 2, 0.005, 2, 3, 7, 18],   // S-water bridge
    ],
    breakDist: 25, breakProb: 0.0009,
  },
};

// ── Tier thresholds (same as all biome pages) ──────────────────────────────
const TIER_NAMES = [
  'Inert','Molecular Activity','Persistent Structures','Reaction Diversity',
  'Spatial Heterogeneity','Spontaneous Assembly','Sustained Complexity',
  'Coupled Reactions','Emergent Catalysis','Boundary Formation',
  'Closed Compartment','Interior Differentiation','Protocell Stability'
];

// ── Generic particle simulation ──────────────────────────────────────────────

function mkSim(def, genome) {
  const g   = genome || { n1: 1, n2: 1, n3: 1, noiseScale: 1 };
  const ns  = [
    Math.round(def.n[0] * g.n1),
    Math.round(def.n[1] * g.n2),
    Math.round(def.n[2] * g.n3),
  ];
  const noise = def.noise * g.noiseScale;
  const T0    = def.T0;

  const A = [];  // particles
  let uid = 0;
  const BONDS = new Set();
  const bkey  = (i, j) => i < j ? `${i},${j}` : `${j},${i}`;

  // Initialise particles
  for (let t = 0; t < 3; t++) {
    for (let k = 0; k < ns[t]; k++) {
      A.push({
        id: uid++, type: t,
        x: Math.random() * W,
        y: Math.random() * H,
        vx: (Math.random() - 0.5) * 0.8,
        vy: (Math.random() - 0.5) * 0.8,
        bonds: new Set(),
      });
    }
  }

  let tick = 0;
  let currentTier = 0;
  let peakComplexity = 0;
  let peakTick = 0;
  const hist = [];
  const BOND_K = 0.008;

  // ── Spatial hash ───────────────────────────────────────────────
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
        const nb = gh[`${cx+dx},${cy+dy}`];
        if (nb) for (const i of nb) out.push(i);
      }
    return out;
  }

  function addBond(i, j) {
    const k = bkey(i, j); if (BONDS.has(k)) return;
    BONDS.add(k); A[i].bonds.add(j); A[j].bonds.add(i);
  }
  function rmBond(i, j) {
    const k = bkey(i, j); if (!BONDS.has(k)) return;
    BONDS.delete(k); A[i].bonds.delete(j); A[j].bonds.delete(i);
  }

  // ── Physics step ───────────────────────────────────────────────
  function step() {
    tick++;
    buildGrid();
    const toBreak = [];

    // Temperature gradient (hydrothermal vent at bottom)
    const lTemp = (x, y) => T0 * (1 + 0.4 * Math.max(0, 1 - Math.hypot(x - W*0.5, y - H) / (H * 0.6)));

    for (let i = 0; i < A.length; i++) {
      const a = A[i];
      const Tl = lTemp(a.x, a.y);
      const br  = Math.sqrt(Tl / T0) * noise;

      // Brownian motion
      a.vx += (Math.random() - 0.5) * br;
      a.vy += (Math.random() - 0.5) * br;

      // Bond spring forces
      for (const j of a.bonds) {
        const b = A[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d  = Math.hypot(dx, dy) || 0.01;
        const stretch = d - 14;
        if (Math.abs(stretch) > 0.01) {
          const f = BOND_K * stretch / d;
          a.vx += dx * f; a.vy += dy * f;
        }
        // Check for bond break
        if (d > def.breakDist && Math.random() < def.breakProb * d) {
          toBreak.push([i, j]);
        }
      }

      // Neighbour interactions
      for (const j of nearby(a.x, a.y)) {
        if (j <= i) continue;
        const b = A[j];
        const dx = b.x - a.x, dy = b.y - a.y;
        const d2 = dx*dx + dy*dy;
        if (d2 < 1) continue;
        const d = Math.sqrt(d2);

        // Steric repulsion within type
        if (a.type === b.type && d < 15) {
          const f = 0.18 * (1 - d/15) / d;
          a.vx -= dx*f; a.vy -= dy*f;
          b.vx += dx*f; b.vy += dy*f;
        }

        // Bond formation
        const rule = def.bonds.find(r =>
          (r[0] === a.type && r[1] === b.type) ||
          (r[0] === b.type && r[1] === a.type)
        );
        if (rule && !BONDS.has(bkey(i,j))) {
          const [, , prob, maxA, maxB] = rule;
          const minD = rule[5], maxD = rule[6];
          if (d >= minD && d <= maxD &&
              a.bonds.size < maxA && b.bonds.size < maxB &&
              Math.random() < prob) {
            addBond(i, j);
          }
        }
      }

      // Damping + velocity cap
      a.vx *= 0.96; a.vy *= 0.96;
      const spd = Math.hypot(a.vx, a.vy);
      if (spd > 3.5) { a.vx = a.vx/spd*3.5; a.vy = a.vy/spd*3.5; }

      // Boundary
      a.x += a.vx; a.y += a.vy;
      if (a.x < 4)   { a.x = 4;   a.vx = Math.abs(a.vx); }
      if (a.x > W-4) { a.x = W-4; a.vx = -Math.abs(a.vx); }
      if (a.y < 4)   { a.y = 4;   a.vy = Math.abs(a.vy); }
      if (a.y > H-4) { a.y = H-4; a.vy = -Math.abs(a.vy); }
    }

    for (const [i, j] of toBreak) rmBond(i, j);
  }

  // ── Complexity & tier ──────────────────────────────────────────
  function analyse() {
    // Connected component analysis
    const vis = new Uint8Array(A.length);
    const comps = [];
    for (let i = 0; i < A.length; i++) {
      if (vis[i]) continue;
      if (A[i].bonds.size === 0) continue;
      const comp = { nodes: [], bonds: 0, typeCount: [0,0,0] };
      const q = [i];
      while (q.length) {
        const c = q.pop(); if (vis[c]) continue; vis[c] = 1;
        comp.nodes.push(c); comp.typeCount[A[c].type]++;
        for (const nb of A[c].bonds) { comp.bonds++; if (!vis[nb]) q.push(nb); }
      }
      comp.bonds = Math.floor(comp.bonds / 2);
      if (comp.nodes.length >= 2) comps.push(comp);
    }

    const totalBonded   = comps.reduce((s, c) => s + c.nodes.length, 0);
    const longestChain  = comps.length ? Math.max(...comps.map(c => c.nodes.length)) : 0;
    const branchPoints  = A.filter(a => a.bonds.size >= 3).length;
    const mixedComps    = comps.filter(c => c.typeCount.filter(x=>x>0).length > 1).length;
    const totalParticles = A.length;

    // Complexity index: weighted combination of network metrics
    let cx = 0;
    if (totalParticles > 0) {
      cx += (totalBonded / totalParticles) * 2.5;          // fraction bonded
      cx += Math.min(longestChain / 20, 1) * 2.0;          // chain length
      cx += Math.min(branchPoints / 10, 1) * 1.5;          // branching
      cx += Math.min(mixedComps / 5, 1) * 2.0;             // cross-type chemistry
      cx += Math.min(BONDS.size / 80, 1) * 2.0;            // total bond density
    }

    if (cx > peakComplexity) { peakComplexity = cx; peakTick = tick; }
    if (hist.length > 220) hist.shift();
    hist.push(cx);

    // Tier determination
    let tier = 0;
    const bl = BONDS.size, mc = mixedComps, lc = longestChain, bp = branchPoints;
    if (bl >= 3)                                 tier = 1;
    if (bl >= 20  && mc >= 1)                    tier = 2;
    if (bl >= 50  && lc >= 6  && mc >= 2)        tier = 3;
    if (bl >= 100 && lc >= 10 && bp >= 3)        tier = 4;
    if (bl >= 180 && mc >= 4  && bp >= 8)        tier = 5;
    if (cx >= 4.5 && bl >= 250)                  tier = 6;
    if (cx >= 5.5 && lc >= 18 && bp >= 15)       tier = 7;
    if (cx >= 6.5 && mc >= 8  && bl >= 350)      tier = 8;
    if (cx >= 7.5 && bp >= 25)                   tier = 9;
    if (cx >= 8.5 && mc >= 12)                   tier = 10;
    if (cx >= 9.5 && bl >= 500)                  tier = 11;
    if (cx >= 10.5 && lc >= 30)                  tier = 12;
    currentTier = Math.max(currentTier, tier);

    return { cx, tier: currentTier, longestChain, branchPoints, mixedComps, totalBonded, bonds: BONDS.size };
  }

  function getSnapshot() {
    const m = analyse();
    return {
      tick, currentTier, peakComplexity, peakTick,
      complexity: m.cx, bonds: m.bonds,
      longestChain: m.longestChain, branchPoints: m.branchPoints,
      worldStatus: 'active',
      lastUpdated: Date.now(),
    };
  }

  function restoreFrom(state) {
    if (!state || (state.tick || 0) < 100) return;
    tick           = state.tick        || 0;
    currentTier    = state.currentTier || 0;
    peakComplexity = state.peakComplexity || 0;
    peakTick       = state.peakTick    || 0;
  }

  return { step, getSnapshot, restoreFrom, getTick: () => tick, getTier: () => currentTier };
}

// ── Firebase setup ────────────────────────────────────────────────────────────
let db = null;
const sims = {};           // biomeId → simulation instance
const lastSave = {};       // biomeId → timestamp
const activeViewers = {};  // biomeId → count of live viewers (from presence)

function initFirebase() {
  try {
    const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(FB_CONFIG);
    db = firebase.database();

    // Watch presence to detect which biomes are actively being viewed
    db.ref('pandora/presence').on('value', snap => {
      const counts = {};
      if (snap.exists()) {
        snap.forEach(child => {
          const page = child.val().page || '';
          // page is like 'biome-70' or 'index'
          const m = page.match(/biome-(\d+)/);
          if (m) counts[parseInt(m[1])] = (counts[parseInt(m[1])] || 0) + 1;
        });
      }
      Object.assign(activeViewers, counts);
      // Clear biomes no longer actively viewed
      for (const id of Object.keys(activeViewers)) {
        if (!counts[parseInt(id)]) delete activeViewers[id];
      }
    });

    // Load existing state for each biome and initialise simulations
    db.ref('pandora/biomes').once('value').then(snap => {
      const data = snap.val() || {};
      for (const [idStr, def] of Object.entries(BIOME_DEFS)) {
        const id      = parseInt(idStr);
        const biome   = data[idStr] || {};
        const state   = biome.state || null;
        const curGen  = biome.currentGeneration || 1;
        const genome  = biome.genome ? (biome.genome[curGen] || biome.genome) : null;

        const sim = mkSim(def, genome);
        if (state && state.worldStatus !== 'dead') sim.restoreFrom(state);
        sims[id] = sim;
        lastSave[id] = Date.now();
      }
      self.postMessage({ type: 'ready', biomes: Object.keys(sims).map(Number) });
      startLoop();
    }).catch(e => {
      // Firebase failed — still start simulations with default state
      for (const [idStr, def] of Object.entries(BIOME_DEFS)) {
        sims[parseInt(idStr)] = mkSim(def, null);
        lastSave[parseInt(idStr)] = Date.now();
      }
      startLoop();
    });
  } catch(e) {
    console.warn('[Worker] Firebase init failed:', e);
    // Run without persistence
    for (const [idStr, def] of Object.entries(BIOME_DEFS)) {
      sims[parseInt(idStr)] = mkSim(def, null);
      lastSave[parseInt(idStr)] = Date.now();
    }
    startLoop();
  }
}

// ── Main simulation loop ───────────────────────────────────────────────────
let lastPost = Date.now();

function startLoop() {
  setInterval(() => {
    const now = Date.now();

    for (const [id, sim] of Object.entries(sims)) {
      const bid = parseInt(id);
      // Skip if a real visitor is watching this biome — they take priority
      if (activeViewers[bid]) continue;

      // Run a batch of physics steps
      for (let i = 0; i < TICK_BATCH; i++) sim.step();

      // Save to Firebase periodically
      if (db && now - (lastSave[bid] || 0) > SAVE_EVERY) {
        const snapshot = sim.getSnapshot();
        const biomeIdStr = String(bid).padStart(2, '0');
        db.ref(`pandora/biomes/${biomeIdStr}/state`).update(snapshot).catch(() => {});
        lastSave[bid] = now;
      }
    }

    // Post stats to main thread (for live dashboard update)
    if (now - lastPost > POST_EVERY) {
      const stats = {};
      for (const [id, sim] of Object.entries(sims)) {
        stats[id] = sim.getSnapshot();
      }
      self.postMessage({ type: 'stats', stats });
      lastPost = now;
    }
  }, WORKER_HZ);
}

// ── Message handler ──────────────────────────────────────────────────────────
self.onmessage = function(e) {
  const { type } = e.data;
  if (type === 'start') {
    initFirebase();
  }
  if (type === 'stop') {
    // Main thread is unloading — nothing to do, GC handles cleanup
  }
};

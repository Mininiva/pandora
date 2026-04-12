"""
Biome 20 — Freeze Frame
Chemistry: liquid ammonia at 200K.
Agents: NM (nitrogen monomer), HB (hydrogen bridge), AM (ammonia catalyst).

Physics:
  NM–HB bond formation is catalysed by nearby AM atoms (lowers activation energy).
  Temperature gradient: cold settling at bottom, subtle convection.
  Bond breaking is thermally suppressed at 200K (very stable once formed).
"""

from __future__ import annotations
import numpy as np
from .base import PandoraBiomeModel

# ── Particle types ─────────────────────────────────────────────────────────
NM = 0   # nitrogen monomer — chain builder, up to 3 bonds
HB = 1   # hydrogen bridge  — linker, exactly 2 bonds
AM = 2   # ammonia catalyst — no bonds, energises nearby NM

# ── Radii (px) used for rendering ─────────────────────────────────────────
RADII = {NM: 5.5, HB: 4.0, AM: 7.0}


class FreezeFrameModel(PandoraBiomeModel):
    """Mesa ABM for Freeze Frame — liquid-ammonia chemistry at 200K."""

    BIOME_ID  = '20'
    PERIODIC  = True

    N_TYPES   = 3
    TYPE_NAMES = ['NM', 'HB', 'AM']
    MAX_BONDS  = [3, 2, 0]   # NM: 3, HB: 2, AM: none

    # ── Lennard-Jones parameters ───────────────────────────────────────────
    # σ: equilibrium distance (px); ε: well depth (energy)
    # Ammonia at 200K: weak van-der-Waals, strong short-range repulsion
    _WCA_SIGMA = np.array([
        #  NM    HB    AM
        [13.0, 11.0, 15.0],  # NM
        [11.0,  8.0, 12.0],  # HB
        [15.0, 12.0, 18.0],  # AM
    ], dtype=np.float64)

    _WCA_EPS = np.array([
        # NM    HB    AM
        [0.096, 0.068, 0.128],  # NM
        [0.068, 0.048, 0.088],  # HB
        [0.128, 0.088, 0.176],  # AM
    ], dtype=np.float64)

    WCA_CUTOFF_UNUSED   = 48.0
    BOND_FORM_P = 0.006
    BOND_BREAK_P = 3e-5
    BOND_REST   = 16.0
    BOND_K      = 0.05
    BOND_MAX_D  = 96.0

    TEMPERATURE   = 0.35     # very cold — low thermal noise
    THERMOSTAT_NU = 0.012
    DT = 1.0

    # ── Populations ────────────────────────────────────────────────────────
    TARGET_NM =  190
    TARGET_HB =  160
    TARGET_AM =   28
    SPAWN_CELL = 32.0        # proximity grid cell for bond checks

    def __init__(self, width: int = 900, height: int = 650):
        # Assign LJ matrices before super().__init__ calls _compute_forces
        self.WCA_SIGMA   = self._WCA_SIGMA
        self.WCA_EPSILON = self._WCA_EPS

        n = self.TARGET_NM + self.TARGET_HB + self.TARGET_AM
        super().__init__(n_particles=n, width=width, height=height)

    def _init_particles(self):
        idx = 0
        W, H = self.W, self.H
        speed = self.TEMPERATURE * 0.5

        for _ in range(self.TARGET_NM):
            self.pos[idx]   = [np.random.uniform(0, W), np.random.uniform(0, H)]
            self.vel[idx]   = np.random.randn(2) * speed
            self.ptype[idx] = NM
            idx += 1
        for _ in range(self.TARGET_HB):
            self.pos[idx]   = [np.random.uniform(0, W), np.random.uniform(0, H)]
            self.vel[idx]   = np.random.randn(2) * speed
            self.ptype[idx] = HB
            idx += 1
        for _ in range(self.TARGET_AM):
            self.pos[idx]   = [np.random.uniform(0, W), np.random.uniform(0, H)]
            self.vel[idx]   = np.random.randn(2) * speed * 0.8  # AM moves slowly
            self.ptype[idx] = AM
            idx += 1

    def _local_temp(self, y: float) -> float:
        """Temperature gradient: cooler at bottom (cold settling zone)."""
        base = 200.0
        grad = base * (1.0 + 0.15 * (1.0 - y / self.H))
        return float(grad)

    def _update_bonds(self):
        # ── Break over-stretched bonds ─────────────────────────────────────
        snap = [(i, j) for (i, j) in self.bt.bonds
                if self._bond_length(i, j) > self.BOND_MAX_D]
        for (i, j) in snap:
            self.bt.remove(i, j)

        # ── Thermal bond breaking ──────────────────────────────────────────
        thermal_snap = []
        for (i, j) in list(self.bt.bonds):
            y_mid = float((self.pos[i, 1] + self.pos[j, 1]) * 0.5)
            Tl = self._local_temp(y_mid)
            pb = self.BOND_BREAK_P * np.exp(Tl / 300.0)
            if np.random.random() < pb:
                thermal_snap.append((i, j))
        for (i, j) in thermal_snap:
            self.bt.remove(i, j)

        # ── Bond formation (every 3 ticks for perf) ────────────────────────
        if self.tick % 3 != 0:
            return

        pos   = self.pos
        ptype = self.ptype
        cell  = self.SPAWN_CELL

        nm_idx = np.where(ptype == NM)[0]
        hb_idx = np.where(ptype == HB)[0]
        am_idx = np.where(ptype == AM)[0]

        for nm_i in nm_idx:
            if self.bt.count[nm_i] >= self.MAX_BONDS[NM]:
                continue
            nx, ny = pos[nm_i]

            # Find nearby HB atoms
            for hb_j in hb_idx:
                if self.bt.count[hb_j] >= self.MAX_BONDS[HB]:
                    continue
                key = (min(nm_i, hb_j), max(nm_i, hb_j))
                if key in self.bt.bonds:
                    continue

                dx = pos[hb_j, 0] - nx
                dy = pos[hb_j, 1] - ny
                if self.PERIODIC:
                    dx -= self.W * round(dx / self.W)
                    dy -= self.H * round(dy / self.H)
                d = np.sqrt(dx*dx + dy*dy)
                if d > cell:
                    continue

                # Check for nearby AM catalyst
                has_cat = False
                for am_k in am_idx:
                    adx = pos[am_k, 0] - nx
                    ady = pos[am_k, 1] - ny
                    if self.PERIODIC:
                        adx -= self.W * round(adx / self.W)
                        ady -= self.H * round(ady / self.H)
                    if adx*adx + ady*ady < (cell * 1.5) ** 2:
                        has_cat = True
                        break

                y_mid = float((ny + pos[hb_j, 1]) * 0.5)
                Tl = self._local_temp(y_mid)
                p = self.BOND_FORM_P * (3.5 if has_cat else 1.0) * np.exp(-50.0 / Tl)

                if np.random.random() < p:
                    if self.bt.add(nm_i, hb_j):
                        # Bond-formation impulse
                        d_safe = max(d, 0.1)
                        f = 0.15 / d_safe
                        self.vel[nm_i] += np.array([dx, dy]) * f
                        self.vel[hb_j] -= np.array([dx, dy]) * f

    def _spawn(self):
        """Cold inflow from the top edge."""
        nm_count = int(np.sum(self.ptype == NM))
        hb_count = int(np.sum(self.ptype == HB))
        am_count = int(np.sum(self.ptype == AM))

        speed = self.TEMPERATURE * 0.5
        if self.tick % 180 == 0 and nm_count < self.TARGET_NM:
            self._add_particle(NM, speed, from_top=True)
        if self.tick % 240 == 0 and hb_count < self.TARGET_HB:
            self._add_particle(HB, speed, from_top=True)
        if self.tick % 600 == 0 and am_count < self.TARGET_AM:
            self._add_particle(AM, speed * 0.8, from_top=True)

    def _add_particle(self, ptype: int, speed: float, from_top: bool = True):
        """Dynamically grow the particle arrays."""
        x = self.W * 0.5 + (np.random.random() - 0.5) * self.W * 0.15
        y = 2.0 if from_top else self.H - 2.0
        vy = speed * (1.0 + np.random.random())
        vx = (np.random.random() - 0.5) * speed * 0.5

        new_pos  = np.vstack([self.pos,  [[x, y]]])
        new_vel  = np.vstack([self.vel,  [[vx, vy]]])
        new_type = np.append(self.ptype, ptype)
        new_f0   = np.vstack([self.f0,   [[0., 0.]]])
        new_bc   = np.append(self.bt.count, 0)

        self.pos   = new_pos
        self.vel   = new_vel
        self.ptype = new_type
        self.f0    = new_f0
        self.bt.count = new_bc
        self.N += 1

    def _complexity_types(self):
        return {NM, HB}   # AM is catalyst, not counted in components

    def get_state(self) -> dict:
        state = super().get_state()
        state['biome'] = '20'
        state['name']  = 'FREEZE FRAME'
        return state

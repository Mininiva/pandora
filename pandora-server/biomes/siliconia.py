"""Biome 10 — Siliconia. SI (silicon), OX (oxygen bridge), SC (sulfur catalyst). T0=900K, periodic. Si forms tetrahedral networks."""

from __future__ import annotations
import numpy as np
from .base import PandoraBiomeModel

SI = 0   # silicon — tetrahedral network node, max 4 bonds
OX = 1   # oxygen bridge — linker, max 2 bonds
SC = 2   # sulfur catalyst — no bonds


class SiliconiaModel(PandoraBiomeModel):
    BIOME_ID  = '10'
    PERIODIC  = True

    N_TYPES    = 3
    TYPE_NAMES = ['SI', 'OX', 'SC']
    MAX_BONDS  = [4, 2, 0]

    # High temp: sigma larger (thermal expansion), deep wells (strong covalent Si–O)
    _WCA_SIGMA = np.array([
        [16.0, 13.0, 18.0],
        [13.0, 10.0, 14.0],
        [18.0, 14.0, 21.0],
    ], dtype=np.float64)

    _WCA_EPS = np.array([
        [0.144, 0.176, 0.120],   # Si–O: strong covalent
        [0.176, 0.064, 0.104],   # O–O: moderate
        [0.120, 0.104, 0.224],   # SC–SC: catalytic
    ], dtype=np.float64)

    WCA_CUTOFF_UNUSED    = 48.0
    BOND_FORM_P  = 0.004   # lower — needs high temp activation
    BOND_BREAK_P = 8e-6    # very stable Si–O bonds
    BOND_REST    = 14.0
    BOND_K       = 0.06
    BOND_MAX_D   = 96.0
    TEMPERATURE   = 0.85   # hot magmatic
    THERMOSTAT_NU = 0.025
    SPAWN_CELL    = 32.0

    TARGET_SI = 160
    TARGET_OX = 120
    TARGET_SC =  24

    def __init__(self, width: int = 900, height: int = 650):
        self.WCA_SIGMA   = self._WCA_SIGMA
        self.WCA_EPSILON = self._WCA_EPS
        n = self.TARGET_SI + self.TARGET_OX + self.TARGET_SC
        super().__init__(n_particles=n, width=width, height=height)

    def _init_particles(self):
        idx = 0
        for tp, count in [(SI, self.TARGET_SI), (OX, self.TARGET_OX), (SC, self.TARGET_SC)]:
            for _ in range(count):
                self.pos[idx]   = [np.random.uniform(0, self.W), np.random.uniform(0, self.H)]
                self.vel[idx]   = np.random.randn(2) * self.TEMPERATURE * 0.5
                self.ptype[idx] = tp
                idx += 1

    def _local_temp(self, y: float) -> float:
        # Magma vent at bottom-centre
        return 900.0 * (1.0 + 0.50 * max(0.0, y / self.H - 0.5))

    def _update_bonds(self):
        snap = [(i, j) for (i, j) in self.bt.bonds if self._bond_length(i, j) > self.BOND_MAX_D]
        for pair in snap:
            self.bt.remove(*pair)

        for (i, j) in list(self.bt.bonds):
            y_mid = float((self.pos[i, 1] + self.pos[j, 1]) * 0.5)
            Tl = self._local_temp(y_mid)
            if np.random.random() < self.BOND_BREAK_P * np.exp(Tl / 900.0):
                self.bt.remove(i, j)

        if self.tick % 3 != 0:
            return

        si_idx = np.where(self.ptype == SI)[0]
        ox_idx = np.where(self.ptype == OX)[0]
        sc_idx = np.where(self.ptype == SC)[0]
        cell   = self.SPAWN_CELL

        for si_i in si_idx:
            if self.bt.count[si_i] >= self.MAX_BONDS[SI]:
                continue
            for ox_j in ox_idx:
                if self.bt.count[ox_j] >= self.MAX_BONDS[OX]:
                    continue
                key = (min(si_i, ox_j), max(si_i, ox_j))
                if key in self.bt.bonds:
                    continue
                dx = self.pos[ox_j, 0] - self.pos[si_i, 0]
                dy = self.pos[ox_j, 1] - self.pos[si_i, 1]
                dx -= self.W * round(dx / self.W)
                dy -= self.H * round(dy / self.H)
                d = np.sqrt(dx*dx + dy*dy)
                if d > cell:
                    continue

                has_cat = any(
                    (self.pos[k, 0]-self.pos[si_i, 0])**2 + (self.pos[k, 1]-self.pos[si_i, 1])**2 < (cell*1.5)**2
                    for k in sc_idx
                )
                Tl = self._local_temp(float((self.pos[si_i, 1] + self.pos[ox_j, 1]) * 0.5))
                # Si chemistry needs higher thermal activation
                p = self.BOND_FORM_P * (4.0 if has_cat else 1.0) * np.exp(-80.0 / Tl)

                if np.random.random() < p and self.bt.add(si_i, ox_j):
                    f = 0.18 / max(d, 0.1)
                    self.vel[si_i] += np.array([dx, dy]) * f
                    self.vel[ox_j] -= np.array([dx, dy]) * f

    def _spawn(self):
        speed = self.TEMPERATURE * 0.5
        if self.tick % 180 == 0 and np.sum(self.ptype == SI) < self.TARGET_SI:
            self._add_from_bottom(SI, speed)
        if self.tick % 240 == 0 and np.sum(self.ptype == OX) < self.TARGET_OX:
            self._add_from_bottom(OX, speed)
        if self.tick % 600 == 0 and np.sum(self.ptype == SC) < self.TARGET_SC:
            self._add_from_bottom(SC, speed)

    def _add_from_bottom(self, ptype, speed):
        x  = self.W * 0.5 + (np.random.random() - 0.5) * self.W * 0.15
        y  = self.H - 2.0
        vx = (np.random.random() - 0.5) * speed * 0.5
        vy = -(speed * (1.0 + np.random.random()))
        self.pos   = np.vstack([self.pos,   [[x, y]]])
        self.vel   = np.vstack([self.vel,   [[vx, vy]]])
        self.ptype = np.append(self.ptype, ptype)
        self.f0    = np.vstack([self.f0,    [[0., 0.]]])
        self.bt.count = np.append(self.bt.count, 0)
        self.N += 1

    def _complexity_types(self):
        return {SI, OX}

    def get_state(self) -> dict:
        state = super().get_state()
        state['biome'] = '10'
        state['name']  = 'SILICONIA'
        return state

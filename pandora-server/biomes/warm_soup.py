"""Biome 04 — Warm Soup. AA (amino acid) chains, LP (lipid) catalyst marker, PH (phosphate) catalyst. T0=360K, periodic."""

from __future__ import annotations
import numpy as np
from .base import PandoraBiomeModel

AA = 0   # amino acid — linear chains, max 2 bonds
LP = 1   # lipid fragment — no bonding, structural
PH = 2   # phosphate catalyst — energises AA reactions


class WarmSoupModel(PandoraBiomeModel):
    BIOME_ID  = '04'
    PERIODIC  = True

    N_TYPES    = 3
    TYPE_NAMES = ['AA', 'LP', 'PH']
    MAX_BONDS  = [2, 0, 0]   # AA–AA linear chains only

    _WCA_SIGMA = np.array([
        [13.0, 11.0, 15.0],
        [11.0,  9.0, 12.0],
        [15.0, 12.0, 18.0],
    ], dtype=np.float64)

    _WCA_EPS = np.array([
        [0.104, 0.072, 0.136],
        [0.072, 0.052, 0.088],
        [0.136, 0.088, 0.184],
    ], dtype=np.float64)

    WCA_CUTOFF_UNUSED    = 48.0
    BOND_FORM_P  = 0.007
    BOND_BREAK_P = 5e-5
    BOND_REST    = 14.0
    BOND_K       = 0.05
    BOND_MAX_D   = 96.0
    TEMPERATURE   = 0.52
    THERMOSTAT_NU = 0.018
    SPAWN_CELL    = 32.0

    TARGET_AA = 170
    TARGET_LP =  80
    TARGET_PH =  25

    def __init__(self, width: int = 900, height: int = 650):
        self.WCA_SIGMA   = self._WCA_SIGMA
        self.WCA_EPSILON = self._WCA_EPS
        n = self.TARGET_AA + self.TARGET_LP + self.TARGET_PH
        super().__init__(n_particles=n, width=width, height=height)

    def _init_particles(self):
        idx = 0
        for tp, count in [(AA, self.TARGET_AA), (LP, self.TARGET_LP), (PH, self.TARGET_PH)]:
            for _ in range(count):
                self.pos[idx]   = [np.random.uniform(0, self.W), np.random.uniform(0, self.H)]
                self.vel[idx]   = np.random.randn(2) * self.TEMPERATURE * 0.5
                self.ptype[idx] = tp
                idx += 1

    def _local_temp(self, y: float) -> float:
        return 360.0 * (1.0 + 0.40 * max(0.0, y / self.H - (1.0 - 0.38)))

    def _update_bonds(self):
        snap = [(i, j) for (i, j) in self.bt.bonds if self._bond_length(i, j) > self.BOND_MAX_D]
        for pair in snap:
            self.bt.remove(*pair)

        for (i, j) in list(self.bt.bonds):
            y_mid = float((self.pos[i, 1] + self.pos[j, 1]) * 0.5)
            Tl = self._local_temp(y_mid)
            if np.random.random() < self.BOND_BREAK_P * np.exp(Tl / 360.0):
                self.bt.remove(i, j)

        if self.tick % 3 != 0:
            return

        aa_idx = np.where(self.ptype == AA)[0]
        ph_idx = np.where(self.ptype == PH)[0]
        cell = self.SPAWN_CELL

        for i in aa_idx:
            if self.bt.count[i] >= self.MAX_BONDS[AA]:
                continue
            for j in aa_idx:
                if j <= i or self.bt.count[j] >= self.MAX_BONDS[AA]:
                    continue
                if (i, j) in self.bt.bonds:
                    continue
                dx = self.pos[j, 0] - self.pos[i, 0]
                dy = self.pos[j, 1] - self.pos[i, 1]
                if self.PERIODIC:
                    dx -= self.W * round(dx / self.W)
                    dy -= self.H * round(dy / self.H)
                d = np.sqrt(dx*dx + dy*dy)
                if d > cell:
                    continue

                has_cat = any(
                    (self.pos[k, 0]-self.pos[i, 0])**2 + (self.pos[k, 1]-self.pos[i, 1])**2 < (cell*1.5)**2
                    for k in ph_idx
                )
                Tl = self._local_temp(float((self.pos[i, 1] + self.pos[j, 1]) * 0.5))
                p = self.BOND_FORM_P * (3.0 if has_cat else 1.0) * np.exp(-55.0 / Tl)

                if np.random.random() < p and self.bt.add(i, j):
                    f = 0.12 / max(d, 0.1)
                    self.vel[i] += np.array([dx, dy]) * f
                    self.vel[j] -= np.array([dx, dy]) * f

    def _spawn(self):
        speed = self.TEMPERATURE * 0.5
        if self.tick % 180 == 0 and np.sum(self.ptype == AA) < self.TARGET_AA:
            self._add_from_bottom(AA, speed)
        if self.tick % 240 == 0 and np.sum(self.ptype == LP) < self.TARGET_LP:
            self._add_from_bottom(LP, speed)
        if self.tick % 600 == 0 and np.sum(self.ptype == PH) < self.TARGET_PH:
            self._add_from_bottom(PH, speed)

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
        return {AA}

    def get_state(self) -> dict:
        state = super().get_state()
        state['biome'] = '04'
        state['name']  = 'WARM SOUP'
        return state

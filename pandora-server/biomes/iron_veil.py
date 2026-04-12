"""Biome 70 — Iron Veil. FE (iron), SU (sulfur bridge), OW (water/oxygen catalyst). T0=400K, periodic. Iron-sulfur clusters."""

from __future__ import annotations
import numpy as np
from .base import PandoraBiomeModel

FE = 0   # iron — network node, max 4 bonds
SU = 1   # sulfur bridge — linker, max 2 bonds
OW = 2   # water/oxygen catalyst — no bonds


class IronVeilModel(PandoraBiomeModel):
    BIOME_ID  = '70'
    PERIODIC  = True

    N_TYPES    = 3
    TYPE_NAMES = ['FE', 'SU', 'OW']
    MAX_BONDS  = [4, 2, 0]

    _WCA_SIGMA = np.array([
        [15.0, 12.0, 17.0],
        [12.0,  9.0, 13.0],
        [17.0, 13.0, 20.0],
    ], dtype=np.float64)

    _WCA_EPS = np.array([
        [0.128, 0.160, 0.112],   # FE–SU: strong metallic-covalent
        [0.160, 0.056, 0.096],
        [0.112, 0.096, 0.168],
    ], dtype=np.float64)

    WCA_CUTOFF_UNUSED    = 48.0
    BOND_FORM_P  = 0.005
    BOND_BREAK_P = 2e-5
    BOND_REST    = 14.0
    BOND_K       = 0.06
    BOND_MAX_D   = 96.0
    TEMPERATURE   = 0.58
    THERMOSTAT_NU = 0.020
    SPAWN_CELL    = 32.0

    TARGET_FE = 140
    TARGET_SU = 120
    TARGET_OW =  25

    def __init__(self, width: int = 900, height: int = 650):
        self.WCA_SIGMA   = self._WCA_SIGMA
        self.WCA_EPSILON = self._WCA_EPS
        n = self.TARGET_FE + self.TARGET_SU + self.TARGET_OW
        super().__init__(n_particles=n, width=width, height=height)

    def _init_particles(self):
        idx = 0
        for tp, count in [(FE, self.TARGET_FE), (SU, self.TARGET_SU), (OW, self.TARGET_OW)]:
            for _ in range(count):
                self.pos[idx]   = [np.random.uniform(0, self.W), np.random.uniform(0, self.H)]
                self.vel[idx]   = np.random.randn(2) * self.TEMPERATURE * 0.5
                self.ptype[idx] = tp
                idx += 1

    def _local_temp(self, y: float) -> float:
        return 400.0 * (1.0 + 0.45 * max(0.0, y / self.H - (1.0 - 0.45)))

    def _update_bonds(self):
        snap = [(i, j) for (i, j) in self.bt.bonds if self._bond_length(i, j) > self.BOND_MAX_D]
        for pair in snap:
            self.bt.remove(*pair)

        for (i, j) in list(self.bt.bonds):
            Tl = self._local_temp(float((self.pos[i, 1] + self.pos[j, 1]) * 0.5))
            if np.random.random() < self.BOND_BREAK_P * np.exp(Tl / 400.0):
                self.bt.remove(i, j)

        if self.tick % 3 != 0:
            return

        fe_idx = np.where(self.ptype == FE)[0]
        su_idx = np.where(self.ptype == SU)[0]
        ow_idx = np.where(self.ptype == OW)[0]
        cell   = self.SPAWN_CELL

        for fe_i in fe_idx:
            if self.bt.count[fe_i] >= self.MAX_BONDS[FE]:
                continue
            for su_j in su_idx:
                if self.bt.count[su_j] >= self.MAX_BONDS[SU]:
                    continue
                key = (min(fe_i, su_j), max(fe_i, su_j))
                if key in self.bt.bonds:
                    continue
                dx = self.pos[su_j, 0] - self.pos[fe_i, 0]
                dy = self.pos[su_j, 1] - self.pos[fe_i, 1]
                dx -= self.W * round(dx / self.W)
                dy -= self.H * round(dy / self.H)
                d = np.sqrt(dx*dx + dy*dy)
                if d > cell:
                    continue

                has_cat = any(
                    (self.pos[k, 0]-self.pos[fe_i, 0])**2 + (self.pos[k, 1]-self.pos[fe_i, 1])**2 < (cell*1.5)**2
                    for k in ow_idx
                )
                Tl = self._local_temp(float((self.pos[fe_i, 1] + self.pos[su_j, 1]) * 0.5))
                p = self.BOND_FORM_P * (3.5 if has_cat else 1.0) * np.exp(-65.0 / Tl)

                if np.random.random() < p and self.bt.add(fe_i, su_j):
                    f = 0.16 / max(d, 0.1)
                    self.vel[fe_i] += np.array([dx, dy]) * f
                    self.vel[su_j] -= np.array([dx, dy]) * f

    def _spawn(self):
        speed = self.TEMPERATURE * 0.5
        if self.tick % 180 == 0 and np.sum(self.ptype == FE) < self.TARGET_FE:
            self._add_from_bottom(FE, speed)
        if self.tick % 240 == 0 and np.sum(self.ptype == SU) < self.TARGET_SU:
            self._add_from_bottom(SU, speed)
        if self.tick % 600 == 0 and np.sum(self.ptype == OW) < self.TARGET_OW:
            self._add_from_bottom(OW, speed)

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
        return {FE, SU}

    def get_state(self) -> dict:
        state = super().get_state()
        state['biome'] = '70'
        state['name']  = 'IRON VEIL'
        return state

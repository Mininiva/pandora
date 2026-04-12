"""Biome 50 — Boronia. BO (boron), NB (nitrogen bridge), WC (water catalyst). T0=320K, periodic. Trigonal boron networks."""

from __future__ import annotations
import numpy as np
from .base import PandoraBiomeModel

BO = 0   # boron — trigonal node, max 3 bonds
NB = 1   # nitrogen bridge — linker, max 2 bonds
WC = 2   # water catalyst — no bonds


class BoroniaModel(PandoraBiomeModel):
    BIOME_ID  = '50'
    PERIODIC  = True

    N_TYPES    = 3
    TYPE_NAMES = ['BO', 'NB', 'WC']
    MAX_BONDS  = [3, 2, 0]

    _WCA_SIGMA = np.array([
        [12.0, 10.0, 14.0],
        [10.0,  8.0, 11.0],
        [14.0, 11.0, 17.0],
    ], dtype=np.float64)

    _WCA_EPS = np.array([
        [0.088, 0.120, 0.112],   # BO–NB: strong
        [0.120, 0.044, 0.080],
        [0.112, 0.080, 0.160],
    ], dtype=np.float64)

    WCA_CUTOFF_UNUSED    = 48.0
    BOND_FORM_P  = 0.008
    BOND_BREAK_P = 4e-5
    BOND_REST    = 13.0
    BOND_K       = 0.05
    BOND_MAX_D   = 96.0
    TEMPERATURE   = 0.42
    THERMOSTAT_NU = 0.015
    SPAWN_CELL    = 32.0

    TARGET_BO = 150
    TARGET_NB = 130
    TARGET_WC =  25

    def __init__(self, width: int = 900, height: int = 650):
        self.WCA_SIGMA   = self._WCA_SIGMA
        self.WCA_EPSILON = self._WCA_EPS
        n = self.TARGET_BO + self.TARGET_NB + self.TARGET_WC
        super().__init__(n_particles=n, width=width, height=height)

    def _init_particles(self):
        idx = 0
        for tp, count in [(BO, self.TARGET_BO), (NB, self.TARGET_NB), (WC, self.TARGET_WC)]:
            for _ in range(count):
                self.pos[idx]   = [np.random.uniform(0, self.W), np.random.uniform(0, self.H)]
                self.vel[idx]   = np.random.randn(2) * self.TEMPERATURE * 0.5
                self.ptype[idx] = tp
                idx += 1

    def _local_temp(self, y: float) -> float:
        return 320.0 * (1.0 + 0.35 * max(0.0, y / self.H - (1.0 - 0.40)))

    def _update_bonds(self):
        snap = [(i, j) for (i, j) in self.bt.bonds if self._bond_length(i, j) > self.BOND_MAX_D]
        for pair in snap:
            self.bt.remove(*pair)

        for (i, j) in list(self.bt.bonds):
            Tl = self._local_temp(float((self.pos[i, 1] + self.pos[j, 1]) * 0.5))
            if np.random.random() < self.BOND_BREAK_P * np.exp(Tl / 320.0):
                self.bt.remove(i, j)

        if self.tick % 3 != 0:
            return

        bo_idx = np.where(self.ptype == BO)[0]
        nb_idx = np.where(self.ptype == NB)[0]
        wc_idx = np.where(self.ptype == WC)[0]
        cell   = self.SPAWN_CELL

        for bo_i in bo_idx:
            if self.bt.count[bo_i] >= self.MAX_BONDS[BO]:
                continue
            for nb_j in nb_idx:
                if self.bt.count[nb_j] >= self.MAX_BONDS[NB]:
                    continue
                key = (min(bo_i, nb_j), max(bo_i, nb_j))
                if key in self.bt.bonds:
                    continue
                dx = self.pos[nb_j, 0] - self.pos[bo_i, 0]
                dy = self.pos[nb_j, 1] - self.pos[bo_i, 1]
                dx -= self.W * round(dx / self.W)
                dy -= self.H * round(dy / self.H)
                d = np.sqrt(dx*dx + dy*dy)
                if d > cell:
                    continue

                has_cat = any(
                    (self.pos[k, 0]-self.pos[bo_i, 0])**2 + (self.pos[k, 1]-self.pos[bo_i, 1])**2 < (cell*1.5)**2
                    for k in wc_idx
                )
                Tl = self._local_temp(float((self.pos[bo_i, 1] + self.pos[nb_j, 1]) * 0.5))
                p = self.BOND_FORM_P * (3.5 if has_cat else 1.0) * np.exp(-45.0 / Tl)

                if np.random.random() < p and self.bt.add(bo_i, nb_j):
                    f = 0.14 / max(d, 0.1)
                    self.vel[bo_i] += np.array([dx, dy]) * f
                    self.vel[nb_j] -= np.array([dx, dy]) * f

    def _spawn(self):
        speed = self.TEMPERATURE * 0.5
        if self.tick % 180 == 0 and np.sum(self.ptype == BO) < self.TARGET_BO:
            self._add_from_bottom(BO, speed)
        if self.tick % 240 == 0 and np.sum(self.ptype == NB) < self.TARGET_NB:
            self._add_from_bottom(NB, speed)
        if self.tick % 600 == 0 and np.sum(self.ptype == WC) < self.TARGET_WC:
            self._add_from_bottom(WC, speed)

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
        return {BO, NB}

    def get_state(self) -> dict:
        state = super().get_state()
        state['biome'] = '50'
        state['name']  = 'BORONIA'
        return state

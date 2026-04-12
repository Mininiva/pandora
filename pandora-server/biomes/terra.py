"""
Biome 00 — Terra
Chemistry: warm prebiotic surface chemistry at 350K.
Agents: AA (amino acid), LIPID (amphiphilic lipid), PHOS (phosphate catalyst).
Boundaries: REFLECTIVE (terra has walls, not torus).
"""

from __future__ import annotations
import numpy as np
from .base import PandoraBiomeModel

AA    = 0   # amino acid — chain former, up to 3 bonds
LIPID = 1   # amphiphilic lipid — structural, up to 2 bonds
PHOS  = 2   # phosphate catalyst — no bonds, energises nearby AA

TARGET_AA    = 185
TARGET_LIPID = 100
TARGET_PHOS  = 28


class TerraModel(PandoraBiomeModel):
    BIOME_ID  = '00'
    PERIODIC  = False   # REFLECTIVE — terra has walls

    N_TYPES    = 3
    TYPE_NAMES = ['AA', 'LIPID', 'PHOS']
    MAX_BONDS  = [3, 2, 0]

    _WCA_SIGMA = np.array([
        [14.0, 12.0, 16.0],
        [12.0, 10.0, 13.0],
        [16.0, 13.0, 19.0],
    ], dtype=np.float64)

    _WCA_EPS = np.array([
        [0.112, 0.080, 0.144],
        [0.080, 0.056, 0.096],
        [0.144, 0.096, 0.192],
    ], dtype=np.float64)

    WCA_CUTOFF_UNUSED    = 48.0
    BOND_FORM_P  = 0.007
    BOND_BREAK_P = 6e-5
    BOND_REST    = 14.0
    BOND_K       = 0.05
    BOND_MAX_D   = 96.0

    TEMPERATURE   = 0.50   # warmer than Freeze Frame
    THERMOSTAT_NU = 0.018
    SPAWN_CELL    = 32.0
    VENT_H        = 0.38   # thermal vent height fraction

    def __init__(self, width: int = 900, height: int = 650):
        self.WCA_SIGMA   = self._WCA_SIGMA
        self.WCA_EPSILON = self._WCA_EPS
        n = TARGET_AA + TARGET_LIPID + TARGET_PHOS
        super().__init__(n_particles=n, width=width, height=height)

    def _init_particles(self):
        idx = 0
        for tp, count in [(AA, TARGET_AA), (LIPID, TARGET_LIPID), (PHOS, TARGET_PHOS)]:
            for _ in range(count):
                self.pos[idx]   = [np.random.uniform(0, self.W), np.random.uniform(0, self.H)]
                self.vel[idx]   = np.random.randn(2) * self.TEMPERATURE * 0.5
                self.ptype[idx] = tp
                idx += 1

    def _local_temp(self, y: float) -> float:
        base = 350.0
        return base * (1.0 + 0.40 * max(0.0, 1.0 - y / (self.H * self.VENT_H)))

    def _update_bonds(self):
        snap = [(i, j) for (i, j) in self.bt.bonds if self._bond_length(i, j) > self.BOND_MAX_D]
        for (i, j) in snap:
            self.bt.remove(i, j)

        thermal_snap = []
        for (i, j) in list(self.bt.bonds):
            y_mid = float((self.pos[i, 1] + self.pos[j, 1]) * 0.5)
            Tl = self._local_temp(y_mid)
            if np.random.random() < self.BOND_BREAK_P * np.exp(Tl / 350.0):
                thermal_snap.append((i, j))
        for pair in thermal_snap:
            self.bt.remove(*pair)

        if self.tick % 3 != 0:
            return

        pos   = self.pos
        ptype = self.ptype
        cell  = self.SPAWN_CELL
        aa_idx   = np.where(ptype == AA)[0]
        phos_idx = np.where(ptype == PHOS)[0]

        for i in aa_idx:
            if self.bt.count[i] >= self.MAX_BONDS[AA]:
                continue
            for j in aa_idx:
                if j <= i or self.bt.count[j] >= self.MAX_BONDS[AA]:
                    continue
                key = (i, j)
                if key in self.bt.bonds:
                    continue
                dx = pos[j, 0] - pos[i, 0]
                dy = pos[j, 1] - pos[i, 1]
                d = np.sqrt(dx*dx + dy*dy)
                if d > cell:
                    continue

                has_cat = any(
                    (pos[k, 0]-pos[i, 0])**2 + (pos[k, 1]-pos[i, 1])**2 < (cell*1.5)**2
                    for k in phos_idx
                )
                y_mid = float((pos[i, 1] + pos[j, 1]) * 0.5)
                Tl = self._local_temp(y_mid)
                p = self.BOND_FORM_P * (3.0 if has_cat else 1.0) * np.exp(-60.0 / Tl)

                if np.random.random() < p and self.bt.add(i, j):
                    f = 0.12 / max(d, 0.1)
                    self.vel[i] += np.array([dx, dy]) * f
                    self.vel[j] -= np.array([dx, dy]) * f

    def _spawn(self):
        aa_count    = int(np.sum(self.ptype == AA))
        lipid_count = int(np.sum(self.ptype == LIPID))
        phos_count  = int(np.sum(self.ptype == PHOS))
        speed = self.TEMPERATURE * 0.5

        if self.tick % 180 == 0 and aa_count < TARGET_AA:
            self._add_from_bottom(AA, speed)
        if self.tick % 240 == 0 and lipid_count < TARGET_LIPID:
            self._add_from_bottom(LIPID, speed)
        if self.tick % 600 == 0 and phos_count < TARGET_PHOS:
            self._add_from_bottom(PHOS, speed)

    def _add_from_bottom(self, ptype: int, speed: float):
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
        return {AA, LIPID}

    def get_state(self) -> dict:
        state = super().get_state()
        state['biome'] = '00'
        state['name']  = 'TERRA'
        return state

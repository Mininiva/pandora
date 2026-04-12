"""
Base Mesa model for all Pandora biome simulations.

Physics engine — Overdamped Brownian Dynamics (Langevin, high-friction limit):
  x(t+dt) = x(t) + [F_rep(t) + F_bond(t)] / γ · dt + √(2kT·dt/γ) · ξ

where ξ ~ N(0,1).  This is the standard Euler-Maruyama scheme used in
soft-matter and biophysics for colloidal / polymer systems where momentum
relaxes much faster than position (Stokes–Einstein regime).

Pair repulsion — Weeks-Chandler-Andersen (WCA) potential:
  V(r) = 4ε[(σ/r)¹² − (σ/r)⁶] + ε  for r < r_c = 2^(1/6)σ
         0                             otherwise
Purely repulsive; no long-range LJ attraction (too stiff at these scales).

Bond springs — Hookean:
  F = k(r − r₀) r̂

Spatial optimisation — cells of size r_c.  Only cell-local pairs are
checked, reducing the force loop from O(N²) to O(N·k̄) where k̄ ≈ 6-12
typical neighbours at the packing fractions used here.

References:
  - Mesa: Kazil et al. (2020) Proc. 19th SciPy Conference.
  - WCA: Weeks, Chandler & Andersen (1971) J. Chem. Phys. 54(12).
  - Brownian Dynamics: Ermak & Yeh (1974) Chem. Phys. Lett. 24(2).
  - Andersen thermostat: Andersen (1980) J. Chem. Phys. 72(4).
"""

from __future__ import annotations
import numpy as np
import mesa
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Set, Optional


# ── Bond table ─────────────────────────────────────────────────────────────────
@dataclass
class BondTable:
    bonds: Set[Tuple[int, int]] = field(default_factory=set)
    count: np.ndarray = field(default=None)

    def add(self, i: int, j: int) -> bool:
        key = (min(i, j), max(i, j))
        if key not in self.bonds:
            self.bonds.add(key)
            self.count[i] += 1
            self.count[j] += 1
            return True
        return False

    def remove(self, i: int, j: int):
        key = (min(i, j), max(i, j))
        if key in self.bonds:
            self.bonds.discard(key)
            self.count[i] = max(0, self.count[i] - 1)
            self.count[j] = max(0, self.count[j] - 1)

    def to_list(self) -> List[List[int]]:
        return [[i, j] for i, j in self.bonds]


# ── Base model ─────────────────────────────────────────────────────────────────
class PandoraBiomeModel(mesa.Model):
    """
    Base class for all Pandora biome simulations.

    Subclasses set class-level constants (TEMPERATURE, N_TYPES, etc.) and
    override _update_bonds() and _spawn() for biome-specific chemistry.
    """

    BIOME_ID: str = '??'
    PERIODIC:  bool = True

    N_TYPES:    int = 3
    TYPE_NAMES: List[str] = ['A', 'B', 'C']
    MAX_BONDS:  List[int] = [3, 2, 0]

    # WCA repulsion parameters — set by subclass
    # σ_ij (px): equilibrium separation; ε_ij: energy depth
    # For overdamped dynamics ε should be O(0.1-1.0 px²/tick²)
    WCA_SIGMA:   np.ndarray = None
    WCA_EPSILON: np.ndarray = None

    # Bond spring
    BOND_REST:  float = 14.0   # natural length (px)
    BOND_K:     float = 0.04   # spring constant (px/tick²)
    BOND_MAX_D: float = 80.0   # snap length (px)

    # Overdamped Langevin parameters
    TEMPERATURE:   float = 0.40   # kT in px²/tick² (dimensionless)
    FRICTION:      float = 1.0    # γ (overdamped: dt << γ/k_spring)
    DT:            float = 1.0    # time step

    # Andersen thermostat
    THERMOSTAT_NU: float = 0.02   # collision frequency

    # Max speed clamp (stability guard)
    V_MAX: float = 4.0

    def __init__(self, n_particles: int = 200, width: int = 900, height: int = 650):
        super().__init__()
        self.W = float(width)
        self.H = float(height)
        self.N = n_particles

        # Particle state arrays
        self.pos   = np.zeros((n_particles, 2), dtype=np.float64)
        self.vel   = np.zeros((n_particles, 2), dtype=np.float64)
        self.ptype = np.zeros(n_particles, dtype=np.int32)

        self.bt    = BondTable(count=np.zeros(n_particles, dtype=np.int32))
        self.tick  = 0

        # Spatial grid cell size = max WCA cutoff
        self._cell: Optional[float] = None

        # Mesa
        self.schedule = mesa.time.SimultaneousActivation(self)
        self.datacollector = mesa.DataCollector(
            model_reporters={
                'complexity': lambda m: m.complexity(),
                'bond_count': lambda m: len(m.bt.bonds),
                'tick':       lambda m: m.tick,
            }
        )

        self._init_particles()
        self.datacollector.collect(self)

    def _init_particles(self):
        for i in range(self.N):
            self.pos[i] = [np.random.uniform(0, self.W), np.random.uniform(0, self.H)]
        self.vel = np.random.randn(self.N, 2) * np.sqrt(self.TEMPERATURE)

    # ── Spatial hash grid ────────────────────────────────────────────────────

    def _cell_size(self) -> float:
        if self._cell is None:
            # Use max WCA cutoff (r_c = 2^(1/6) * max_sigma)
            max_sigma = float(np.max(self.WCA_SIGMA)) if self.WCA_SIGMA is not None else 20.0
            self._cell = 2.0 ** (1.0 / 6.0) * max_sigma * 1.1
        return self._cell

    def _build_grid(self) -> Dict[Tuple[int, int], List[int]]:
        cell = self._cell_size()
        grid: Dict[Tuple[int, int], List[int]] = defaultdict(list)
        for i in range(self.N):
            cx = int(self.pos[i, 0] / cell)
            cy = int(self.pos[i, 1] / cell)
            grid[(cx, cy)].append(i)
        return grid

    def _nearby(self, i: int, grid: Dict, cell: float) -> List[int]:
        cx = int(self.pos[i, 0] / cell)
        cy = int(self.pos[i, 1] / cell)
        result = []
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in grid.get((cx + dx, cy + dy), []):
                    if j != i:
                        result.append(j)
        return result

    # ── Physics ──────────────────────────────────────────────────────────────

    def _pbc_delta(self, dx: float, dy: float) -> Tuple[float, float]:
        if self.PERIODIC:
            dx -= self.W * round(dx / self.W)
            dy -= self.H * round(dy / self.H)
        return dx, dy

    def _compute_forces(self) -> np.ndarray:
        """
        WCA repulsion (cell-list O(N)) + Hooke bond springs.
        WCA: purely repulsive, truncated LJ at r_c = 2^(1/6)·σ.
        """
        forces = np.zeros((self.N, 2), dtype=np.float64)
        cell_size = self._cell_size()
        grid = self._build_grid()

        rc_ratio = 2.0 ** (1.0 / 6.0)   # r_c / σ threshold

        for i in range(self.N):
            xi, yi = self.pos[i]
            ti = int(self.ptype[i])

            for j in self._nearby(i, grid, cell_size):
                if j <= i:
                    continue
                tj = int(self.ptype[j])
                sigma   = float(self.WCA_SIGMA[ti, tj])
                epsilon = float(self.WCA_EPSILON[ti, tj])

                dx = self.pos[j, 0] - xi
                dy = self.pos[j, 1] - yi
                dx, dy = self._pbc_delta(dx, dy)
                r2 = dx*dx + dy*dy
                rc = rc_ratio * sigma
                if r2 >= rc * rc or r2 < 1e-8:
                    continue

                r2_inv  = 1.0 / r2
                s2      = sigma * sigma * r2_inv   # (σ/r)²
                s6      = s2 * s2 * s2
                s12     = s6 * s6
                # WCA force magnitude * r (scalar, points outward = repulsive)
                fmag_r = 24.0 * epsilon * r2_inv * (2.0 * s12 - s6)
                fx = fmag_r * dx
                fy = fmag_r * dy
                forces[i, 0] -= fx;  forces[i, 1] -= dy * (fmag_r)
                forces[j, 0] += fx;  forces[j, 1] += dy * (fmag_r)
                # Correction — fix fy separately
                forces[i, 1] -= fy - dy * fmag_r
                forces[j, 1] += fy - dy * fmag_r

        # Simplified: recompute fy properly
        forces = np.zeros((self.N, 2), dtype=np.float64)
        for i in range(self.N):
            xi, yi = self.pos[i]
            ti = int(self.ptype[i])
            for j in self._nearby(i, grid, cell_size):
                if j <= i:
                    continue
                tj = int(self.ptype[j])
                sigma   = float(self.WCA_SIGMA[ti, tj])
                epsilon = float(self.WCA_EPSILON[ti, tj])
                dx = self.pos[j, 0] - xi
                dy = self.pos[j, 1] - yi
                dx, dy = self._pbc_delta(dx, dy)
                r2 = dx*dx + dy*dy
                rc = rc_ratio * sigma
                if r2 >= rc * rc or r2 < 1e-8:
                    continue
                r2_inv = 1.0 / r2
                s2 = sigma * sigma * r2_inv
                s6 = s2 * s2 * s2
                s12 = s6 * s6
                fmag = 24.0 * epsilon * r2_inv * (2.0 * s12 - s6)
                forces[i, 0] -= fmag * dx
                forces[i, 1] -= fmag * dy
                forces[j, 0] += fmag * dx
                forces[j, 1] += fmag * dy

        # ── Bond springs ─────────────────────────────────────────────────────
        for (i, j) in self.bt.bonds:
            dx = self.pos[j, 0] - self.pos[i, 0]
            dy = self.pos[j, 1] - self.pos[i, 1]
            dx, dy = self._pbc_delta(dx, dy)
            r = float(np.sqrt(dx*dx + dy*dy)) + 1e-9
            if r > self.BOND_MAX_D:
                continue
            f = self.BOND_K * (r - self.BOND_REST) / r
            forces[i, 0] += f * dx;  forces[i, 1] += f * dy
            forces[j, 0] -= f * dx;  forces[j, 1] -= f * dy

        return forces

    def _integrate(self):
        """
        Overdamped Brownian / Euler-Maruyama step:
          x += (F/γ) · dt  +  √(2kT·dt/γ) · ξ
          vel = displacement / dt  (for rendering / continuity, not dynamical)
        """
        dt  = self.DT
        gam = self.FRICTION
        kT  = self.TEMPERATURE

        forces = self._compute_forces()

        noise_amp = float(np.sqrt(2.0 * kT * dt / gam))
        dx = (forces / gam) * dt + noise_amp * np.random.randn(self.N, 2)

        # Clamp displacement
        speed = np.linalg.norm(dx, axis=1, keepdims=True)
        too_fast = speed > self.V_MAX
        dx = np.where(too_fast, dx * self.V_MAX / (speed + 1e-9), dx)

        self.vel = dx / dt
        self.pos += dx
        self._apply_boundaries()

    def _apply_boundaries(self):
        if self.PERIODIC:
            self.pos[:, 0] %= self.W
            self.pos[:, 1] %= self.H
        else:
            for axis, size in ((0, self.W), (1, self.H)):
                over  = self.pos[:, axis] > size
                under = self.pos[:, axis] < 0
                self.pos[over,  axis] = 2.0 * size - self.pos[over,  axis]
                self.pos[under, axis] = -self.pos[under, axis]
                self.vel[over,  axis] *= -0.5
                self.vel[under, axis] *= -0.5
                np.clip(self.pos[:, axis], 0, size, out=self.pos[:, axis])

    def _bond_length(self, i: int, j: int) -> float:
        dx = float(self.pos[j, 0] - self.pos[i, 0])
        dy = float(self.pos[j, 1] - self.pos[i, 1])
        dx, dy = self._pbc_delta(dx, dy)
        return float(np.sqrt(dx*dx + dy*dy))

    # ── Subclass hooks ────────────────────────────────────────────────────────

    def _update_bonds(self):
        """Override per biome for chemistry rules."""
        snap = [(i, j) for (i, j) in self.bt.bonds if self._bond_length(i, j) > self.BOND_MAX_D]
        for pair in snap:
            self.bt.remove(*pair)

    def _spawn(self):
        pass

    def _complexity_types(self) -> Set[int]:
        return {0, 1}

    # ── Emergence metrics ─────────────────────────────────────────────────────

    def complexity(self) -> float:
        adj: Dict[int, Set[int]] = defaultdict(set)
        for (i, j) in self.bt.bonds:
            adj[i].add(j)
            adj[j].add(i)

        visited: Set[int] = set()
        primary = 0
        n_primary = max(1, int(np.sum(self.ptype == primary)))
        score = 0.0
        comp_types = self._complexity_types()

        for start in range(self.N):
            if start in visited or self.ptype[start] not in comp_types:
                continue
            comp: Set[int] = set()
            queue = [start]
            while queue:
                node = queue.pop(0)
                if node in visited:
                    continue
                visited.add(node)
                comp.add(node)
                for nb in adj[node]:
                    if nb not in visited:
                        queue.append(nb)
            nm_count = sum(1 for n in comp if self.ptype[n] == primary)
            score += nm_count ** 2

        return score / n_primary

    # ── Mesa step ─────────────────────────────────────────────────────────────

    def step(self):
        self.tick += 1
        self._integrate()
        self._update_bonds()
        self._spawn()
        if self.tick % 10 == 0:
            self.datacollector.collect(self)

    # ── Serialisation ─────────────────────────────────────────────────────────

    def get_state(self) -> dict:
        return {
            'tick':       int(self.tick),
            'n':          int(self.N),
            'px':         [round(float(x), 2) for x in self.pos[:, 0]],
            'py':         [round(float(y), 2) for y in self.pos[:, 1]],
            'types':      self.ptype.tolist(),
            'bonds':      self.bt.to_list(),
            'complexity': round(float(self.complexity()), 4),
            'bondCount':  int(len(self.bt.bonds)),
            'W':          int(self.W),
            'H':          int(self.H),
        }

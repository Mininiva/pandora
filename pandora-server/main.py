"""
Pandora Simulation Server
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

FastAPI + WebSocket server hosting Mesa ABM simulations for all 6 Pandora biomes.

Each biome gets its own Mesa model instance. When a browser connects to a biome
WebSocket endpoint, the server runs N simulation steps and streams particle state
at ~15 Hz. The browser renders at 60fps using client-side interpolation.

Architecture:
  - One asyncio task per active biome, runs simulation loop
  - Multiple viewers can connect to the same biome (broadcast)
  - State serialised as JSON with delta compression
  - Deployed to Google Cloud Run (scales to zero when idle)

Endpoints:
  GET  /health              — health check
  WS   /ws/{biome_id}       — WebSocket simulation stream
  GET  /state/{biome_id}    — snapshot REST fallback (for cold reconnects)
"""

from __future__ import annotations
import asyncio
import json
import logging
import os
import time
from typing import Dict, Optional, Set

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from biomes import BIOME_MODELS

# ── Logging ───────────────────────────────────────────────────────────────────
logging.basicConfig(level=logging.INFO,
                    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s')
log = logging.getLogger('pandora')

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI(title='Pandora Simulation Server', version='2.0.0')

app.add_middleware(
    CORSMiddleware,
    allow_origins=['*'],   # Firebase Hosting + local dev
    allow_methods=['*'],
    allow_headers=['*'],
)

# ── Simulation registry ───────────────────────────────────────────────────────
# One active model per biome; created on first connection, persists while any
# viewer is connected, torn down (but NOT archived) when last viewer disconnects.
# Firebase handles canonical state persistence separately.

class BiomeSession:
    """Manages one running biome simulation and its set of connected viewers."""

    STEPS_PER_TICK = 4       # Mesa steps per server tick
    TICK_INTERVAL  = 0.066   # ~15 Hz server → browser

    def __init__(self, biome_id: str, width: int, height: int):
        self.biome_id  = biome_id
        self.viewers:  Set[WebSocket] = set()
        self.model     = BIOME_MODELS[biome_id](width=width, height=height)
        self._task:    Optional[asyncio.Task] = None
        self._running  = False
        log.info(f'Biome {biome_id} session created — {self.model.N} particles')

    def add_viewer(self, ws: WebSocket):
        self.viewers.add(ws)
        if not self._running:
            self._task = asyncio.create_task(self._loop())

    def remove_viewer(self, ws: WebSocket):
        self.viewers.discard(ws)

    @property
    def alive(self) -> bool:
        return bool(self.viewers)

    async def _loop(self):
        self._running = True
        log.info(f'Biome {self.biome_id}: simulation loop started')
        try:
            while self.viewers:
                t0 = time.monotonic()

                # Run simulation steps (synchronous CPU work)
                for _ in range(self.STEPS_PER_TICK):
                    self.model.step()

                # Serialise state
                state = self.model.get_state()
                msg   = json.dumps(state)

                # Broadcast to all connected viewers
                dead: list[WebSocket] = []
                for ws in list(self.viewers):
                    try:
                        await ws.send_text(msg)
                    except Exception:
                        dead.append(ws)
                for ws in dead:
                    self.viewers.discard(ws)

                # Pace to ~15 Hz
                elapsed = time.monotonic() - t0
                sleep   = max(0.0, self.TICK_INTERVAL - elapsed)
                await asyncio.sleep(sleep)

        except asyncio.CancelledError:
            pass
        finally:
            self._running = False
            log.info(f'Biome {self.biome_id}: simulation loop stopped')


# Global session registry
_sessions: Dict[str, BiomeSession] = {}
_sessions_lock = asyncio.Lock()


async def get_or_create_session(biome_id: str, width: int, height: int) -> BiomeSession:
    async with _sessions_lock:
        if biome_id not in _sessions or not _sessions[biome_id].alive:
            _sessions[biome_id] = BiomeSession(biome_id, width, height)
        return _sessions[biome_id]


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get('/health')
async def health():
    active = {bid: len(s.viewers) for bid, s in _sessions.items() if s.alive}
    return {'status': 'ok', 'active_biomes': active}


@app.get('/state/{biome_id}')
async def snapshot(biome_id: str, w: int = 900, h: int = 650):
    """REST fallback — returns one state snapshot without opening a WebSocket."""
    if biome_id not in BIOME_MODELS:
        return {'error': f'unknown biome {biome_id}'}
    session = await get_or_create_session(biome_id, w, h)
    return session.model.get_state()


@app.websocket('/ws/{biome_id}')
async def ws_biome(websocket: WebSocket, biome_id: str,
                   w: int = 900, h: int = 650):
    """
    WebSocket endpoint for a biome simulation stream.

    Query params:
      w, h — canvas dimensions (default 900×650)

    Protocol:
      Client → Server: JSON commands  {"cmd": "ping"} | {"cmd": "resize", "w": N, "h": N}
      Server → Client: JSON state     {tick, n, px[], py[], types[], bonds[], complexity, bondCount, W, H}
    """
    if biome_id not in BIOME_MODELS:
        await websocket.close(code=4004, reason=f'unknown biome {biome_id}')
        return

    await websocket.accept()
    log.info(f'Biome {biome_id}: viewer connected (canvas {w}×{h})')

    session = await get_or_create_session(biome_id, w, h)
    session.add_viewer(websocket)

    # Send welcome / initial state immediately
    await websocket.send_text(json.dumps({
        **session.model.get_state(),
        'event': 'connected',
        'biome': biome_id,
    }))

    try:
        # Keep connection alive; handle incoming client commands
        while True:
            try:
                raw = await asyncio.wait_for(websocket.receive_text(), timeout=30.0)
                cmd = json.loads(raw)
                if cmd.get('cmd') == 'ping':
                    await websocket.send_text(json.dumps({'event': 'pong', 'tick': session.model.tick}))
            except asyncio.TimeoutError:
                # Send a keepalive ping
                await websocket.send_text(json.dumps({'event': 'keepalive'}))
            except (json.JSONDecodeError, KeyError):
                pass

    except WebSocketDisconnect:
        log.info(f'Biome {biome_id}: viewer disconnected')
    finally:
        session.remove_viewer(websocket)


# ── Entry point ───────────────────────────────────────────────────────────────
if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8080))
    uvicorn.run('main:app', host='0.0.0.0', port=port,
                log_level='info', ws_ping_interval=20, ws_ping_timeout=30)

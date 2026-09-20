# Fly Invaders: brain <-> game wire protocol (v1)

Two processes:

* `brain/` (Python, uv): the reconstructed fly-brain simulator extracted from DOOMFLY.
  Serves a WebSocket at `ws://127.0.0.1:8766/ws` plus `GET /health` and `GET /state`.
* `web/` (Vite + React + Phaser): the Space Invaders environment **and** the fly-brain
  spectator UI in one page. The browser is the *environment client*: it renders the game,
  captures the canvas pixels, sends them to the brain, and applies the returned action.

The loop is **lockstep**. The game does not advance a tick until the brain has returned an
action for the current frame. Neural time and game time stay aligned exactly as in DOOMFLY:
for game tick `t` at `fps` Hz, the brain has integrated `round(t * 10000 / fps)` steps of 0.1 ms.
Only pixels enter the brain. Game state (score, alien positions) is telemetry/reward only and
never selects actions.

## Roles

The first connected client that sends `hello` with `role: "env"` becomes the environment.
Any other client (`role: "spectator"`, e.g. a future LLM observer) receives `welcome`, `status`
and telemetry-bearing `action` messages but cannot send frames.

## Client -> server

```jsonc
{ "type": "hello", "protocol": 1, "role": "env" | "spectator",
  "env": "empty" | "invaders",          // which scene is running
  "width": 160, "height": 120,          // dimensions of every frame that follows
  "fps": 60 }                           // game ticks per game-second

{ "type": "frame",
  "tick": 1,                            // 1-based, +1 every frame, never skips
  "pixels": "<base64 of width*height*3 RGB8 bytes, row-major, top-left first>",
  "game": { "round": 1, "tick": 0, "score": 0, "lives": 3, "aliens": 0,
            "finished": false, "ship_x": 0.5 },   // pre-action state, telemetry only
  "reward": 0.0,                        // reward earned by the PREVIOUS action (e.g. +1 alien killed)
  "ended": { "round": 1, "ticks": 812, "score": 120, "lives": 0 } // optional: previous round just ended
}
```

`pixels` is the game canvas downscaled to `width x height` by the browser (drawImage).
The browser normally sends the frame as a **binary** WebSocket message instead of JSON:
`uint32 LE header length` + UTF-8 JSON of the frame object without `pixels` + raw RGB8 bytes.
The server accepts both forms.
160x120 is the default. The server samples luminance at the retinal UV coordinates itself.

## Server -> client

```jsonc
{ "type": "status", "status": "loading" | "ready" | "running" | "error",
  "message": "loading graph", "progress": 0.4 }

{ "type": "welcome", "protocol": 1, "run_id": "uuid", "decoder": "bci", "phase": "baseline",
  "manifest": { "neurons": 166700, "edges": 25582938, "synaptic_contacts": 0,
                "retina_mapped": 3335, "retina_total": 3377, "retina_unmapped": 42,
                "uncertain_sign_neurons": 3718, "dataset": "malecns_v1", "synthetic": false },
  "readouts": [ { "index": 0, "id": "12345", "type": "DNp20", "side": "R" } ],
  "retina": { "uv": [[0.1, 0.2]], "side": ["L"], "neuron_ids": ["..."],
              "full_sample_count": 3335, "display_stride": 8 },   // strided sample
  "raster_ids": ["..."],                 // fixed display neurons for the raster (<=128)
  "populations": ["ol_intrinsic", "cb_intrinsic", "descending_neuron", "..."],
  "protocol_info": { "dt_ms": 0.1, "lamina_bias_mv": 12, "retinal_gain_mv": 30,
                     "photoreceptor_half_saturation": 0.02, "seed": 41027,
                     "model": "lif-r2-refractory-write-protection" } }

{ "type": "action", "tick": 1,
  "move": -0.35,                        // [-1, 1]; negative = left, positive = right
  "fire": false,                        // true when a DNpe017 spike occurred this tick
  "move_raw": -0.05, "move_bias": 0.30, // optional: decoder output before centering, and the subtracted slow bias
  "neural_ms": 16.7, "steps": 167,      // 0.1 ms steps integrated for this tick
  "readouts": [ { "index": 0, "id": "...", "type": "DNp20", "side": "R", "spikes": 1, "rate_hz": 12.4 } ],
  "telemetry": null | Telemetry }       // present at most ~8 times per wall second
```

### Decoder (fixed BCI, mirrors DOOMFLY; engineering mapping, not biology)

* `move = clip((rate(DNp20, R) - rate(DNp20, L)) * 0.02, -1, 1)` using the same 100 ms
  exponential rate filter as DOOMFLY `NeuralControls`.
* `fire = any DNpe017 spike in this tick`.
* Adaptive centering (default on, `--no-centering` to disable): a 3 s running mean of the raw
  left/right drive is subtracted so a constant wiring bias does not park the ship at a wall.
  Automatic gain (`--agc`) then divides by the drive's running amplitude. Rates use a 250 ms
  filter (`--rate-tau`). Fire defaults to `burst`: a DNpe017 spike only fires while the cell's
  rate is above its own running mean; the game additionally allows one player bullet on screen.
* `--decoder biological` keeps the DNa02 (move) / MN9 (fire) comparison.
* Reward (`frame.reward > 0`) may schedule a 200 ms LB3c "sugar" pulse when the server runs
  with `--reward sugar`. Off by default. No plasticity in phase 1.

### Telemetry

```jsonc
{ "sequence": 12, "generated_at_ms": 1700000000000,
  "clocks": { "wall_seconds": 3.2, "neural_seconds": 1.1, "game_seconds": 1.1,
              "speed": 0.34, "brain_step_ms": 41.2 },
  "game": { ...last frame.game... }, "episodes": [ {"round":1,"ticks":812,"score":120,"lives":0} ],
  "action": { "move": 0.1, "fire": false }, "readouts": [ ...as in action... ],
  "total_spikes": 123456, "window_spikes": 812, "window_ms": 125.0, "total_action_ticks": 40,
  "populations": [ { "name": "ol_intrinsic", "neurons": 40000, "spikes": 300, "mean_rate_hz": 0.06 } ],
  "regions": [ { "name": "ol_intrinsic", "side": "L", "neurons": 20000, "spikes": 150, "mean_rate_hz": 0.06 } ],
                                        // optional: populations split by hemisphere (L, R, M, ?)
  "retina": { "luminance": [..], "filtered_luminance": [..], "drive_mv": [..], "spikes_last_step": [..] },
                                        // all strided by display_stride, aligned with welcome.retina.uv
  "raster_bin": { "neural_ms": 1100.0, "window_ms": 125.0, "counts": [..], "population_spikes": 812 },
                                        // one bin per telemetry; client keeps the last 160
  "timeline": [ { "tick": 66, "spikes": 40, "move": 0.1, "fire": false } ],   // last <=50 ticks
  "neuron_voltage_mv": { "<readout id>": -51.2 },
  "reward": { "mode": "off" | "sugar", "sugar_pulses": 0, "active": false, "plasticity": false },
  }
```

## HTTP

* `GET /health` -> `{ "status", "run_id", "sequence", "generated_at_ms" }`
* `GET /state`  -> the latest full telemetry (for audit tools and the future LLM observer)

## Phase 1 scope

* `env: "empty"`: the browser streams a blank (starfield-free, black) canvas. The brain runs,
  the UI shows retina / raster / readouts / populations / clocks. Actions are decoded and
  displayed but move nothing.
* `env: "invaders"`: the ported Space Invaders scene, stepped in lockstep, controlled by `move`
  and `fire`. Selectable from the UI; the game code is complete in phase 1 even though the
  default scene is `empty`.

## Demo scope note

This is a demo, not a research artifact. Skip DOOMFLY's audit logs, checkpoints, provenance
hashes and validation gates. Keep the simulator faithful (same graph, same LIF kernel, same
retina sampling, same decoder idea) but keep everything around it small.

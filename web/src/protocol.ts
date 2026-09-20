/** Wire types shared by the game bridge and the brain UI. See ../../PROTOCOL.md */

export type EnvName = 'empty' | 'invaders';

export interface GameState {
  round: number;
  tick: number;
  score: number;
  lives: number;
  aliens: number;
  finished: boolean;
  ship_x?: number;
}

export interface RoundSummary {
  round: number;
  ticks: number;
  score: number;
  lives: number;
}

export interface HelloMessage {
  type: 'hello';
  protocol: 1;
  role: 'env' | 'spectator';
  env: EnvName;
  width: number;
  height: number;
  fps: number;
}

export interface FrameMessage {
  type: 'frame';
  tick: number;
  /**
   * RGB8, width*height*3 bytes. A string is base64 inside a JSON text message; a Uint8Array is
   * sent as a binary WebSocket message: uint32 LE header length, UTF-8 JSON header (this object
   * without `pixels`), then the raw bytes.
   */
  pixels: string | Uint8Array;
  game: GameState;
  reward: number;
  ended?: RoundSummary;
}

export type ClientMessage = HelloMessage | FrameMessage;

export interface ReadoutInfo {
  index: number;
  id: string;
  type: string;
  side: string;
}

export interface Readout extends ReadoutInfo {
  spikes: number;
  rate_hz: number;
}

export interface StatusMessage {
  type: 'status';
  status: 'loading' | 'ready' | 'running' | 'error';
  message?: string;
  progress?: number;
}

export interface WelcomeMessage {
  type: 'welcome';
  protocol: 1;
  run_id: string;
  decoder: string;
  phase: string;
  manifest: {
    neurons: number;
    edges: number;
    synaptic_contacts: number;
    retina_mapped: number;
    retina_total: number;
    retina_unmapped: number;
    uncertain_sign_neurons: number;
    dataset: string;
    synthetic: boolean;
  };
  readouts: ReadoutInfo[];
  retina: {
    uv: [number, number][];
    side: string[];
    neuron_ids: string[];
    full_sample_count: number;
    display_stride: number;
  };
  raster_ids: string[];
  /** Population (superclass) of each raster row, aligned with raster_ids. */
  raster_groups: string[];
  populations: string[];
  protocol_info: {
    dt_ms: number;
    lamina_bias_mv: number;
    retinal_gain_mv: number;
    photoreceptor_half_saturation: number;
    seed: number;
    model: string;
  };
}

export interface RasterBin {
  neural_ms: number;
  window_ms: number;
  counts: number[];
  population_spikes: number;
}

export interface TimelineEntry {
  tick: number;
  spikes: number;
  move: number;
  fire: boolean;
}

/** Spike activity of one (superclass, side) group; sides are L, R, M (midline) or ? (unknown). */
export interface RegionActivity {
  name: string;
  side: 'L' | 'R' | 'M' | '?';
  neurons: number;
  spikes: number;
  mean_rate_hz: number;
}

export interface Telemetry {
  sequence: number;
  generated_at_ms: number;
  clocks: {
    wall_seconds: number;
    neural_seconds: number;
    game_seconds: number;
    speed: number;
    brain_step_ms: number;
  };
  game: GameState;
  episodes: RoundSummary[];
  action: { move: number; fire: boolean };
  readouts: Readout[];
  total_spikes: number;
  window_spikes: number;
  window_ms: number;
  total_action_ticks: number;
  populations: { name: string; neurons: number; spikes: number; mean_rate_hz: number }[];
  /** Same window as populations, split by hemisphere. Present when the graph has side annotations. */
  regions?: RegionActivity[];
  retina: {
    luminance: number[];
    filtered_luminance: number[];
    drive_mv: number[];
    spikes_last_step: number[];
  };
  raster_bin: RasterBin;
  timeline: TimelineEntry[];
  neuron_voltage_mv: Record<string, number>;
  reward: { mode: string; sugar_pulses: number; active: boolean; plasticity: boolean };
}

export interface ActionMessage {
  type: 'action';
  tick: number;
  move: number;
  fire: boolean;
  /** Decoder output before adaptive centering, and the slow bias that was subtracted. */
  move_raw?: number;
  move_bias?: number;
  neural_ms: number;
  steps: number;
  readouts: Readout[];
  telemetry: Telemetry | null;
}

/** Which role this connection currently has. The newest env hello takes over driving. */
export interface RoleMessage {
  type: 'role';
  role: 'env' | 'spectator';
}

export type ServerMessage = StatusMessage | WelcomeMessage | ActionMessage | RoleMessage;

export const BRAIN_WS_URL = 'ws://127.0.0.1:8766/ws';
export const FRAME_WIDTH = 160;
export const FRAME_HEIGHT = 120;
export const GAME_FPS = 60;

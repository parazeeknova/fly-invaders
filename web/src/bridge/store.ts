/**
 * Tiny external store holding the latest brain state for the React UI.
 * Written by client.ts, read via useBrain().
 */
import { useSyncExternalStore } from 'react';
import type {
  ActionMessage,
  RasterBin,
  StatusMessage,
  Telemetry,
  WelcomeMessage,
} from '../protocol';
import type { ConnectionState } from './client';

export const RASTER_HISTORY = 160;

export interface BrainState {
  connection: ConnectionState;
  /** Our role on the brain: driving the environment, or watching another tab drive. */
  role: 'env' | 'spectator' | null;
  status: StatusMessage | null;
  welcome: WelcomeMessage | null;
  lastAction: ActionMessage | null;
  telemetry: Telemetry | null;
  rasterBins: RasterBin[];
}

const initial: BrainState = {
  connection: 'disconnected',
  role: null,
  status: null,
  welcome: null,
  lastAction: null,
  telemetry: null,
  rasterBins: [],
};

let state: BrainState = initial;
const listeners = new Set<() => void>();

function emit(next: BrainState) {
  state = next;
  for (const listener of listeners) listener();
}

export const store = {
  get: () => state,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setConnection(connection: ConnectionState) {
    // A dropped socket invalidates the run: the next welcome starts a fresh one.
    if (connection !== 'open') emit({ ...state, connection, role: null, welcome: null, telemetry: null, lastAction: null, rasterBins: [] });
    else emit({ ...state, connection });
  },
  onRole(role: 'env' | 'spectator') {
    emit({ ...state, role });
  },
  onStatus(status: StatusMessage) {
    emit({ ...state, status });
  },
  onWelcome(welcome: WelcomeMessage) {
    // A new run: drop history that belonged to the previous run.
    emit({ ...state, welcome, rasterBins: [], telemetry: null, lastAction: null });
  },
  onAction(action: ActionMessage) {
    if (action.telemetry) {
      const bins = [...state.rasterBins, action.telemetry.raster_bin].slice(-RASTER_HISTORY);
      emit({ ...state, lastAction: action, telemetry: action.telemetry, rasterBins: bins });
    } else {
      emit({ ...state, lastAction: action });
    }
  },
  reset() {
    emit(initial);
  },
};

export function useBrain(): BrainState {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

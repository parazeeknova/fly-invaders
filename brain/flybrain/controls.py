"""Fixed readout decoder for Space Invaders. Engineering mapping, not biology.

bci (default):  move = clip((rate(DNp20,R) - rate(DNp20,L)) * move_gain, -1, 1); fire from DNpe017.
biological:     move = clip((rate(DNa02,R) - rate(DNa02,L)) * move_gain/2, -1, 1); fire from MN9.
Fire modes: 'spike' = any spike of the fire cells this tick (DOOMFLY); 'burst' (default) = a spike
while the cells' filtered rate is above their own slow running mean, so tonic firing does not
become a machine gun and firing follows *changes* in visual drive.
Rates use the same 100 ms exponential filter as DOOMFLY NeuralControls.
Centering (on by default) subtracts a slow (3 s) running mean of the left/right
difference, so a constant wiring bias does not park the ship against a wall and the
fly steers on *changes* in its visual input. It is a decoder choice, not biology.
"""
import math
import numpy as np


class NeuralControls:
    def __init__(self, readouts, mode='bci', centering=True, centering_tau=3.0, move_gain=0.06, fire_mode='burst', rate_tau=0.25, agc=True):
        if mode not in ['biological', 'bci']: raise ValueError('Unknown neural decoder')
        if fire_mode not in ['spike', 'burst']: raise ValueError('Unknown fire mode')
        self.mode = mode
        self.move_gain = move_gain
        self.fire_mode = fire_mode
        self.fire_bias = 0.0  # slow running mean of the fire cells' rate
        self.rate_tau = rate_tau  # rate filter (DOOMFLY used 0.1 s; slower = sustained sweeps instead of jitter)
        self.agc = agc
        self.power = 0.0  # running mean square of the centered drive, for automatic gain
        self.readouts = readouts
        self.rates = np.zeros(len(readouts))
        self.centering = centering
        self.centering_tau = centering_tau
        self.bias = 0.0  # slow running mean of the raw left/right drive

    def rate(self, typ, side=None):
        return sum(float(x) for x, r in zip(self.rates, self.readouts) if r['type'] == typ and (side is None or r['side'] == side))

    def spiked(self, counts, typ):
        return any(counts[r['index']] > 0 for r in self.readouts if r['type'] == typ)

    def decode(self, counts, seconds):
        """Update filtered rates with this tick's spike counts and return the action dict."""
        if seconds <= 0: raise ValueError('Positive time required')
        raw = np.asarray([counts[r['index']] / seconds for r in self.readouts])
        decay = math.exp(-seconds / self.rate_tau)
        self.rates = self.rates * decay + raw * (1 - decay)
        turn_type, fire_type, gain = ('DNp20', 'DNpe017', self.move_gain) if self.mode == 'bci' else ('DNa02', 'MN9', self.move_gain / 2)
        raw_move = (self.rate(turn_type, 'R') - self.rate(turn_type, 'L')) * gain
        slow = math.exp(-seconds / self.centering_tau)
        fire_rate = self.rate(fire_type)
        self.fire_bias = self.fire_bias * slow + fire_rate * (1 - slow)
        spiked = self.spiked(counts, fire_type)
        fire = spiked if self.fire_mode == 'spike' else (spiked and fire_rate > self.fire_bias * 1.1 + 0.5)
        move = raw_move
        if self.centering:
            self.bias = self.bias * slow + raw_move * (1 - slow)
            move = raw_move - self.bias
        if self.agc:
            # Normalise by the signal's own recent amplitude so the ship uses its full speed range
            # whatever the absolute rate difference is. Still a fixed function of the spikes.
            self.power = self.power * slow + move * move * (1 - slow)
            move = move / (1.5 * math.sqrt(self.power) + 1e-3)
        return {'move': float(np.clip(move, -1, 1)), 'fire': bool(fire), 'move_raw': float(raw_move), 'move_bias': float(self.bias),
                'readouts': [{**r, 'spikes': int(counts[r['index']]), 'rate_hz': round(float(x), 3)} for r, x in zip(self.readouts, self.rates)]}

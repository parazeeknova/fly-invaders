"""Artificial sugar input: positive reward schedules 200 ms of LB3c current. No plasticity."""


class SugarReinforcement:
    def __init__(self, enabled=False):
        self.enabled = enabled
        self.until_ms = 0.0
        self.pulses = 0

    def observe(self, reward, neural_ms):
        if self.enabled and reward > 0:
            self.until_ms = max(self.until_ms, neural_ms + 200)
            self.pulses += 1

    def active(self, neural_ms):
        return bool(self.enabled and neural_ms < self.until_ms)

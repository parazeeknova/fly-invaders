import { useBrain } from '../bridge/store';
import { PixelIcon } from './PixelIcon';
import { num } from './shared';

/** Collapsible explainer: pixels -> photoreceptors -> neurons -> descending neurons -> buttons. */
export function HowItWorks() {
  const { welcome } = useBrain();
  const m = welcome?.manifest;
  const p = welcome?.protocol_info;
  const receptors = m ? num(m.retina_mapped) : '3,335';
  const neurons = m ? num(m.neurons) : '166,700';
  const edges = m ? num(m.edges) : '25,582,938';
  const dataset = m?.dataset ?? 'MaleCNS v1.0';
  const bio = welcome?.decoder === 'biological';

  return (
    <details className="disclosure how-it-works">
      <summary>
        <span>
          <PixelIcon name="code" /> HOW IT WORKS
        </span>
        <span className="summary-end">
          <span>PIXELS → NEURONS → BUTTONS</span>
          <PixelIcon name="plus" />
        </span>
      </summary>
      <ol className="how-steps">
        <li>
          <b>01 PIXELS.</b> The browser draws Space Invaders, downsamples the canvas to 160 × 120 RGB and
          sends it to the brain every game tick. The game waits for the answer: the loop is lockstep.
        </li>
        <li>
          <b>02 PHOTORECEPTORS.</b> {receptors} R1–R6 photoreceptor positions are sampled from the frame.
          sRGB is linearised to luminance, low-passed with a 10 ms filter and converted into an input
          current (gain {p ? p.retinal_gain_mv : 30} mV, half-saturation {p ? p.photoreceptor_half_saturation : 0.02}).
        </li>
        <li>
          <b>03 NEURONS.</b> {neurons} leaky integrate-and-fire neurons wired by {edges} connections from
          the {dataset} connectome integrate in {p ? p.dt_ms : 0.1} ms steps. A voltage crossing threshold is a spike.
          Optic lobe → visual projection → central brain → descending neurons.
        </li>
        <li>
          <b>04 DESCENDING NEURONS.</b> A fixed decoder reads two descending cell types:{' '}
          {bio ? 'DNa02' : 'DNp20'} right − left rate (100 ms filter, × 0.02) sets ship velocity in [−1, 1];
          any {bio ? 'MN9' : 'DNpe017'} spike in a tick fires.
        </li>
        <li>
          <b>05 BUTTONS.</b> The game applies move and fire, advances one tick and sends the next frame.
          Score, lives and alien positions are telemetry only. They never enter the brain.
        </li>
        <li>
          <b>06 CLOCKS.</b> Neural time is exact: tick <i>t</i> at 60 fps means round(t × 10000 / 60) steps
          integrated. Speed is neural seconds per wall second; below 1× the game slows to wait for the brain.
        </li>
        <li>
          <b>07 WHAT THE PLOTS SHOW.</b> Retina: sample positions shaded by signal, both eyes overlapping.
          Brain map: regions shaded by mean rate per cell (log scale), readout cells flash on a spike.
          Raster (collapsed): {welcome ? welcome.raster_ids.length : 128} fixed neurons, brightness = spikes per bin.
          Readouts: the decoder cells plus biological comparisons.
        </li>
        <li>
          <b>08 CAVEATS.</b> The neuron → button mapping is engineered, not biology. Dynamics are approximate;
          graded visual cells are modelled with spikes; retinal geometry is inferred. This is a demo of the
          reconstructed wiring, not evidence of fly behaviour.
          {m?.synthetic ? ' This run uses a SYNTHETIC graph, not the connectome.' : ''}
        </li>
      </ol>
    </details>
  );
}

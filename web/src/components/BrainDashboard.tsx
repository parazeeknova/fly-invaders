import { useEffect } from 'react';
import { BrainMap } from '../panels/BrainMap';
import { HowItWorks } from '../panels/HowItWorks';
import { Readouts } from '../panels/Readouts';
import { RetinaView } from '../panels/RetinaView';
import { SpikeRasterDisclosure } from '../panels/SpikeRaster';
import { StatusBar } from '../panels/StatusBar';
import { Timeline } from '../panels/Timeline';

/** The fly-brain spectator: everything the brain reports, laid out as a monochrome instrument wall. */
export function BrainDashboard() {
  useEffect(() => {
    if (!new URLSearchParams(location.search).has('mock')) return;
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    import('../panels/mock').then(({ installMockBrain }) => {
      if (!cancelled) cleanup = installMockBrain();
    });
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, []);

  return (
    <div className="brain-dashboard">
      <StatusBar />
      <div className="dash-grid">
        <RetinaView />
        <BrainMap />
        <Readouts />
        <Timeline />
      </div>
      <SpikeRasterDisclosure />
      <HowItWorks />
    </div>
  );
}

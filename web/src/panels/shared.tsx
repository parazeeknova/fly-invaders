import type { ReactNode } from 'react';

const formatter = new Intl.NumberFormat('en-US');

/** Thousands-separated integer. */
export const num = (x: number) => formatter.format(x);

const compactFormatter = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** 25,582,938 -> 25.6M; small numbers stay exact. */
export const compact = (x: number) => (Math.abs(x) < 100000 ? formatter.format(x) : compactFormatter.format(x));

/** Fixed decimals or an em dash when there is no value yet. */
export const fixed = (x: number | null | undefined, digits = 1) =>
  x == null || Number.isNaN(x) ? '—' : x.toFixed(digits);

/** Human labels for the population superclasses the brain reports. */
export function populationLabel(name: string) {
  const table: Record<string, string> = {
    ol_intrinsic: 'OPTIC LOBE',
    visual_projection: 'VISUAL PROJ',
    vpn: 'VISUAL PROJ',
    cb_intrinsic: 'CENTRAL BRAIN',
    central_brain: 'CENTRAL BRAIN',
    descending_neuron: 'DESCENDING',
    descending: 'DESCENDING',
    sensory: 'SENSORY',
    ascending: 'ASCENDING',
    motor: 'MOTOR',
  };
  return table[name] ?? name.replace(/_/g, ' ').toUpperCase();
}

export function Panel({
  title,
  caption,
  icon,
  className,
  children,
}: {
  title: string;
  caption?: ReactNode;
  icon?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `panel ${className}` : 'panel'}>
      <header className="panel-head">
        <h2>
          {icon}
          <span>{title}</span>
        </h2>
        {caption ? <span className="panel-caption">{caption}</span> : null}
      </header>
      {children}
    </section>
  );
}

/** Placeholder shown while the brain has not sent the data a panel needs. */
export function Awaiting({ label = 'awaiting brain', minHeight }: { label?: string; minHeight?: number }) {
  return (
    <div className="awaiting" style={minHeight ? { minHeight } : undefined}>
      <span>{label}</span>
    </div>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  active,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Optional second line under the value (e.g. a related rate or a cell count). */
  sub?: ReactNode;
  active?: boolean;
}) {
  return (
    <div className={active ? 'stat is-active' : 'stat'}>
      <span className="label">{label}</span>
      <strong>
        {value}
        {unit ? <small> {unit}</small> : null}
      </strong>
      {sub != null ? <small className="stat-sub">{sub}</small> : null}
    </div>
  );
}

/** Key/legend line under a plot. */
export function PlotKey({ children }: { children: ReactNode }) {
  return <div className="plot-key">{children}</div>;
}

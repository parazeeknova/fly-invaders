import type { SVGProps } from 'react';

// 16 x 16 integer-geometry glyphs, ported from DOOMFLY's pixel-icon set.
const paths = {
  eye: 'M5 3h6v1h2v2h2v1h1v2h-1v1h-2v2h-2v1H5v-1H3v-2H1V9H0V7h1V6h2V4h2V3zm0 2v1H3v1H2v2h1v1h2v1h6v-1h2V9h1V7h-1V6h-2V5H5zm2 1h3v4H6V7h1V6z',
  brain: 'M4 1h3v1h2V1h3v2h2v2h1v7h-2v2h-3v1H6v-1H3v-2H1V5h1V3h2V1zm0 3H3v3H2v4h2v2h3V9H5V7h2V3H5v1H4zm5-1v5h2V6h2V5h-1V3H9zm0 7v3h3v-2h2V8h-2v2H9z',
  turn: 'M0 7h1V6h1V5h1V4h2v3h6V4h2v1h1v1h1v1h1v2h-1v1h-1v1h-1v1h-2V9H5v3H3v-1H2v-1H1V9H0V7z',
  move: 'M7 1h2v1h1v1h1v1h1v1h1v1h1v2h-4v7H6V8H2V6h1V5h1V4h1V3h1V2h1V1z',
  target: 'M7 0h2v3h3v1h1v3h3v2h-3v3h-1v1H9v3H7v-3H4v-1H3V9H0V7h3V4h1V3h3V0zM5 5v6h6V5H5zm2 2h2v2H7V7z',
  signal: 'M1 11h2v4H1v-4zm4-4h2v8H5V7zm4-4h2v12H9V3zm4-3h2v15h-2V0z',
  code: 'M4 3h2v2H4v2H2v2h2v2h2v2H4v-1H2v-1H1v-1H0V6h1V5h1V4h2V3zm6 0h2v1h2v1h1v1h1v4h-1v1h-1v1h-2v1h-2v-2h2V9h2V7h-2V5h-2V3z',
  plus: 'M7 2h2v5h5v2H9v5H7V9H2V7h5V2z',
  screen: 'M0 1h16v11H9v2h4v2H3v-2h4v-2H0V1zm2 2v7h12V3H2z',
  skull: 'M4 1h8v1h2v2h1v7h-2v4h-2v-2H9v2H7v-2H5v2H3v-4H1V4h1V2h2V1zm0 5v3h3V6H4zm5 0v3h3V6H9zm-2 4v2h2v-2H7z',
  heart: 'M2 2h4v1h1v1h2V3h1V2h4v1h1v1h1v5h-1v1h-1v1h-1v1h-1v1h-1v1h-1v1H6v-1H5v-1H4v-1H3v-1H2v-1H1V9H0V4h1V3h1V2z',
};

export type PixelIconName = keyof typeof paths;

export function PixelIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: PixelIconName }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <path fillRule="evenodd" d={paths[name]} />
    </svg>
  );
}

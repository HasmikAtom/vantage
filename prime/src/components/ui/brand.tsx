// VantageLogo — the brand mark used in the header and on every setup /
// login screen. Pinwheel-V: three thin chevron-tipped blades rotating
// inside a hex silhouette, with a flat-bottomed V locked into the
// central void. Designed as a sibling to the Herxagon mark.
//
// Size via className (h-8 w-8 in the header, h-9 w-9 on the login /
// setup splash). The emerald is hard-coded so the mark reads the same
// in light and dark themes — matches the favicon.
export interface VantageLogoProps {
  className?: string;
}

const BLADE = 'M 100 14 L 174 57 L 174 143 L 150 130 L 150 70 L 122 50 Z';
const V = 'M 66 72 L 92 142 L 108 142 L 134 72 L 118 72 L 100 108 L 82 72 Z';

export const VantageLogo = ({ className }: VantageLogoProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 200 200"
    role="img"
    aria-label="Vantage mark"
    className={className}
    fill="#16a34a"
  >
    <title>Vantage mark</title>
    <path d={BLADE} />
    <path d={BLADE} transform="rotate(120 100 100)" />
    <path d={BLADE} transform="rotate(240 100 100)" />
    <path d={V} />
  </svg>
);

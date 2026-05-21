export interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: boolean;
  strokeWidth?: number;
}

export const Sparkline = ({
  data,
  width = 96,
  height = 24,
  stroke = 'currentColor',
  fill = true,
  strokeWidth = 1.25,
}: SparklineProps) => {
  if (!data || data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts: [number, number][] = data.map((v, i) => {
    const x = (i / (data.length - 1)) * (width - 2) + 1;
    const y = height - 2 - ((v - min) / range) * (height - 4);
    return [x, y];
  });
  const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  // Safe: data is non-empty (checked above), and pts has the same length as data.
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  const fillPath =
    `M ${first[0]},${height - 1} L ` +
    pts.map((p) => `${p[0]},${p[1]}`).join(' L ') +
    ` L ${last[0]},${height - 1} Z`;
  return (
    <svg width={width} height={height} className="overflow-visible block">
      {fill && <path d={fillPath} fill={stroke} opacity={0.12} />}
      <polyline
        points={poly}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
};

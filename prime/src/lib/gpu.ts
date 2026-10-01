import type { GpuHeadline } from '@/types';

// Fan as "25% · 1209 rpm". amdgpu can report a 0 duty cycle while the fan
// still turns, so RPM alone is shown then; older outposts send no RPM.
export function gpuFanText(gpu: Pick<GpuHeadline, 'fan' | 'fanRpm'>): string {
  const parts: string[] = [];
  if (gpu.fan > 0) parts.push(`${gpu.fan}%`);
  if (gpu.fanRpm) parts.push(`${gpu.fanRpm} rpm`);
  return parts.length > 0 ? parts.join(' · ') : '—';
}

// Watts that count as "full" for the power colour ramp: the card's own
// limit when the driver reports it, else a typical desktop card's 150 W.
export function gpuPowerCeiling(gpu: Pick<GpuHeadline, 'powerCapW'>): number {
  return gpu.powerCapW && gpu.powerCapW > 0 ? gpu.powerCapW : 150;
}

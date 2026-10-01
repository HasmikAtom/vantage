import { describe, expect, it } from 'vitest';
import { gpuFanText, gpuPowerCeiling } from './gpu';

describe('gpuFanText', () => {
  it('shows percent and RPM when both are reported', () => {
    expect(gpuFanText({ fan: 25, fanRpm: 1209 })).toBe('25% · 1209 rpm');
  });
  it('shows RPM alone when the duty cycle reads 0 but the fan spins', () => {
    expect(gpuFanText({ fan: 0, fanRpm: 209 })).toBe('209 rpm');
  });
  it('works with older outposts that send no RPM', () => {
    expect(gpuFanText({ fan: 40 })).toBe('40%');
    expect(gpuFanText({ fan: 0 })).toBe('—');
  });
});

describe('gpuPowerCeiling', () => {
  it("uses the card's own power limit", () => {
    expect(gpuPowerCeiling({ powerCapW: 120 })).toBe(120);
  });
  it('falls back to 150 W when the limit is unknown', () => {
    expect(gpuPowerCeiling({ powerCapW: 0 })).toBe(150);
    expect(gpuPowerCeiling({})).toBe(150);
  });
});

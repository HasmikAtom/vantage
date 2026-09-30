import type { FsPin } from '@/api';
import { baseName } from '../fsPath';

export const DEFAULT_PIN_PATHS = ['/', '/home', '/etc', '/var/log', '/opt'] as const;
const MAX_PINS = 50;

// Shown when the user has no stored pins for a server. Saving an empty
// list brings the defaults back, which is the intended "reset".
export function defaultPins(): FsPin[] {
  return DEFAULT_PIN_PATHS.map((path) => ({ path, label: null }));
}

export function pinLabel(p: FsPin): string {
  return p.label ?? baseName(p.path);
}

export function addPin(pins: FsPin[], path: string): FsPin[] {
  if (pins.some((p) => p.path === path) || pins.length >= MAX_PINS) return pins;
  return [...pins, { path, label: null }];
}

export function removePin(pins: FsPin[], path: string): FsPin[] {
  return pins.filter((p) => p.path !== path);
}

export function movePin(pins: FsPin[], path: string, delta: -1 | 1): FsPin[] {
  const i = pins.findIndex((p) => p.path === path);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= pins.length) return pins;
  const next = [...pins];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

export function renamePin(pins: FsPin[], path: string, label: string): FsPin[] {
  const t = label.trim();
  return pins.map((p) => (p.path === path ? { path, label: t === '' ? null : t } : p));
}

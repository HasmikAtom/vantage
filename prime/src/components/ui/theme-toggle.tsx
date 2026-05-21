import { Button } from './primitives';
import { MoonIcon, SunIcon } from './icons';

export type ThemeMode = 'light' | 'dark';

export interface ThemeToggleProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

export const ThemeToggle = ({ mode, onChange }: ThemeToggleProps) => {
  const isDark = mode === 'dark';
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => onChange(isDark ? 'light' : 'dark')}
      title={isDark ? 'Switch to light' : 'Switch to dark'}
      className="font-mono uppercase tracking-wider gap-1.5"
    >
      {isDark ? <MoonIcon size={13} /> : <SunIcon size={13} />}
      <span className="text-[10px]">{isDark ? 'Dark' : 'Light'}</span>
    </Button>
  );
};

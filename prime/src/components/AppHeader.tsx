import * as React from 'react';
import type { SystemInfo } from '@/types';
import type { ServerSummary } from '@/api';
import { Button, Separator } from './ui/primitives';
import { StatusDot } from './ui/status-dot';
import { ThemeToggle, type ThemeMode } from './ui/theme-toggle';
import { ChevronDownIcon, SettingsIcon } from './ui/icons';
import { VantageLogo } from './ui/brand';
import { authClient } from '@/auth';
import { cn } from '@/lib/utils';

export interface AppHeaderProps {
  system: SystemInfo;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  userEmail: string;
  onOpenSettings: () => void;
  servers: ServerSummary[];
  activeServerId: string;
  onSelectServer: (id: string) => void;
}

export const AppHeader = ({
  system,
  themeMode,
  setThemeMode,
  userEmail,
  onOpenSettings,
  servers,
  activeServerId,
  onSelectServer,
}: AppHeaderProps) => {
  const [switcherOpen, setSwitcherOpen] = React.useState(false);
  const switcherRef = React.useRef<HTMLDivElement>(null);

  // Click-outside closes the dropdown. Skip the listener entirely while
  // closed so we're not paying for it on every page render.
  React.useEffect(() => {
    if (!switcherOpen) return;
    const onDown = (e: MouseEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [switcherOpen]);

  // The prominent label is the registry name (what the user chose when
  // adding the server) — falls back to the machine hostname during the
  // brief window before the registry list has resolved.
  const active = servers.find((s) => s.id === activeServerId);
  const activeLabel = active?.name ?? system.hostname;

  const onSignOut = async () => {
    await authClient.signOut();
    window.location.reload();
  };

  return (
    <header className="border-b bg-card">
      <div className="flex items-center justify-between gap-6 px-8 py-3.5">
        <div className="flex items-center gap-3.5">
          <VantageLogo className="h-8 w-8 shrink-0" />
          <div className="relative" ref={switcherRef}>
            <button
              type="button"
              onClick={() => setSwitcherOpen((v) => !v)}
              className={cn(
                'group flex items-center gap-2 -ml-1 px-1.5 py-1 rounded-md text-left',
                'hover:bg-muted transition-colors',
                switcherOpen && 'bg-muted',
              )}
              title="Switch server"
              aria-haspopup="listbox"
              aria-expanded={switcherOpen}
            >
              <div className="min-w-0">
                <div className="font-serif text-lg font-semibold leading-tight tracking-tight truncate">
                  {activeLabel}
                </div>
                <div className="font-mono text-[11px] text-muted-foreground mt-0.5 truncate">
                  {system.hostname} · {system.os} · {system.kernel.replace('Linux ', '')}
                </div>
              </div>
              <ChevronDownIcon
                size={14}
                className={cn(
                  'shrink-0 text-muted-foreground/70 transition-transform',
                  'group-hover:text-foreground',
                  switcherOpen && 'rotate-180',
                )}
              />
            </button>

            {switcherOpen && (
              <div className="absolute left-0 top-full mt-1 z-50 w-64 rounded-md border bg-popover shadow-md">
                <ul className="py-1 max-h-72 overflow-auto">
                  {servers.length === 0 && (
                    <li className="px-3 py-2 font-mono text-[11px] text-muted-foreground">
                      No servers configured.
                    </li>
                  )}
                  {servers.map((s) => (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelectServer(s.id);
                          setSwitcherOpen(false);
                        }}
                        className={cn(
                          'flex w-full flex-col items-start px-3 py-1.5 text-left',
                          'font-mono text-[11px] hover:bg-muted',
                          s.id === activeServerId && 'bg-muted/60',
                        )}
                      >
                        <span className="truncate w-full">{s.name}</span>
                        <span className="truncate w-full text-[9px] text-muted-foreground/80">
                          {s.url}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="border-t">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSettings();
                      setSwitcherOpen(false);
                    }}
                    className="block w-full px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wider text-muted-foreground hover:bg-muted"
                  >
                    Manage servers…
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <StatusDot status="healthy" pulse />
          All systems healthy · uptime {system.uptimeText}
        </div>

        <div className="flex items-center gap-3">
          <span className="font-mono text-xs">{system.timeText}</span>
          <Separator orientation="vertical" className="h-5" />
          <span
            className="font-mono text-[11px] text-muted-foreground max-w-[180px] truncate"
            title={userEmail}
          >
            {userEmail}
          </span>
          <Button
            variant="outline"
            size="iconSm"
            onClick={onOpenSettings}
            title="Settings"
          >
            <SettingsIcon size={14} />
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={onSignOut}
            className="font-mono uppercase tracking-wider text-[10px]"
          >
            Sign out
          </Button>
          <Separator orientation="vertical" className="h-5" />
          <ThemeToggle mode={themeMode} onChange={setThemeMode} />
        </div>
      </div>
    </header>
  );
};

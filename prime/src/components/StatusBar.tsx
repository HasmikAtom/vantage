import * as React from 'react';
import type { Service, UpdateInfo } from '@/types';
import { Badge } from './ui/primitives';
import { AlertTriangleIcon } from './ui/icons';
import { cn } from '@/lib/utils';

interface Props {
  // Failed units to alert on (dismissed ones are already filtered out).
  failed: Service[];
  updates: UpdateInfo;
  onJumpToServices: () => void;
  // Dismiss a known-harmless failure; absent when gate can't store it.
  onDismiss?: (s: Service) => void;
}

/**
 * Banner shown above the tab content. Surfaces two things a sysadmin should
 * notice at a glance: failed systemd units, and pending OS updates.
 * Renders nothing if both are clean.
 *
 * React.memo: services/updates from snapshot are stable across most ticks
 * (only collector cadence changes them), so the shallow compare skips both
 * the filter() and the JSX work. Parent must pass a stable onJumpToServices
 * (App.tsx wraps setTab in useCallback for this).
 */
export const StatusBar = React.memo(function StatusBar({ failed, updates, onJumpToServices, onDismiss }: Props) {
  const hasUpdates =
    updates.upgradableCount > 0 || updates.rebootRequired || updates.securityCount > 0;

  if (failed.length === 0 && !hasUpdates) return null;

  return (
    <div className="space-y-2 mb-6">
      {failed.length > 0 && (
        <div className="w-full flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5">
          <AlertTriangleIcon size={16} className="text-destructive shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-destructive">
              {failed.length} systemd unit{failed.length === 1 ? '' : 's'} failed
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-[11px] text-destructive/80">
              {failed.slice(0, 5).map((s) => (
                <span key={s.name} className="inline-flex items-center gap-1">
                  {s.name}
                  {onDismiss && (
                    <button
                      type="button"
                      onClick={() => onDismiss(s)}
                      title={`Dismiss ${s.name}: hidden until it recovers or fails again`}
                      aria-label={`Dismiss ${s.name}`}
                      className="rounded px-1 leading-none text-destructive/60 hover:bg-destructive/20 hover:text-destructive"
                    >
                      ✕
                    </button>
                  )}
                </span>
              ))}
              {failed.length > 5 && <span>+{failed.length - 5} more</span>}
            </div>
          </div>
          <button type="button" onClick={onJumpToServices} className={cn('shrink-0 rounded-md transition-opacity hover:opacity-80')}>
            <Badge variant="danger">jump to services</Badge>
          </button>
        </div>
      )}

      {hasUpdates && (
        <div className="w-full flex items-center gap-3 rounded-md border border-warn/40 bg-warn/10 px-4 py-2.5">
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-warn">
              {updates.upgradableCount > 0
                ? `${updates.upgradableCount} package update${updates.upgradableCount === 1 ? '' : 's'} available`
                : 'System updated'}
              {updates.securityCount > 0 && (
                <span className="ml-2 text-destructive">
                  ({updates.securityCount} security)
                </span>
              )}
              {updates.rebootRequired && (
                <span className="ml-2 text-destructive">· reboot required</span>
              )}
            </div>
            {updates.summary && (
              <div className="font-mono text-[11px] text-warn/80 truncate mt-0.5">
                {updates.summary.split('\n')[0]}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

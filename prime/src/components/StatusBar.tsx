import * as React from 'react';
import type { Service, UpdateInfo } from '@/types';
import { Badge } from './ui/primitives';
import { AlertTriangleIcon } from './ui/icons';
import { cn } from '@/lib/utils';

interface Props {
  services: Service[];
  updates: UpdateInfo;
  onJumpToServices: () => void;
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
export const StatusBar = React.memo(function StatusBar({ services, updates, onJumpToServices }: Props) {
  const failed = React.useMemo(
    () => services.filter((s) => s.status === 'failed'),
    [services],
  );
  const hasUpdates =
    updates.upgradableCount > 0 || updates.rebootRequired || updates.securityCount > 0;

  if (failed.length === 0 && !hasUpdates) return null;

  return (
    <div className="space-y-2 mb-6">
      {failed.length > 0 && (
        <button
          onClick={onJumpToServices}
          className={cn(
            'w-full flex items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-2.5',
            'text-left hover:bg-destructive/15 transition-colors',
          )}
        >
          <AlertTriangleIcon size={16} className="text-destructive shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-xs font-semibold text-destructive">
              {failed.length} systemd unit{failed.length === 1 ? '' : 's'} failed
            </div>
            <div className="font-mono text-[11px] text-destructive/80 truncate mt-0.5">
              {failed.map((s) => s.name).slice(0, 5).join('  ·  ')}
              {failed.length > 5 ? `  · +${failed.length - 5} more` : ''}
            </div>
          </div>
          <Badge variant="danger">jump to services</Badge>
        </button>
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

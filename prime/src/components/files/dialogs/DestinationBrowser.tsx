import * as React from 'react';
import type { FsListResponse } from '@/types';
import { Button, Card } from '@/components/ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ChevronRightIcon, ContainerIcon, FileTextIcon } from '@/components/ui/icons';
import { cn } from '@/lib/utils';
import { fsList } from '@/api';
import { joinPath } from '../fsPath';

interface DestinationBrowserProps {
  serverId: string;
  serverName: string;
  initialPath: string;
  sourceName: string;       // filename we'll preserve when picking a folder
  onCancel: () => void;
  onPick: (folder: string) => void;
}

export function DestinationBrowser({
  serverId,
  serverName,
  initialPath,
  sourceName,
  onCancel,
  onPick,
}: DestinationBrowserProps) {
  const [path, setPath] = React.useState(initialPath || '/');
  const [data, setData] = React.useState<FsListResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await fsList(serverId, path);
        if (alive) setData(res);
      } catch (e) {
        if (alive) {
          setData(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [serverId, path]);

  const goTo = (next: string) => setPath(next);

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Pick a folder on ${serverName}`}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <Breadcrumbs path={path} onNavigate={goTo} />

          {error && <Card className="mt-2 p-2 text-xs text-destructive">{error}</Card>}

      <Card className="mt-2 overflow-hidden">
        <div className="max-h-[50vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-6 pr-0"></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Owner</TableHead>
                <TableHead className="font-mono">Mode</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data && data.parent !== '' && (
                <TableRow
                  onClick={() => goTo(data.parent || '/')}
                  className="cursor-pointer hover:bg-muted/50"
                >
                  <TableCell className="pr-0 text-muted-foreground/60">↩</TableCell>
                  <TableCell colSpan={3} className="font-mono text-xs">..</TableCell>
                </TableRow>
              )}
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-xs text-muted-foreground">loading…</TableCell>
                </TableRow>
              ) : !data ? null : data.entries.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-xs text-muted-foreground">empty</TableCell>
                </TableRow>
              ) : (
                data.entries.map((e) =>
                  e.type === 'dir' ? (
                    <TableRow
                      key={e.path}
                      onClick={() => goTo(e.path)}
                      className="cursor-pointer hover:bg-muted/50"
                    >
                      <TableCell className="pr-0">
                        <ContainerIcon size={12} className="text-primary/80" />
                      </TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[420px]">
                        {e.name}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground">
                        {e.owner}<span className="text-muted-foreground/40">:</span>{e.group}
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground">
                        {e.modeStr}
                      </TableCell>
                    </TableRow>
                  ) : (
                    <TableRow key={e.path} className="opacity-50">
                      <TableCell className="pr-0">
                        <FileTextIcon size={12} className="text-muted-foreground/70" />
                      </TableCell>
                      <TableCell className="font-mono text-xs truncate max-w-[420px] text-muted-foreground">
                        {e.name}
                      </TableCell>
                      <TableCell className="font-mono text-[11px] text-muted-foreground/70">
                        {e.owner}<span className="text-muted-foreground/40">:</span>{e.group}
                      </TableCell>
                      <TableCell className="font-mono text-[10px] text-muted-foreground/70">
                        {e.modeStr}
                      </TableCell>
                    </TableRow>
                  ),
                )
              )}
            </TableBody>
          </Table>
        </div>
      </Card>

          <div className="mt-3 text-xs text-muted-foreground font-mono break-all">
            Will save as:{' '}
            <span className="text-foreground">{joinPath(path, sourceName)}</span>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => onPick(path)}>Pick this folder</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Breadcrumbs — path trail for the destination picker (moved with it from
// the old Files tab).
interface BreadcrumbsProps {
  path: string;
  onNavigate: (p: string) => void;
}

function Breadcrumbs({ path, onNavigate }: BreadcrumbsProps) {
  const segments = path === '/' ? [''] : path.split('/');
  return (
    <div className="flex items-center gap-1 font-mono text-xs">
      <button
        onClick={() => onNavigate('/')}
        className="text-primary hover:underline"
        title="/"
      >
        /
      </button>
      {segments.slice(1).map((seg, i) => {
        const here = '/' + segments.slice(1, i + 2).join('/');
        const isLast = i === segments.length - 2;
        return (
          <React.Fragment key={here}>
            <ChevronRightIcon size={10} className="text-muted-foreground/50" />
            <button
              onClick={() => onNavigate(here)}
              className={cn(
                'hover:underline',
                isLast ? 'text-foreground font-medium' : 'text-primary',
              )}
            >
              {seg}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}

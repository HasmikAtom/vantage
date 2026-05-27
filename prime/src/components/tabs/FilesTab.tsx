import * as React from 'react';
import type { FsEntry, FsListResponse, TrashItem } from '@/types';
import { cn } from '@/lib/utils';
import { Badge, Button, Card, Input } from '../ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import {
  ChevronRightIcon,
  ContainerIcon,
  FileTextIcon,
  RefreshIcon,
  TrashIcon,
} from '../ui/icons';
import { SectionHeader } from '../SectionHeader';
import { useCan } from '@/auth';
import {
  cancelTransfer,
  createTransfer,
  fetchServers,
  fsChmod,
  fsChown,
  fsCopy,
  fsDelete,
  fsDownloadURL,
  fsList,
  fsMkdir,
  fsMove,
  fsRead,
  fsRename,
  fsTrashList,
  fsTrashPermanentDelete,
  fsTrashRestore,
  fsUpload,
  fsWrite,
  transferStreamURL,
  type ServerSummary,
  type TransferProgress,
} from '@/api';

// FilesTab — Phase 1 single-pane file manager.
//
// Path semantics: every path the user sees and types is HOST-relative
// (e.g. /home/hasmik, /etc/hosts). The backend translates through /hostfs
// internally. Navigation state lives in URL hash so a refresh keeps you
// where you were.
//
// Role gating: the API does the real check; we just use canControl to
// disable buttons that would 403 anyway, so users get clear feedback
// instead of clicking and seeing an error toast.

interface FilesTabProps {
  serverId: string;
}

const ROOT = '/';

export function FilesTab({ serverId }: FilesTabProps) {
  const canControl = useCan('operator');
  const [path, setPath] = React.useState<string>(initialPath());
  const [data, setData] = React.useState<FsListResponse | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [showHidden, setShowHidden] = React.useState(false);
  const [editing, setEditing] = React.useState<FsEntry | null>(null);
  const [renaming, setRenaming] = React.useState<FsEntry | null>(null);
  const [copyMoving, setCopyMoving] = React.useState<{ entry: FsEntry; mode: 'copy' | 'move' } | null>(null);
  const [newDir, setNewDir] = React.useState(false);
  // Transfer state: the FsEntry queued for "Send to…" and the live list
  // of in-flight transfers we're rendering in the footer. The footer
  // owns the SSE subscription per row.
  const [sendingEntry, setSendingEntry] = React.useState<FsEntry | null>(null);
  const [transfers, setTransfers] = React.useState<Record<string, TransferProgress>>({});
  const [trashOpen, setTrashOpen] = React.useState(false);
  const [permsEntry, setPermsEntry] = React.useState<FsEntry | null>(null);
  const canAdmin = useCan('admin');
  // Helper for the footer to install/update a row from an SSE event.
  const upsertTransfer = React.useCallback((p: TransferProgress) => {
    setTransfers((prev) => ({ ...prev, [p.id]: p }));
  }, []);
  const dismissTransfer = React.useCallback((id: string) => {
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fsList(serverId, path));
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [serverId, path]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Stable callback for TransferRow's effect deps: TransferFooter rows
  // subscribe to per-transfer SSE streams; their effect must include this
  // callback in its deps array to avoid stale closures, but we don't want
  // every parent re-render (or every path/serverId change, which would
  // change `refresh` identity) to tear down and reopen every transfer
  // stream. The ref indirection gives the callback a stable identity
  // while still invoking the latest refresh() against the latest path.
  const refreshRef = React.useRef(refresh);
  React.useEffect(() => { refreshRef.current = refresh; }, [refresh]);
  const refreshSourceForTransfers = React.useCallback(async () => {
    // Move-mode transfers delete the source on success; refresh the
    // current pane so the row disappears.
    await refreshRef.current();
  }, []);

  // Keep the URL hash in sync so reloads land back on the same dir.
  React.useEffect(() => {
    const h = `#files:${path}`;
    if (window.location.hash !== h) {
      history.replaceState(null, '', h);
    }
  }, [path]);

  const visibleEntries = React.useMemo(() => {
    if (!data) return [];
    return showHidden ? data.entries : data.entries.filter((e) => !e.name.startsWith('.'));
  }, [data, showHidden]);

  const navigate = (next: string) => {
    setSelected(null);
    setPath(next);
  };

  return (
    <div className="space-y-3">
      <SectionHeader
        label="Files"
        count={loading ? 'loading…' : data ? `${visibleEntries.length} items` : ''}
        right={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={showHidden}
                onChange={(e) => setShowHidden(e.target.checked)}
                className="h-3 w-3"
              />
              Show hidden
            </label>
            <Button size="xs" variant="ghost" onClick={() => void refresh()} title="Refresh">
              <RefreshIcon size={11} />
            </Button>
          </div>
        }
      />

      <Breadcrumbs path={path} onNavigate={navigate} />

      {error && (
        <Card className="p-3 text-xs text-destructive">{error}</Card>
      )}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={!canControl}
              onClick={() => setNewDir(true)}
              title={!canControl ? 'Operator role required' : 'New folder'}
            >
              New folder
            </Button>
            <UploadButton serverId={serverId} destDir={path} disabled={!canControl} onDone={refresh} />
            <Button
              size="xs"
              variant="outline"
              disabled={!selected || !canControl}
              onClick={() => {
                const e = visibleEntries.find((x) => x.path === selected);
                if (e) setRenaming(e);
              }}
            >
              Rename
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!selected || !canControl}
              onClick={() => {
                const e = visibleEntries.find((x) => x.path === selected);
                if (e) setCopyMoving({ entry: e, mode: 'copy' });
              }}
              title={!canControl ? 'Operator role required' : 'Copy to another path on this host'}
            >
              Copy
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!selected || !canControl}
              onClick={() => {
                const e = visibleEntries.find((x) => x.path === selected);
                if (e) setCopyMoving({ entry: e, mode: 'move' });
              }}
              title={!canControl ? 'Operator role required' : 'Move to another path on this host'}
            >
              Move
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                window.location.href = fsDownloadURL(serverId, selected);
              }}
            >
              Download
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!selected || !canControl}
              onClick={() => {
                const e = visibleEntries.find((x) => x.path === selected);
                if (e && e.type === 'file') setSendingEntry(e);
                else if (e) setError(`Send to... only supports files in this version (got ${e.type})`);
              }}
              title={!canControl ? 'Operator role required' : 'Copy or move to another server'}
            >
              Send to…
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!selected || !canAdmin}
              onClick={() => {
                const e = visibleEntries.find((x) => x.path === selected);
                if (e) setPermsEntry(e);
              }}
              title={!canAdmin ? 'Admin role required' : 'Change permissions or ownership'}
            >
              Perms
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={!selected || !canControl}
              onClick={async () => {
                if (!selected) return;
                if (!confirm(`Move "${selected}" to trash?`)) return;
                try {
                  await fsDelete(serverId, selected);
                  setSelected(null);
                  await refresh();
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                }
              }}
              className="text-destructive hover:text-destructive"
            >
              <TrashIcon size={11} />
              Trash
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => setTrashOpen(true)}
              title="Show recently deleted files"
            >
              Trash bin
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-6 pr-0"></TableHead>
              <TableHead>Name</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead className="font-mono">Mode</TableHead>
              <TableHead>Modified</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data && data.parent !== '' && (
              <TableRow
                onClick={() => navigate(data.parent || ROOT)}
                className="cursor-pointer hover:bg-muted/50"
              >
                <TableCell className="pr-0 text-muted-foreground/60">↩</TableCell>
                <TableCell className="font-mono text-xs">..</TableCell>
                <TableCell colSpan={4} className="text-muted-foreground/60 text-xs">
                  parent directory
                </TableCell>
              </TableRow>
            )}
            {visibleEntries.length === 0 && !loading ? (
              <TableRow>
                <TableCell colSpan={6} className="text-xs text-muted-foreground">
                  empty
                </TableCell>
              </TableRow>
            ) : (
              visibleEntries.map((e) => (
                <FileRow
                  key={e.path}
                  entry={e}
                  selected={selected === e.path}
                  onSelect={() => setSelected(e.path === selected ? null : e.path)}
                  onOpen={() => {
                    if (e.type === 'dir') navigate(e.path);
                    else if (e.type === 'file' && e.size <= 1 << 20) setEditing(e);
                  }}
                />
              ))
            )}
          </TableBody>
        </Table>
      </Card>

      {newDir && (
        <NewFolderModal
          parent={path}
          onCancel={() => setNewDir(false)}
          onSubmit={async (name) => {
            try {
              await fsMkdir(serverId, joinPath(path, name));
              setNewDir(false);
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}

      {renaming && (
        <RenameModal
          entry={renaming}
          onCancel={() => setRenaming(null)}
          onSubmit={async (newName) => {
            try {
              const dst = joinPath(parentOf(renaming.path), newName);
              await fsRename(serverId, renaming.path, dst);
              setRenaming(null);
              setSelected(null);
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}

      {copyMoving && (
        <CopyMoveModal
          entry={copyMoving.entry}
          mode={copyMoving.mode}
          onCancel={() => setCopyMoving(null)}
          onSubmit={async (dst, overwrite) => {
            try {
              if (copyMoving.mode === 'copy') {
                await fsCopy(serverId, copyMoving.entry.path, dst, {
                  overwrite,
                  recursive: copyMoving.entry.type === 'dir',
                });
              } else {
                await fsMove(serverId, copyMoving.entry.path, dst, { overwrite });
              }
              setCopyMoving(null);
              setSelected(null);
              await refresh();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }}
        />
      )}

      {editing && (
        <FileEditor
          serverId={serverId}
          entry={editing}
          canSave={canControl}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
        />
      )}

      {sendingEntry && (
        <SendToModal
          sourceServerId={serverId}
          entry={sendingEntry}
          canPreserveOwnership={canAdmin}
          onCancel={() => setSendingEntry(null)}
          onStarted={(p) => {
            setSendingEntry(null);
            upsertTransfer(p);
          }}
        />
      )}

      {trashOpen && (
        <TrashModal
          serverId={serverId}
          canAdmin={canAdmin}
          onClose={() => setTrashOpen(false)}
          onRestored={refresh}
        />
      )}

      {permsEntry && (
        <PermsModal
          serverId={serverId}
          entry={permsEntry}
          onCancel={() => setPermsEntry(null)}
          onSaved={async () => {
            setPermsEntry(null);
            await refresh();
          }}
        />
      )}

      <TransferFooter
        transfers={transfers}
        onUpdate={upsertTransfer}
        onDismiss={dismissTransfer}
        onRefreshSource={refreshSourceForTransfers}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

function initialPath(): string {
  const m = window.location.hash.match(/^#files:(\/.*)$/);
  return m && m[1] ? decodeURIComponent(m[1]) : ROOT;
}

function joinPath(parent: string, name: string): string {
  if (parent === '/') return '/' + name;
  return parent + '/' + name;
}

function parentOf(p: string): string {
  if (p === '/' || !p.includes('/')) return '/';
  const i = p.lastIndexOf('/');
  return i === 0 ? '/' : p.slice(0, i);
}

function formatSize(bytes: number, type: string): string {
  if (type === 'dir') return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatMtime(unix: number): string {
  const d = new Date(unix * 1000);
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? { hour: '2-digit', minute: '2-digit' } : { year: 'numeric' }),
  });
}

// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

interface FileRowProps {
  entry: FsEntry;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}

function FileRow({ entry, selected, onSelect, onOpen }: FileRowProps) {
  return (
    <TableRow
      onClick={onSelect}
      onDoubleClick={onOpen}
      className={cn('cursor-pointer', selected && 'bg-primary/10 hover:bg-primary/15')}
    >
      <TableCell className="pr-0">
        {entry.type === 'dir' ? (
          <ContainerIcon size={12} className="text-primary/80" />
        ) : entry.type === 'symlink' ? (
          <ChevronRightIcon size={12} className={cn('text-muted-foreground', entry.broken && 'text-destructive')} />
        ) : (
          <FileTextIcon size={12} className="text-muted-foreground/70" />
        )}
      </TableCell>
      <TableCell className="font-mono text-xs truncate max-w-[420px]">
        {entry.name}
        {entry.type === 'symlink' && entry.target && (
          <span className="text-muted-foreground/60 ml-1.5">→ {entry.target}</span>
        )}
        {entry.broken && <Badge variant="danger" className="ml-1.5 rounded-sm">broken</Badge>}
      </TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatSize(entry.size, entry.type)}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground">
        {entry.owner}
        <span className="text-muted-foreground/40">:</span>
        {entry.group}
      </TableCell>
      <TableCell className="font-mono text-[10px] text-muted-foreground">
        {entry.modeStr}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground">
        {formatMtime(entry.mtime)}
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------

interface UploadButtonProps {
  serverId: string;
  destDir: string;
  disabled: boolean;
  onDone: () => void;
}

function UploadButton({ serverId, destDir, disabled, onDone }: UploadButtonProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  return (
    <>
      <input
        ref={ref}
        type="file"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          try {
            await fsUpload(serverId, destDir, file);
            onDone();
          } catch (err) {
            alert(err instanceof Error ? err.message : String(err));
          } finally {
            setBusy(false);
            if (ref.current) ref.current.value = '';
          }
        }}
      />
      <Button
        size="xs"
        variant="outline"
        disabled={disabled || busy}
        onClick={() => ref.current?.click()}
        title={disabled ? 'Operator role required' : 'Upload a file into this directory'}
      >
        {busy ? 'Uploading…' : 'Upload'}
      </Button>
    </>
  );
}

// ---------------------------------------------------------------------------

interface NewFolderModalProps {
  parent: string;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

function NewFolderModal({ parent, onCancel, onSubmit }: NewFolderModalProps) {
  const [name, setName] = React.useState('');
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">New folder</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-2">in {parent}</div>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim()) onSubmit(name.trim());
              if (e.key === 'Escape') onCancel();
            }}
            placeholder="folder name"
            className="text-xs"
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={() => name.trim() && onSubmit(name.trim())} disabled={!name.trim()}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameModalProps {
  entry: FsEntry;
  onCancel: () => void;
  onSubmit: (newName: string) => void;
}

function RenameModal({ entry, onCancel, onSubmit }: RenameModalProps) {
  const [name, setName] = React.useState(entry.name);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Rename</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-2 font-mono truncate">{entry.path}</div>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && name.trim() && name !== entry.name) onSubmit(name.trim());
              if (e.key === 'Escape') onCancel();
            }}
            className="text-xs"
          />
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => name.trim() && onSubmit(name.trim())}
            disabled={!name.trim() || name === entry.name}
          >
            Rename
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

interface CopyMoveModalProps {
  entry: FsEntry;
  mode: 'copy' | 'move';
  onCancel: () => void;
  onSubmit: (destinationPath: string, overwrite: boolean) => void;
}

// CopyMoveModal asks for the full destination path on the same host. The
// default seeds the destination with the source's parent directory and a
// "-copy" suffix on the leaf for the copy case so the user can confirm
// without typing — the common copy-in-place flow.
function CopyMoveModal({ entry, mode, onCancel, onSubmit }: CopyMoveModalProps) {
  const initial = mode === 'copy'
    ? joinPath(parentOf(entry.path), suggestCopyName(entry.name))
    : entry.path;
  const [dst, setDst] = React.useState(initial);
  const [overwrite, setOverwrite] = React.useState(false);
  const title = mode === 'copy' ? 'Copy to…' : 'Move to…';
  const cta = mode === 'copy' ? 'Copy' : 'Move';
  const canSubmit = dst.trim().startsWith('/') && dst.trim() !== entry.path;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4 space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Source
            </div>
            <div className="text-xs font-mono truncate">{entry.path}</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground/70 mb-1">
              Destination
            </div>
            <Input
              autoFocus
              value={dst}
              onChange={(e) => setDst(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canSubmit) onSubmit(dst.trim(), overwrite);
                if (e.key === 'Escape') onCancel();
              }}
              placeholder="/absolute/host/path"
              className="text-xs font-mono"
            />
            <div className="text-[10px] text-muted-foreground mt-1">
              Full destination path on the host. Parent directory must exist.
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
              className="h-3 w-3"
            />
            Overwrite if a file exists at the destination
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button
            size="sm"
            onClick={() => canSubmit && onSubmit(dst.trim(), overwrite)}
            disabled={!canSubmit}
          >
            {cta}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// suggestCopyName produces a sensible default leaf name for a copy. For
// "foo.txt" it returns "foo-copy.txt"; for an extension-less leaf it
// appends "-copy".
function suggestCopyName(leaf: string): string {
  const dot = leaf.lastIndexOf('.');
  if (dot <= 0) return leaf + '-copy';
  return leaf.slice(0, dot) + '-copy' + leaf.slice(dot);
}

// ---------------------------------------------------------------------------

interface FileEditorProps {
  serverId: string;
  entry: FsEntry;
  canSave: boolean;
  onClose: () => void;
  onSaved: () => void;
}

function FileEditor({ serverId, entry, canSave, onClose, onSaved }: FileEditorProps) {
  const [content, setContent] = React.useState<string | null>(null);
  const [original, setOriginal] = React.useState<string>('');
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fsRead(serverId, entry.path);
        if (!alive) return;
        setContent(res.content);
        setOriginal(res.content);
      } catch (e) {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { alive = false; };
  }, [serverId, entry.path]);

  const dirty = content !== null && content !== original;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-sm">{entry.name}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-2 font-mono truncate">{entry.path}</div>
          {error ? (
            <div className="text-xs text-destructive">{error}</div>
          ) : content === null ? (
            <div className="text-xs text-muted-foreground">loading…</div>
          ) : (
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              className="w-full h-[60vh] font-mono text-xs bg-muted/30 border rounded p-2"
              spellCheck={false}
            />
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
          <Button
            size="sm"
            disabled={!canSave || !dirty || saving || content === null}
            onClick={async () => {
              if (content === null) return;
              setSaving(true);
              setError(null);
              try {
                await fsWrite(serverId, entry.path, content);
                onSaved();
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? 'Saving…' : canSave ? 'Save' : 'Operator role required'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// SendToModal — pick a destination server + path, kick off a transfer.
// ---------------------------------------------------------------------------

interface SendToModalProps {
  sourceServerId: string;
  entry: FsEntry;
  canPreserveOwnership: boolean;
  onCancel: () => void;
  onStarted: (initial: TransferProgress) => void;
}

function SendToModal({
  sourceServerId,
  entry,
  canPreserveOwnership,
  onCancel,
  onStarted,
}: SendToModalProps) {
  const [servers, setServers] = React.useState<ServerSummary[]>([]);
  const [dstServer, setDstServer] = React.useState('');
  // Default the destination to /tmp/<basename> rather than the source's
  // full path: /tmp is universally writable, the filename is preserved,
  // and the user has to consciously pick a real destination (vs.
  // unintentionally mirroring a path that may not exist on the other
  // host). Same-fleet "sync" use cases just edit the field.
  const [dstPath, setDstPath] = React.useState(`/tmp/${entry.name}`);
  const [mode, setMode] = React.useState<'copy' | 'move'>('copy');
  const [overwrite, setOverwrite] = React.useState(false);
  const [preserveOwnership, setPreserveOwnership] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      try {
        const list = await fetchServers();
        const others = list.filter((s) => s.id !== sourceServerId);
        setServers(others);
        if (others.length > 0 && others[0]) setDstServer(others[0].id);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [sourceServerId]);

  const submit = async () => {
    if (!dstServer || !dstPath.startsWith('/')) {
      setError('Destination server and absolute path required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { id } = await createTransfer({
        srcServer: sourceServerId,
        srcPath: entry.path,
        dstServer,
        dstPath,
        mode,
        overwrite,
        preserveSourceOwnership: preserveOwnership,
      });
      onStarted({
        id,
        bytesTotal: entry.size,
        bytesDone: 0,
        status: 'pending',
        error: null,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Send "${entry.name}" to another server`}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-3 font-mono truncate">
            from {entry.path} · {formatSize(entry.size, entry.type)}
          </div>
      {servers.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          No other servers registered. Add one in Settings first.
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Destination server
            </label>
            <select
              value={dstServer}
              onChange={(e) => setDstServer(e.target.value)}
              className="w-full h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {servers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Destination path
            </label>
            <div className="flex items-center gap-1.5">
              <Input
                value={dstPath}
                onChange={(e) => setDstPath(e.target.value)}
                placeholder="/absolute/path/on/destination"
                className="text-xs font-mono flex-1"
              />
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => setBrowseOpen(true)}
                disabled={!dstServer}
                title={!dstServer ? 'Pick a destination server first' : 'Browse the destination server'}
              >
                Browse…
              </Button>
            </div>
            <div className="text-[10px] text-muted-foreground/70 mt-1">
              Absolute path on the destination host. The parent directory must already exist.
            </div>
          </div>
          <div className="flex items-center gap-4 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={mode === 'copy'}
                onChange={() => setMode('copy')}
              />
              Copy
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="radio"
                checked={mode === 'move'}
                onChange={() => setMode('move')}
              />
              Move <span className="text-muted-foreground/60">(delete source on success)</span>
            </label>
          </div>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={overwrite}
              onChange={(e) => setOverwrite(e.target.checked)}
            />
            Overwrite if destination already exists
          </label>
          <label
            className={cn(
              'flex items-center gap-1.5 text-xs',
              canPreserveOwnership ? 'cursor-pointer' : 'cursor-not-allowed opacity-50',
            )}
            title={!canPreserveOwnership ? 'Admin role required (chmod/chown on destination)' : undefined}
          >
            <input
              type="checkbox"
              checked={preserveOwnership && canPreserveOwnership}
              disabled={!canPreserveOwnership}
              onChange={(e) => setPreserveOwnership(e.target.checked)}
            />
            Preserve source ownership & mode
            <span className="text-muted-foreground/60">(uid/gid + chmod)</span>
          </label>
        </div>
      )}
          {error && <div className="text-xs text-destructive mt-2">{error}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button
            size="sm"
            onClick={submit}
            disabled={busy || servers.length === 0 || !dstServer || !dstPath}
          >
            {busy ? 'Starting…' : 'Start transfer'}
          </Button>
        </DialogFooter>
        {browseOpen && dstServer && (
          <DestinationBrowser
            serverId={dstServer}
            serverName={servers.find((s) => s.id === dstServer)?.name ?? 'destination'}
            initialPath={parentOfMaybe(dstPath) || '/tmp'}
            sourceName={entry.name}
            onCancel={() => setBrowseOpen(false)}
            onPick={(folder) => {
              setBrowseOpen(false);
              setDstPath(joinPath(folder, entry.name));
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// parentOfMaybe handles the case where dstPath has no usable parent
// (e.g. an empty string or a single segment) and returns "" so the
// browser falls back to its initialPath default.
function parentOfMaybe(p: string): string {
  if (!p || !p.startsWith('/')) return '';
  return parentOf(p);
}

// ---------------------------------------------------------------------------
// TransferFooter — docked at the bottom of the Files tab, shows one card
// per in-flight (and recently-finished) transfer with a progress bar, byte
// counter, and a cancel/dismiss button. One SSE subscription per transfer.
// ---------------------------------------------------------------------------

interface TransferFooterProps {
  transfers: Record<string, TransferProgress>;
  onUpdate: (p: TransferProgress) => void;
  onDismiss: (id: string) => void;
  onRefreshSource: () => Promise<void>;
}

function TransferFooter({ transfers, onUpdate, onDismiss, onRefreshSource }: TransferFooterProps) {
  const ids = Object.keys(transfers);
  if (ids.length === 0) return null;
  return (
    <div className="fixed bottom-3 right-3 z-40 flex flex-col gap-2 max-w-md">
      {ids.map((id) => {
        const t = transfers[id];
        if (!t) return null;
        return (
          <TransferRow
            key={id}
            transfer={t}
            onUpdate={onUpdate}
            onDismiss={() => onDismiss(id)}
            onRefreshSource={onRefreshSource}
          />
        );
      })}
    </div>
  );
}

interface TransferRowProps {
  transfer: TransferProgress;
  onUpdate: (p: TransferProgress) => void;
  onDismiss: () => void;
  onRefreshSource: () => Promise<void>;
}

function TransferRow({ transfer, onUpdate, onDismiss, onRefreshSource }: TransferRowProps) {
  // Single SSE subscription per transfer for its lifetime in this row.
  // Both onUpdate and onRefreshSource are stable callbacks from the
  // parent (useCallback with empty/state-free deps + a ref for the
  // pane refresh). Including them in deps keeps the closure fresh
  // without ever tearing the stream down mid-flight.
  React.useEffect(() => {
    const es = new EventSource(transferStreamURL(transfer.id));
    es.onmessage = (ev) => {
      try {
        const parsed = JSON.parse(ev.data) as TransferProgress;
        onUpdate(parsed);
        if (parsed.status === 'completed') {
          void onRefreshSource();
        }
      } catch {
        // Bad payload — ignore; we'll get the next event.
      }
    };
    es.onerror = () => {
      // The auth service closes the stream once the transfer ends, which
      // fires onerror in EventSource. Close cleanly; the last data event
      // already carries the terminal status.
      es.close();
    };
    return () => es.close();
  }, [transfer.id, onUpdate, onRefreshSource]);

  const t = transfer;
  const pct = t.bytesTotal > 0 ? Math.min(100, (t.bytesDone / t.bytesTotal) * 100) : 0;
  const isActive = t.status === 'pending' || t.status === 'running';
  const colorClass =
    t.status === 'completed'
      ? 'bg-primary'
      : t.status === 'failed' || t.status === 'cancelled'
        ? 'bg-destructive'
        : 'bg-primary/80';
  return (
    <Card className="p-3 space-y-1.5 w-80 shadow-lg">
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-[11px] truncate">
          {t.status === 'pending' && 'Starting…'}
          {t.status === 'running' && 'Transferring'}
          {t.status === 'completed' && 'Completed'}
          {t.status === 'failed' && 'Failed'}
          {t.status === 'cancelled' && 'Cancelled'}
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={async () => {
            if (isActive) {
              try {
                await cancelTransfer(t.id);
              } catch {
                // Swallow — the row will update via SSE either way.
              }
            } else {
              onDismiss();
            }
          }}
          className="h-5 px-1.5 text-[10px]"
        >
          {isActive ? 'Cancel' : 'Dismiss'}
        </Button>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full transition-all', colorClass)} style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
        <span>
          {formatBytes(t.bytesDone)} {t.bytesTotal > 0 && `/ ${formatBytes(t.bytesTotal)}`}
        </span>
        <span>{t.bytesTotal > 0 ? pct.toFixed(0) + '%' : '—'}</span>
      </div>
      {t.error && <div className="text-[10px] text-destructive">{t.error}</div>}
    </Card>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// TrashModal — list, restore, or permanently delete soft-deleted items.
// ---------------------------------------------------------------------------

interface TrashModalProps {
  serverId: string;
  canAdmin: boolean;
  onClose: () => void;
  onRestored: () => Promise<void>;
}

function TrashModal({ serverId, canAdmin, onClose, onRestored }: TrashModalProps) {
  const [items, setItems] = React.useState<TrashItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await fsTrashList(serverId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [serverId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Trash bin</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-3">
            Items move here when deleted. Auto-purged after 7 days.
          </div>
          {error && <div className="text-xs text-destructive mb-2">{error}</div>}
          {loading ? (
            <div className="text-xs text-muted-foreground">loading…</div>
          ) : items.length === 0 ? (
            <div className="text-xs text-muted-foreground">Empty.</div>
          ) : (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Original path</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Deleted</TableHead>
                    <TableHead className="w-40 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((it) => (
                    <TrashRow
                      key={it.id}
                      serverId={serverId}
                      item={it}
                      canAdmin={canAdmin}
                      onChanged={async () => {
                        await refresh();
                        await onRestored();
                      }}
                      onError={setError}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TrashRowProps {
  serverId: string;
  item: TrashItem;
  canAdmin: boolean;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
}

function TrashRow({ serverId, item, canAdmin, onChanged, onError }: TrashRowProps) {
  const [busy, setBusy] = React.useState(false);
  const deletedAgo = formatRelative(item.deletedAt);
  return (
    <TableRow>
      <TableCell className="font-mono text-[11px] truncate max-w-[360px]">
        {item.originalPath}
        <Badge variant="muted" className="ml-1.5 rounded-sm">{item.type}</Badge>
      </TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {formatSize(item.size, item.type)}
      </TableCell>
      <TableCell className="font-mono text-[11px] text-muted-foreground">
        {deletedAgo}
        {item.deletedBy && <span className="ml-1 text-muted-foreground/60">by {item.deletedBy}</span>}
      </TableCell>
      <TableCell className="text-right">
        <div className="inline-flex gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                try {
                  await fsTrashRestore(serverId, item.id, false);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  if (msg.includes('already exists')) {
                    if (!confirm(`${item.originalPath} already exists at destination. Overwrite?`)) {
                      return;
                    }
                    await fsTrashRestore(serverId, item.id, true);
                  } else {
                    throw e;
                  }
                }
                await onChanged();
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
          >
            Restore
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy || !canAdmin}
            title={!canAdmin ? 'Admin role required' : 'Permanently delete (no undo)'}
            onClick={async () => {
              if (!confirm(`Permanently delete ${item.originalPath}? This cannot be undone.`)) return;
              setBusy(true);
              try {
                await fsTrashPermanentDelete(serverId, item.id);
                await onChanged();
              } catch (e) {
                onError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
            className="text-destructive hover:text-destructive"
          >
            <TrashIcon size={11} />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function formatRelative(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// PermsModal — admin-only chmod / chown for a single entry. Octal mode
// input (e.g. 0755 / 644); owner & group accept names or numeric IDs.
// ---------------------------------------------------------------------------

interface PermsModalProps {
  serverId: string;
  entry: FsEntry;
  onCancel: () => void;
  onSaved: () => Promise<void>;
}

function PermsModal({ serverId, entry, onCancel, onSaved }: PermsModalProps) {
  const [mode, setMode] = React.useState(modeToOctal(entry.mode));
  const [owner, setOwner] = React.useState(entry.owner);
  const [group, setGroup] = React.useState(entry.group);
  const [recursive, setRecursive] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Only fire chmod if the input changed — saves an audit row when
      // the admin only wants to update ownership.
      if (mode.trim() !== modeToOctal(entry.mode)) {
        await fsChmod(serverId, entry.path, mode.trim());
      }
      if (owner.trim() !== entry.owner || group.trim() !== entry.group || recursive) {
        await fsChown(serverId, entry.path, owner.trim(), group.trim(), recursive);
      }
      await onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{`Permissions — ${entry.name}`}</DialogTitle>
        </DialogHeader>
        <div className="px-6 pb-4">
          <div className="text-xs text-muted-foreground mb-3 font-mono truncate">{entry.path}</div>
          <div className="space-y-3">
        <div>
          <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
            Mode (octal)
          </label>
          <Input
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            placeholder="0755"
            className="text-xs font-mono"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Owner
            </label>
            <Input
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              placeholder="user or uid"
              className="text-xs font-mono"
            />
          </div>
          <div>
            <label className="block text-[10px] uppercase tracking-wider text-muted-foreground mb-1">
              Group
            </label>
            <Input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder="group or gid"
              className="text-xs font-mono"
            />
          </div>
        </div>
        {entry.type === 'dir' && (
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
            />
            Apply ownership recursively (chown -R)
          </label>
        )}
          </div>
          {error && <div className="text-xs text-destructive mt-2">{error}</div>}
        </div>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function modeToOctal(mode: number): string {
  return '0' + mode.toString(8).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// DestinationBrowser — folder picker against an arbitrary server, used by
// SendToModal to let the user click their way to the target folder instead
// of typing a path that may not exist on the destination.
//
// Navigation: single-click a folder row to descend; files are shown
// dimmed for orientation but aren't clickable (overwriting a specific
// file is still possible by editing the path in the parent modal).
// Breadcrumbs at the top jump up the tree.
//
// The picker has its own list state per-path; we don't try to be clever
// about caching. fsList is cheap and a folder picker isn't a high-volume
// surface.
// ---------------------------------------------------------------------------

interface DestinationBrowserProps {
  serverId: string;
  serverName: string;
  initialPath: string;
  sourceName: string;       // filename we'll preserve when picking a folder
  onCancel: () => void;
  onPick: (folder: string) => void;
}

function DestinationBrowser({
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

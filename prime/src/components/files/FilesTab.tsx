import * as React from 'react';
import type { FsEntry } from '@/types';
import type { ServerSummary, TransferProgress } from '@/api';
import { useCan } from '@/auth';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/primitives';
import { ContextMenu, type MenuEntry } from '@/components/ui/context-menu';
import { FilePane, type PaneCommand, type PaneId } from './FilePane';
import { Sidebar } from './Sidebar';
import { useSidebarWidth } from './hooks/useSidebarWidth';
import { useFillHeight } from './hooks/useFillHeight';
import { EDITOR_MAX_BYTES, ROOT } from './fsPath';
import { backgroundMenu, itemMenu, type MenuCtx } from './menus';
import { useFileActions } from './useFileActions';
import { collectDropped } from './dropUpload';
import { installFileDropGuard } from './dropGuard';
import { PIN_TARGET, useDnd, type DropSource } from './useDnd';
import { defaultCrossApi, runCrossTransfer, type CrossDeps } from './crossTransfer';
import { useBulkRunner } from './hooks/useBulkRunner';
import { useClipboard } from './hooks/useClipboard';
import { fetchListing, invalidateListings } from './hooks/useDirListing';
import { useMediaQuery } from './hooks/useMediaQuery';
import { useMemoryNav } from './hooks/useMemoryNav';
import { useNavHistory } from './hooks/useNavHistory';
import { useSplitUrl } from './hooks/useSplitUrl';
import { usePins } from './hooks/usePins';
import { clipboardAfterMove, clipboardStore, type ClipItem } from './logic/clipboard';
import type { PaneNav } from './logic/paneHistory';
import { addPin } from './logic/pins';
import { dropLabel } from './logic/hints';
import { DEFAULT_SORT, parseSort, type SortSpec } from './logic/sort';
import { parseFilesHash, type FilesHash } from './logic/splitHash';
import { planToOther } from './logic/toOther';
import { planUploadTree, type UploadPlan } from './logic/upload';
import { NewFolderModal, RenameModal } from './dialogs/NameModals';
import { CopyMoveModal } from './dialogs/CopyMoveModal';
import { FileEditor } from './dialogs/FileEditor';
import { PermsModal } from './dialogs/PermsModal';
import { SendToModal } from './dialogs/SendToModal';
import { ShortcutSheet } from './dialogs/ShortcutSheet';
import { TransferFooter } from './dialogs/TransferFooter';
import { TrashModal } from './dialogs/TrashModal';

// FilesTab — the explorer shell. It renders one FilePane, or two side by
// side in split view, and owns everything the panes share: the sidebar,
// clipboard, dialogs, context menu, bulk runner, transfers and the URL.
//
// Paths are HOST-relative (/etc/hosts); the outpost maps them through
// /hostfs. The outpost enforces roles; canControl/canAdmin only grey out
// actions so users get feedback instead of a 403.

interface FilesTabProps {
  serverId: string;
  servers: readonly ServerSummary[];
  onSelectServer(id: string): void;
}

type Modal =
  | { kind: 'new'; pane: PaneId; what: 'folder' | 'file'; parent: string }
  | { kind: 'rename'; pane: PaneId; entry: FsEntry }
  | { kind: 'copyMove'; pane: PaneId; entry: FsEntry; mode: 'copy' | 'move' }
  | { kind: 'edit'; pane: PaneId; entry: FsEntry }
  | { kind: 'sendTo'; pane: PaneId; entry: FsEntry }
  | { kind: 'perms'; pane: PaneId; entry: FsEntry }
  | { kind: 'trashBin'; pane: PaneId };

interface MenuState {
  x: number;
  y: number;
  targets: FsEntry[];
  pane: PaneId;
}

const SORT_STORAGE_KEY = 'vantage.files.sort';

function loadSort(): SortSpec {
  try {
    return parseSort(localStorage.getItem(SORT_STORAGE_KEY));
  } catch {
    return DEFAULT_SORT;
  }
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // navigator.clipboard needs a secure context; plain-http LAN installs
    // fall back to a prompt the user can copy from.
    window.prompt('Copy path', text);
  }
}

const toClip = (list: readonly FsEntry[]): ClipItem[] =>
  list.map((e) => ({ path: e.path, isDir: e.type === 'dir', size: e.size, type: e.type }));

const otherOf = (pane: PaneId): PaneId => (pane === 'left' ? 'right' : 'left');

export function FilesTab({ serverId, servers, onSelectServer }: FilesTabProps) {
  const canControl = useCan('operator');
  const canAdmin = useCan('admin');
  const wide = useMediaQuery('(min-width: 768px)');

  // --- panes, servers, navigation -------------------------------------------
  const [initial] = React.useState<FilesHash>(
    () => parseFilesHash(window.location.hash) ?? { mode: 'single', path: ROOT },
  );
  const leftStart = initial.mode === 'split' ? initial.left : initial.path;
  const [split, setSplit] = React.useState(initial.mode === 'split');
  const [active, setActive] = React.useState<PaneId>('left');
  const [rightServerId, setRightServerId] = React.useState(
    initial.mode === 'split' ? initial.rightServer : serverId,
  );
  const browserNav = useNavHistory({ enabled: !split, initialPath: leftStart });
  const leftMem = useMemoryNav(leftStart);
  const rightMem = useMemoryNav(initial.mode === 'split' ? initial.right : leftStart);

  const navOf = (pane: PaneId): PaneNav => (pane === 'right' ? rightMem : split ? leftMem : browserNav);
  const serverOf = (pane: PaneId): string => (pane === 'right' ? rightServerId : serverId);
  const activePane: PaneId = split ? active : 'left';
  const activeServer = serverOf(activePane);
  const activeNav = navOf(activePane);
  const serverName = (id: string) => servers.find((s) => s.id === id)?.name ?? id;
  const leftRoot = React.useRef<HTMLDivElement>(null);
  const rightRoot = React.useRef<HTMLDivElement>(null);
  const rootOf = (pane: PaneId) => (pane === 'left' ? leftRoot : rightRoot);

  // Split view keeps both panes in the URL and survives browser Back/Forward.
  useSplitUrl(split, leftMem.path, rightServerId, rightMem.path);

  // The right pane's server was removed in Settings: fall back.
  const resetRight = rightMem.reset;
  React.useEffect(() => {
    if (servers.length > 0 && !servers.some((s) => s.id === rightServerId)) {
      setRightServerId(serverId);
      resetRight(ROOT);
    }
  }, [servers, rightServerId, serverId, resetRight]);

  const toggleSplit = () => {
    if (!split) {
      if (!wide) return;
      const here = browserNav.path;
      leftMem.reset(here);
      rightMem.reset(here);
      setRightServerId(serverId);
      setActive('left');
      try {
        if (localStorage.getItem('vantage.files.splitTipSeen') !== '1') setTipOpen(true);
      } catch {
        setTipOpen(true);
      }
      setSplit(true);
      return;
    }
    // Leaving split keeps the active pane as the single pane.
    const keepPath = navOf(activePane).path;
    const keepServer = serverOf(activePane);
    if (keepServer !== serverId) onSelectServer(keepServer);
    browserNav.reset(keepPath);
    setActive('left');
    setTipOpen(false);
    setSplit(false);
  };

  // --- shared state -----------------------------------------------------------
  const clipboard = useClipboard();
  const { pins, save: savePins, error: pinsError } = usePins(activeServer);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const sidebar = useSidebarWidth(bodyRef, split);
  // Desktop: the card fills the window so only the list and sidebar scroll.
  const cardRef = React.useRef<HTMLDivElement>(null);
  const cardHeight = useFillHeight(cardRef, 24);
  const [showHidden, setShowHidden] = React.useState(false);
  const [sort, setSort] = React.useState<SortSpec>(loadSort);
  const [banner, setBanner] = React.useState<string | null>(null);
  const [status, setStatus] = React.useState<string | null>(null);
  const [modal, setModal] = React.useState<Modal | null>(null);
  const [menu, setMenu] = React.useState<MenuState | null>(null);
  const [helpOpen, setHelpOpen] = React.useState(false);
  const [showHints, setShowHints] = React.useState(() => {
    try {
      return localStorage.getItem('vantage.files.hints') !== 'off';
    } catch {
      return true;
    }
  });
  const [tipOpen, setTipOpen] = React.useState(false);
  const setHints = (on: boolean) => {
    setShowHints(on);
    try {
      localStorage.setItem('vantage.files.hints', on ? 'on' : 'off');
    } catch {
      // per-viewer convenience only
    }
  };
  const dismissTip = () => {
    setTipOpen(false);
    try {
      localStorage.setItem('vantage.files.splitTipSeen', '1');
    } catch {
      // per-viewer convenience only
    }
  };
  const [transfers, setTransfers] = React.useState<Record<string, TransferProgress>>({});
  const [mutationKey, setMutationKey] = React.useState(0);
  const uploadFilesRef = React.useRef<HTMLInputElement>(null);
  const uploadFolderRef = React.useRef<HTMLInputElement>(null);
  const uploadTarget = React.useRef<PaneId>('left');
  const activeRef = React.useRef(activePane);
  activeRef.current = activePane;

  React.useEffect(() => {
    if (pinsError) setBanner(`Pins: ${pinsError}`);
  }, [pinsError]);

  React.useEffect(() => {
    try {
      localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
    } catch {
      // per-viewer convenience only
    }
  }, [sort]);

  React.useEffect(() => {
    uploadFolderRef.current?.setAttribute('webkitdirectory', '');
  }, []);

  React.useEffect(() => installFileDropGuard(window), []);

  React.useEffect(() => {
    setSidebarOpen(false);
  }, [activeNav.path, activeServer]);

  // --- mutations ------------------------------------------------------------
  const bump = React.useCallback(() => setMutationKey((k) => k + 1), []);
  const afterMutation = React.useCallback(
    async (sid: string, dirs: readonly string[]) => {
      invalidateListings(sid, dirs);
      bump();
    },
    [bump],
  );
  const leftAfter = React.useCallback((dirs: readonly string[]) => afterMutation(serverId, dirs), [afterMutation, serverId]);
  const rightAfter = React.useCallback((dirs: readonly string[]) => afterMutation(rightServerId, dirs), [afterMutation, rightServerId]);
  const refreshAll = React.useCallback(async () => bump(), [bump]);

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

  const onError = React.useCallback((m: string) => setBanner(m), []);
  const onBusy = React.useCallback(() => setBanner('Finish or close the current operation first.'), []);
  const { runBulk, askConflict, claim, release, dialogs: bulkDialogs } = useBulkRunner(bump, onBusy, onError);
  const leftActions = useFileActions({ serverId, runBulk, afterMutation: leftAfter, onError });
  const rightActions = useFileActions({ serverId: rightServerId, runBulk, afterMutation: rightAfter, onError });
  const actionsOf = (pane: PaneId) => (pane === 'right' ? rightActions : leftActions);

  const crossDeps: CrossDeps = {
    api: defaultCrossApi,
    runBulk,
    askConflict,
    confirm: (m) => window.confirm(m),
    onError,
    onStatus: setStatus,
    claim,
    release,
    // A cut from another server leaves the clipboard only once its items
    // have really moved; whatever was kept stays ready to paste again.
    onMoved: (sid, paths) => {
      const before = clipboardStore.get();
      const after = clipboardAfterMove(before, sid, paths);
      if (after !== before) clipboardStore.set(after);
    },
    afterMutation,
  };

  // Cross-server runs can be cancelled while they scan (status line Cancel,
  // or leaving the Files tab).
  const scanAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => scanAbort.current?.abort(), []);
  const startCross = (
    src: DropSource,
    dst: { serverId: string; dir: string; label: string },
    mode: 'copy' | 'move',
  ) => {
    const ctrl = new AbortController();
    // Only an accepted run takes over Cancel: a second one refused while the
    // first is scanning must not leave Cancel pointing at itself.
    const onStart = () => {
      scanAbort.current = ctrl;
    };
    void runCrossTransfer({ ...crossDeps, signal: ctrl.signal, onStart }, src, dst, mode)
      .catch((e: unknown) => crossDeps.onError(e instanceof Error ? e.message : String(e)))
      .finally(() => {
        if (scanAbort.current === ctrl) scanAbort.current = null;
      });
  };

  // --- commands ---------------------------------------------------------------
  const moveItems = (src: DropSource, dstPane: PaneId, dir: string, mode: 'copy' | 'move') => {
    const dstServer = serverOf(dstPane);
    if (src.serverId === dstServer) {
      void actionsOf(dstPane).transfer(src.items.map((i) => ({ path: i.path, isDir: i.isDir })), dir, mode);
    } else {
      startCross(src, { serverId: dstServer, dir, label: `${serverName(dstServer)}:${dir}` }, mode);
    }
  };

  const toOther = (pane: PaneId, entries: FsEntry[], mode: 'copy' | 'move') => {
    if (!split || entries.length === 0) return;
    const dst = otherOf(pane);
    const srcAt = { serverId: serverOf(pane), dir: navOf(pane).path };
    const dstAt = { serverId: serverOf(dst), dir: navOf(dst).path };
    switch (planToOther(srcAt, dstAt, mode)) {
      case 'copy-in-place':
        void actionsOf(pane).paste({ serverId: srcAt.serverId, mode: 'copy', items: toClip(entries) }, srcAt.dir);
        break;
      case 'refuse-same-folder':
        setBanner('Already in this folder — both panes show the same place.');
        break;
      default:
        moveItems({ serverId: srcAt.serverId, items: toClip(entries) }, dst, dstAt.dir, mode);
    }
  };

  const pasteInto = (pane: PaneId, dir: string) => {
    const c = clipboard.current;
    if (!c) return;
    if (c.serverId === serverOf(pane)) {
      void actionsOf(pane).paste(c, dir);
      return;
    }
    startCross(
      { serverId: c.serverId, items: c.items },
      { serverId: serverOf(pane), dir, label: `${serverName(serverOf(pane))}:${dir}` },
      c.mode === 'cut' ? 'move' : 'copy',
    );
  };

  const externalDrop = (pane: PaneId, dt: DataTransfer, dir: string) => {
    collectDropped(dt).then(
      (plan) => void actionsOf(pane).upload(plan, dir),
      (e: unknown) => setBanner(`Could not read the dropped items: ${e instanceof Error ? e.message : String(e)}`),
    );
  };

  const openEntry = (pane: PaneId, e: FsEntry) => {
    const nav = navOf(pane);
    if (e.type === 'dir') {
      nav.go(e.path);
    } else if (e.type === 'symlink') {
      fetchListing(serverOf(pane), e.path).then(
        () => nav.go(e.path),
        () => {
          if (!e.broken) setModal({ kind: 'edit', pane, entry: e });
        },
      );
    } else if (e.type === 'file') {
      if (e.size <= EDITOR_MAX_BYTES) setModal({ kind: 'edit', pane, entry: e });
      else actionsOf(pane).download([e]);
    }
  };

  const confirmTrash = (pane: PaneId, list: readonly FsEntry[]) => {
    if (list.length === 0) return;
    const q = list.length === 1 ? `Move "${list[0]!.name}" to trash?` : `Move ${list.length} items to trash?`;
    if (!window.confirm(q)) return;
    void actionsOf(pane).trash(list);
  };

  const startUpload = (pane: PaneId, folder: boolean) => {
    uploadTarget.current = pane;
    (folder ? uploadFolderRef : uploadFilesRef).current?.click();
  };

  const uploadFromInput = (files: FileList | null, folder: boolean) => {
    if (!files || files.length === 0) return;
    const list = Array.from(files);
    const plan: UploadPlan = folder
      ? planUploadTree(list.map((f) => ({ relPath: f.webkitRelativePath || f.name, file: f })))
      : { dirs: [], files: list.map((file) => ({ relDir: '', file })) };
    const pane = uploadTarget.current;
    void actionsOf(pane).upload(plan, navOf(pane).path);
  };

  const menuCtxFor = (pane: PaneId): MenuCtx => {
    const a = actionsOf(pane);
    const sid = serverOf(pane);
    return {
      canControl,
      canAdmin,
      hasClipboard: clipboard.current !== null,
      showHidden,
      open: (e) => openEntry(pane, e),
      edit: (e) => setModal({ kind: 'edit', pane, entry: e }),
      download: (list) => a.download(list),
      cut: (list) => clipboard.set({ serverId: sid, mode: 'cut', items: toClip(list) }),
      copy: (list) => clipboard.set({ serverId: sid, mode: 'copy', items: toClip(list) }),
      paste: (dir) => pasteInto(pane, dir),
      rename: (e) => setModal({ kind: 'rename', pane, entry: e }),
      copyTo: (e) => setModal({ kind: 'copyMove', pane, entry: e, mode: 'copy' }),
      moveTo: (e) => setModal({ kind: 'copyMove', pane, entry: e, mode: 'move' }),
      copyPath: (e) => void copyText(e.path),
      pin: (e) => void savePins(addPin(pins, e.path)),
      sendTo: (e) => setModal({ kind: 'sendTo', pane, entry: e }),
      perms: (e) => setModal({ kind: 'perms', pane, entry: e }),
      trash: (list) => confirmTrash(pane, list),
      newItem: (what, dir) => setModal({ kind: 'new', pane, what, parent: dir }),
      uploadFiles: () => startUpload(pane, false),
      uploadFolder: () => startUpload(pane, true),
      refresh: () => void afterMutation(sid, [navOf(pane).path]),
      toggleHidden: () => setShowHidden((v) => !v),
      openTrashBin: () => setModal({ kind: 'trashBin', pane }),
      ...(split ? { toOther: (list: readonly FsEntry[], mode: 'copy' | 'move') => toOther(pane, [...list], mode) } : {}),
    };
  };

  const handleCommand = (pane: PaneId, c: PaneCommand) => {
    switch (c.type) {
      case 'open':
        openEntry(pane, c.entry);
        break;
      case 'menu':
        setMenu({ x: c.x, y: c.y, targets: c.targets, pane });
        break;
      case 'trash':
        confirmTrash(pane, c.entries);
        break;
      case 'rename':
        setModal({ kind: 'rename', pane, entry: c.entry });
        break;
      case 'newItem':
        setModal({ kind: 'new', pane, what: c.what, parent: navOf(pane).path });
        break;
      case 'upload':
        startUpload(pane, c.folder);
        break;
      case 'clipboard':
        clipboard.set({ serverId: serverOf(pane), mode: c.mode, items: toClip(c.entries) });
        break;
      case 'clearCut':
        if (clipboard.current?.mode === 'cut') clipboard.set(null);
        break;
      case 'paste':
        pasteInto(pane, navOf(pane).path);
        break;
      case 'toOther':
        toOther(pane, c.entries, c.mode);
        break;
      case 'toggleSplit':
        toggleSplit();
        break;
      case 'switchPane':
        if (split) {
          const next = otherOf(pane);
          setActive(next);
          rootOf(next).current?.focus();
        }
        break;
      case 'help':
        setHelpOpen(true);
        break;
    }
  };

  const closeMenu = React.useCallback(() => {
    setMenu(null);
    (activeRef.current === 'right' ? rightRoot : leftRoot).current?.focus();
  }, []);
  const menuItems: MenuEntry[] = menu
    ? menu.targets.length > 0
      ? itemMenu(menu.targets, menuCtxFor(menu.pane))
      : backgroundMenu(navOf(menu.pane).path, menuCtxFor(menu.pane))
    : [];

  // Drops on the sidebar act on the active pane's server.
  const sidebarDnd = useDnd({
    serverId: activeServer,
    canControl,
    dragItems: () => [],
    onDropItems: (src, dir, mode) => moveItems(src, activeRef.current, dir, mode),
    onExternalDrop: (dt, dir) => externalDrop(activeRef.current, dt, dir),
    onPinDrop: (dirs) => void savePins(dirs.reduce(addPin, pins)),
  });

  const renderPane = (pane: PaneId) => (
    <FilePane
      key={pane}
      paneId={pane}
      serverId={serverOf(pane)}
      servers={servers}
      onServerChange={(id) => {
        if (pane === 'left') {
          onSelectServer(id);
        } else {
          setRightServerId(id);
          rightMem.reset(ROOT);
        }
      }}
      nav={navOf(pane)}
      split={split}
      canSplit={wide}
      active={activePane === pane}
      onActivate={() => setActive(pane)}
      rootRef={rootOf(pane)}
      canControl={canControl}
      showHidden={showHidden}
      onShowHidden={setShowHidden}
      sort={sort}
      onSort={setSort}
      mutationKey={mutationKey}
      clipboard={clipboard.current}
      blocked={modal !== null || menu !== null || helpOpen}
      onDropItems={(src, dir, mode) => moveItems(src, pane, dir, mode)}
      onExternalDrop={(dt, dir) => externalDrop(pane, dt, dir)}
      onCommand={(c) => handleCommand(pane, c)}
      onToggleSidebar={() => setSidebarOpen((v) => !v)}
      otherTarget={split ? `${serverName(serverOf(otherOf(pane)))}:${navOf(otherOf(pane)).path}` : null}
      serverLabel={serverName(serverOf(pane))}
      showHints={showHints}
      onHideHints={() => setHints(false)}
      {...(pane === 'right' && tipOpen
        ? {
            tip: (
              <div className="flex items-start gap-2 border-b bg-primary/5 px-3 py-2 text-xs">
                <span className="flex-1">
                  Pick a server and folder here. Tab switches panes; F5/F6 copy/move across.
                </span>
                <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Dismiss tip" onClick={dismissTip}>
                  ✕
                </button>
              </div>
            ),
          }
        : {})}
    />
  );

  return (
    <div className="space-y-3">

      {banner && (
        <div className="flex items-start justify-between gap-2 rounded border border-destructive/30 bg-destructive/5 px-3 py-1.5 text-xs text-destructive">
          <span>{banner}</span>
          <button
            type="button"
            aria-label="Dismiss"
            className="text-muted-foreground hover:text-foreground"
            onClick={() => setBanner(null)}
          >
            ×
          </button>
        </div>
      )}

      {status && (
        <div className="flex items-center justify-between gap-2 rounded border px-3 py-1.5 text-xs text-muted-foreground" role="status">
          <span>{status}</span>
          <button type="button" className="hover:text-foreground" onClick={() => scanAbort.current?.abort()}>
            Cancel
          </button>
        </div>
      )}

      <div ref={cardRef} {...(cardHeight !== undefined ? { style: { height: cardHeight } } : {})}>
        <Card className="flex h-full flex-col overflow-hidden">
          <div
            ref={bodyRef}
            className="flex min-h-[420px] flex-1 md:min-h-0"
            style={{ '--files-sidebar-w': `${sidebar.width}px` } as React.CSSProperties}
          >
            {sidebarOpen && (
              <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setSidebarOpen(false)} />
            )}
            <aside
              className={cn(
                'w-56 shrink-0 overflow-hidden border-r bg-muted/10 md:w-[var(--files-sidebar-w)]',
                sidebarOpen
                  ? 'fixed inset-y-0 left-0 z-40 block w-64 bg-background shadow-xl md:static md:z-auto md:bg-muted/10 md:shadow-none'
                  : 'hidden md:block',
              )}
            >
              <Sidebar
                serverId={activeServer}
                currentPath={activeNav.path}
                showHidden={showHidden}
                refreshKey={mutationKey}
                pins={pins}
                onPinsChange={(next) => void savePins(next)}
                onNavigate={(path) => {
                  setSidebarOpen(false);
                  activeNav.go(path);
                }}
                dropPropsFor={sidebarDnd.dropPropsFor}
                pinDropProps={sidebarDnd.pinDropProps}
                dropTarget={sidebarDnd.dropTarget}
                pinDropActive={sidebarDnd.dropTarget === PIN_TARGET}
              />
            </aside>
            {/* Resize handle: sits over the sidebar's border, desktop only. */}
            <div
              {...sidebar.handleProps}
              className={cn(
                'relative z-10 -ml-[3px] hidden w-[5px] shrink-0 cursor-col-resize touch-none outline-none transition-colors md:block',
                'hover:bg-primary/30 focus-visible:bg-primary/40',
                sidebar.dragging && 'bg-primary/50',
              )}
            />
            {split && !wide ? (
              <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                <div className="flex border-b text-xs" role="tablist">
                  {(['left', 'right'] as const).map((pane) => (
                    <button
                      key={pane}
                      type="button"
                      role="tab"
                      aria-selected={activePane === pane}
                      onClick={() => setActive(pane)}
                      className={cn(
                        'flex-1 truncate px-2 py-1.5',
                        activePane === pane ? 'border-b-2 border-primary font-semibold' : 'text-muted-foreground',
                      )}
                    >
                      {pane === 'left' ? 'Left' : 'Right'} · {serverName(serverOf(pane))}
                    </button>
                  ))}
                </div>
                {renderPane(activePane)}
              </div>
            ) : (
              <>
                {renderPane('left')}
                {split && renderPane('right')}
              </>
            )}
          </div>
        </Card>
      </div>
      {sidebarDnd.hover && sidebarDnd.hover.dir !== PIN_TARGET && (
        <div
          className="pointer-events-none fixed z-50 rounded border bg-popover px-2 py-1 text-[11px] text-popover-foreground shadow"
          style={{ left: sidebarDnd.hover.x + 14, top: sidebarDnd.hover.y + 14 }}
        >
          {dropLabel({
            mode: sidebarDnd.hover.mode,
            count: sidebarDnd.hover.count,
            target: split ? `${serverName(activeServer)}:${sidebarDnd.hover.dir}` : sidebarDnd.hover.dir,
          })}
        </div>
      )}

      <input
        ref={uploadFilesRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          uploadFromInput(e.target.files, false);
          e.target.value = '';
        }}
      />
      <input
        ref={uploadFolderRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          uploadFromInput(e.target.files, true);
          e.target.value = '';
        }}
      />

      {modal?.kind === 'new' && (
        <NewFolderModal
          parent={modal.parent}
          what={modal.what}
          onCancel={() => setModal(null)}
          onSubmit={(name) => {
            setModal(null);
            void actionsOf(modal.pane).create(modal.parent, name, modal.what);
          }}
        />
      )}
      {modal?.kind === 'rename' && (
        <RenameModal
          entry={modal.entry}
          onCancel={() => setModal(null)}
          onSubmit={(name) => {
            setModal(null);
            void actionsOf(modal.pane).rename(modal.entry, name);
          }}
        />
      )}
      {modal?.kind === 'copyMove' && (
        <CopyMoveModal
          entry={modal.entry}
          mode={modal.mode}
          onCancel={() => setModal(null)}
          onSubmit={(dst, overwrite) => {
            setModal(null);
            void actionsOf(modal.pane).copyOrMoveTo(modal.entry, dst, modal.mode, overwrite);
          }}
        />
      )}
      {modal?.kind === 'edit' && (
        <FileEditor
          serverId={serverOf(modal.pane)}
          entry={modal.entry}
          canSave={canControl}
          onClose={() => setModal(null)}
          onSaved={() => {
            setModal(null);
            bump();
          }}
        />
      )}
      {modal?.kind === 'sendTo' && (
        <SendToModal
          sourceServerId={serverOf(modal.pane)}
          entry={modal.entry}
          canPreserveOwnership={canAdmin}
          onCancel={() => setModal(null)}
          onStarted={(p) => {
            setModal(null);
            upsertTransfer(p);
          }}
        />
      )}
      {modal?.kind === 'trashBin' && (
        <TrashModal serverId={serverOf(modal.pane)} canAdmin={canAdmin} onClose={() => setModal(null)} onRestored={refreshAll} />
      )}
      {modal?.kind === 'perms' && (
        <PermsModal
          serverId={serverOf(modal.pane)}
          entry={modal.entry}
          onCancel={() => setModal(null)}
          onSaved={async () => {
            setModal(null);
            bump();
          }}
        />
      )}
      {helpOpen && (
        <ShortcutSheet
          canControl={canControl}
          onClose={() => setHelpOpen(false)}
          {...(showHints ? {} : { onShowHints: () => setHints(true) })}
        />
      )}

      {bulkDialogs}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}

      <TransferFooter
        transfers={transfers}
        onUpdate={upsertTransfer}
        onDismiss={dismissTransfer}
        onRefreshSource={refreshAll}
      />
    </div>
  );
}

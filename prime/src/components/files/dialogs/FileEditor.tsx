import * as React from 'react';
import type { FsEntry } from '@/types';
import { Button } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { fsRead, fsWrite } from '@/api';

interface FileEditorProps {
  serverId: string;
  entry: FsEntry;
  canSave: boolean;
  onClose: () => void;
  onSaved: () => void;
}

export function FileEditor({ serverId, entry, canSave, onClose, onSaved }: FileEditorProps) {
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


import * as React from 'react';
import { Button } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { BulkItem, ConflictChoice } from '../logic/bulk';

interface ConflictDialogProps {
  item: BulkItem;
  onAnswer: (choice: ConflictChoice, applyToAll: boolean) => void;
  onCancelAll: () => void;
}

export function ConflictDialog({ item, onAnswer, onCancelAll }: ConflictDialogProps) {
  const [applyToAll, setApplyToAll] = React.useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onCancelAll()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Item already exists</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 px-6 pb-4 text-xs">
          <p>
            <span className="font-mono">{item.label}</span> already exists in the destination.
          </p>
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="h-3 w-3"
              checked={applyToAll}
              onChange={(e) => setApplyToAll(e.target.checked)}
            />
            Apply to remaining conflicts
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={onCancelAll}>Cancel all</Button>
          <Button size="sm" variant="outline" onClick={() => onAnswer('skip', applyToAll)}>Skip</Button>
          <Button size="sm" variant="outline" onClick={() => onAnswer('keepBoth', applyToAll)}>Keep both</Button>
          <Button size="sm" onClick={() => onAnswer('replace', applyToAll)}>Replace</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

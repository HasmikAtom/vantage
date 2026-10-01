import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/primitives';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { SHORTCUT_GROUPS } from '../logic/hints';

interface ShortcutSheetProps {
  canControl: boolean;
  onClose: () => void;
  // When set, a button brings back hidden hint lines.
  onShowHints?: () => void;
}

export function ShortcutSheet({ canControl, onClose, onShowHints }: ShortcutSheetProps) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-sm">Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 px-6 pb-4 text-xs sm:grid-cols-2">
          {SHORTCUT_GROUPS.map((g) => (
            <section key={g.title}>
              <h4 className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{g.title}</h4>
              <table className="w-full">
                <tbody>
                  {g.rows.map((r) => (
                    <tr key={r.keys + r.action} className={cn(r.operator && !canControl && 'opacity-40')}>
                      <td className="whitespace-nowrap py-0.5 pr-3 font-mono text-[11px]">{r.keys}</td>
                      <td className="py-0.5">
                        {r.action}
                        {r.operator && <span className="ml-1 text-[10px] text-muted-foreground">(operator)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <DialogFooter>
          {onShowHints && (
            <Button size="sm" variant="outline" onClick={onShowHints}>Show hint line</Button>
          )}
          <Button size="sm" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

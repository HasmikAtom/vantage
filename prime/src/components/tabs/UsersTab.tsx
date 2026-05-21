import * as React from 'react';
import type { DashboardSnapshot, Group, User } from '@/types';
import { cn } from '@/lib/utils';
import { Badge, Card, Input } from '../ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import { SearchIcon } from '../ui/icons';
import { SectionHeader } from '../SectionHeader';
import type { FloatingTooltip } from '@/hooks/useTooltip';

export interface UsersTabProps {
  snapshot: DashboardSnapshot;
  tt: FloatingTooltip;
}

type Filter = 'all' | 'human' | 'system';

export const UsersTab = ({ snapshot, tt }: UsersTabProps) => {
  const users = snapshot.users?.users ?? [];
  const groups = snapshot.users?.groups ?? [];

  const [filter, setFilter] = React.useState<Filter>('human');
  const [query, setQuery] = React.useState('');

  const humans = users.filter((u) => !u.system).length;
  const systemAccounts = users.length - humans;

  const filteredUsers = users.filter((u) => {
    if (filter === 'human' && u.system) return false;
    if (filter === 'system' && !u.system) return false;
    if (query) {
      const q = query.toLowerCase();
      if (
        !u.username.toLowerCase().includes(q) &&
        !u.gecos.toLowerCase().includes(q) &&
        !u.groups.some((g) => g.toLowerCase().includes(q))
      ) {
        return false;
      }
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* summary tiles */}
      <div className="grid grid-cols-3 gap-3">
        <SummaryTile label="Total accounts" value={users.length} />
        <SummaryTile label="Human accounts" value={humans} hint="UID ≥ 1000 with interactive shell" />
        <SummaryTile label="Groups" value={groups.length} />
      </div>

      {/* users table */}
      <div>
        <SectionHeader
          label="System users"
          count={`${filteredUsers.length} shown · ${users.length} total`}
          right={
            <div className="flex items-center gap-2">
              <FilterPill active={filter === 'human'} onClick={() => setFilter('human')}>
                Human ({humans})
              </FilterPill>
              <FilterPill active={filter === 'system'} onClick={() => setFilter('system')}>
                System ({systemAccounts})
              </FilterPill>
              <FilterPill active={filter === 'all'} onClick={() => setFilter('all')}>
                All
              </FilterPill>
              <div className="relative">
                <SearchIcon
                  size={12}
                  className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground/60"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="filter…"
                  className="h-7 w-44 pl-7 text-xs"
                />
              </div>
            </div>
          }
        />
        <Card className="overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[140px]">User</TableHead>
                <TableHead className="w-[140px]">Name</TableHead>
                <TableHead className="w-[70px] text-right">UID</TableHead>
                <TableHead className="w-[70px] text-right">GID</TableHead>
                <TableHead>Groups</TableHead>
                <TableHead className="w-[180px]">Home</TableHead>
                <TableHead className="w-[140px]">Shell</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredUsers.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-xs text-muted-foreground py-6">
                    No accounts match.
                  </TableCell>
                </TableRow>
              ) : (
                filteredUsers.map((u) => <UserRow key={u.username} user={u} tt={tt} />)
              )}
            </TableBody>
          </Table>
        </Card>
      </div>

      {/* groups */}
      <div>
        <SectionHeader label="Groups" count={`${groups.length} total`} />
        <Card className="overflow-hidden">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-x-6 gap-y-2 p-4">
            {groups.map((g) => (
              <GroupChip key={g.name} group={g} tt={tt} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
};

function SummaryTile({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <Card className="p-3">
      <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="font-serif text-2xl font-medium leading-none tabular-nums mt-1">{value}</div>
      {hint && (
        <div className="font-mono text-[10px] text-muted-foreground/70 mt-2">{hint}</div>
      )}
    </Card>
  );
}

function FilterPill({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'font-mono text-[10px] uppercase tracking-wider px-2 py-1 rounded border transition-colors',
        active
          ? 'bg-muted text-foreground border-border'
          : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-muted/60',
      )}
    >
      {children}
    </button>
  );
}

function UserRow({ user, tt }: { user: User; tt: FloatingTooltip }) {
  const primary = user.groups[0];
  const supp = user.groups.slice(1);
  const shellShort = user.shell.replace(/^.*\//, '');
  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium">{user.username}</span>
          {!user.system && <Badge variant="muted" className="text-[9px]">human</Badge>}
        </div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{user.gecos || '—'}</TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums">{user.uid}</TableCell>
      <TableCell className="text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {user.gid}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {primary && (
            <span
              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20"
              onMouseEnter={(e) => tt.show(`primary group · gid ${user.gid}`, e)}
              onMouseLeave={tt.hide}
            >
              {primary}
            </span>
          )}
          {supp.map((g) => (
            <span
              key={g}
              className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
            >
              {g}
            </span>
          ))}
        </div>
      </TableCell>
      <TableCell className="font-mono text-[10px] text-muted-foreground truncate">
        {user.home || '—'}
      </TableCell>
      <TableCell className="font-mono text-[10px] text-muted-foreground truncate">
        {shellShort || '—'}
      </TableCell>
    </TableRow>
  );
}

function GroupChip({ group, tt }: { group: Group; tt: FloatingTooltip }) {
  const memberCount = group.members.length;
  const preview =
    memberCount === 0
      ? '(no members)'
      : group.members.slice(0, 6).join(', ') + (memberCount > 6 ? `, +${memberCount - 6} more` : '');
  return (
    <div
      className="flex items-baseline justify-between gap-2"
      onMouseEnter={(e) =>
        tt.show(`gid ${group.gid} · ${memberCount} member${memberCount === 1 ? '' : 's'}: ${preview}`, e)
      }
      onMouseLeave={tt.hide}
    >
      <span className="font-mono text-xs">{group.name}</span>
      <span className="font-mono text-[10px] text-muted-foreground/70 tabular-nums shrink-0">
        gid {group.gid} · {memberCount}
      </span>
    </div>
  );
}

import type { ColumnDef } from '@tanstack/react-table';
import { ArrowUpDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { LogEventSummary } from '@/lib/api';

function LevelBadge({ level }: { level: LogEventSummary['level'] }) {
  if (level === 'error') {
    return <Badge variant="destructive">error</Badge>;
  }
  return <Badge variant="outline">info</Badge>;
}

function StatusBadge({ statusClass }: { statusClass: LogEventSummary['statusClass'] }) {
  if (statusClass === '2xx') return <Badge variant="outline">2xx</Badge>;
  if (statusClass === '4xx') return <Badge variant="secondary">4xx</Badge>;
  if (statusClass === '5xx') return <Badge variant="destructive">5xx</Badge>;
  return <Badge variant="secondary">network</Badge>;
}

export function createLogsColumns(
  onSortChange: (next: 'time_desc' | 'time_asc') => void,
  sort: 'time_desc' | 'time_asc'
): ColumnDef<LogEventSummary>[] {
  return [
    {
      accessorKey: 'ts',
      header: () => (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-1"
          onClick={() => onSortChange(sort === 'time_desc' ? 'time_asc' : 'time_desc')}
        >
          时间
          <ArrowUpDown className="h-3.5 w-3.5" />
        </Button>
      ),
      cell: ({ row }) => {
        const value = row.original.ts;
        return <div className="text-xs tabular-nums">{new Date(value).toLocaleString()}</div>;
      },
    },
    {
      accessorKey: 'level',
      header: '级别',
      cell: ({ row }) => <LevelBadge level={row.original.level} />,
    },
    {
      accessorKey: 'provider',
      header: 'Provider',
      cell: ({ row }) => (
        <div className="max-w-[140px] truncate text-xs" title={row.original.provider}>
          {row.original.provider}
        </div>
      ),
    },
    {
      accessorKey: 'routeType',
      header: '路由',
      cell: ({ row }) => (
        <div className="max-w-[160px] truncate text-xs" title={row.original.routeType}>
          {row.original.routeType}
        </div>
      ),
    },
    {
      accessorKey: 'modelIn',
      header: '模型链路',
      cell: ({ row }) => (
        <div
          className="max-w-[260px] truncate font-mono text-xs"
          title={`${row.original.modelIn} -> ${row.original.modelOut}`}
        >
          {row.original.modelIn}
          {' -> '}
          {row.original.modelOut}
        </div>
      ),
    },
    {
      accessorKey: 'message',
      header: '消息',
      cell: ({ row }) => (
        <div className="max-w-[400px] truncate text-xs" title={row.original.message}>
          {row.original.message}
        </div>
      ),
    },
    {
      accessorKey: 'latencyMs',
      header: '延迟',
      cell: ({ row }) => <div className="text-xs tabular-nums">{row.original.latencyMs} ms</div>,
    },
    {
      accessorKey: 'statusClass',
      header: '状态',
      cell: ({ row }) => <StatusBadge statusClass={row.original.statusClass} />,
    },
    {
      accessorKey: 'userKey',
      header: '用户',
      cell: ({ row }) => (
        <div
          className="max-w-[180px] truncate font-mono text-xs"
          title={row.original.userKey ?? '-'}
        >
          {row.original.userKey ?? '-'}
        </div>
      ),
    },
    {
      accessorKey: 'sessionId',
      header: '会话',
      cell: ({ row }) => (
        <div
          className="max-w-[220px] truncate font-mono text-xs"
          title={row.original.sessionId ?? '-'}
        >
          {row.original.sessionId ?? '-'}
        </div>
      ),
    },
    {
      accessorKey: 'requestId',
      header: 'Request ID',
      cell: ({ row }) => (
        <div className="max-w-[220px] truncate font-mono text-xs" title={row.original.requestId}>
          {row.original.requestId}
        </div>
      ),
    },
  ];
}

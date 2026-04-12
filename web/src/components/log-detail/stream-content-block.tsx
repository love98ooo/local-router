import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Copy } from 'lucide-react';
import { useMemo } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { StructuredDataBlock } from '@/components/log-detail/structured-data-block';
import { parseStreamLines } from '@/components/log-detail/utils';

interface StreamContentBlockProps {
  title: string;
  content: string | null;
  emptyText?: string;
}

// Estimate height for each line item (header + content + gap)
const ITEM_GAP = 8;
const ESTIMATED_ITEM_HEIGHT = 80 + ITEM_GAP;
// Threshold to enable virtualization
const VIRTUALIZATION_THRESHOLD = 50;

// CSS for edge fade mask
const EDGE_FADE_STYLE: React.CSSProperties = {
  maskImage: 'linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)',
  WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)',
};

export function StreamContentBlock({ title, content, emptyText }: StreamContentBlockProps) {
  const lines = useMemo(() => (content ? parseStreamLines(content) : []), [content]);

  // Parent ref for the virtualizer
  const parentRef = useRef<HTMLDivElement>(null);

  // Virtualizer setup
  const virtualizer = useVirtualizer({
    count: lines.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ITEM_HEIGHT,
    overscan: 5,
  });

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">
        {title} {lines.length > 0 && `(${lines.length} lines)`}
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={!content}
        onClick={async () => {
          if (!content) return;
          await navigator.clipboard.writeText(content);
          toast.success('已复制 stream content');
        }}
      >
        <Copy className="h-3.5 w-3.5" />
        复制
      </Button>
    </div>
  );

  if (!content || lines.length === 0) {
    return (
      <div className="space-y-1">
        {header}
        <pre className="rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all">
          {emptyText ?? '-'}
        </pre>
      </div>
    );
  }

  // For small datasets, render normally without virtualization
  if (lines.length < VIRTUALIZATION_THRESHOLD) {
    return (
      <div className="space-y-1">
        {header}
        <div className="space-y-2">
          {lines.map((line) => (
            <div key={`${line.lineNo}-${line.type}`} className="space-y-1 rounded-md border bg-background/80 p-2">
              <div className="text-[11px] text-muted-foreground">line {line.lineNo}</div>
              <StructuredDataBlock
                value={line.type === 'json' ? line.value : line.value}
                className="bg-muted/40"
              />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // For large datasets, use virtualization with edge fade mask
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="space-y-1">
      {header}
      <div
        ref={parentRef}
        className="max-h-[60vh] overflow-auto py-3"
        style={EDGE_FADE_STYLE}
      >
        <div
          style={{
            height: `${virtualizer.getTotalSize()}px`,
            width: '100%',
            position: 'relative',
          }}
        >
          {virtualItems.map((virtualItem) => {
            const line = lines[virtualItem.index];
            return (
              <div
                key={`${line.lineNo}-${line.type}-${virtualItem.index}`}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualItem.start}px)`,
                  paddingBottom: `${ITEM_GAP}px`,
                }}
                className="box-border"
              >
                <div className="space-y-1 rounded-md border bg-background/80 p-2">
                  <div className="text-[11px] text-muted-foreground">line {line.lineNo}</div>
                  <StructuredDataBlock
                    value={line.type === 'json' ? line.value : line.value}
                    className="bg-muted/40"
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

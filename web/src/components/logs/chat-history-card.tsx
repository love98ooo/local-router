import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import type { ParsedChatHistory } from '@/lib/log-chat-history/types';
import { ChatMessageItem } from './chat-message-item';

interface ChatHistoryCardProps {
  parsed: ParsedChatHistory;
}

// Threshold to enable virtualization
const VIRTUALIZATION_THRESHOLD = 30;
// Estimate height for each message item
const ESTIMATED_ITEM_HEIGHT = 128;

// CSS for edge fade mask
const EDGE_FADE_STYLE: React.CSSProperties = {
  maskImage: 'linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)',
  WebkitMaskImage: 'linear-gradient(to bottom, transparent, black 12px, black calc(100% - 12px), transparent)',
};

export function ChatHistoryCard({ parsed }: ChatHistoryCardProps) {
  const hasWarnings = parsed.warnings.length > 0;
  const messages = parsed.messages;

  // Parent ref for the virtualizer
  const parentRef = useRef<HTMLDivElement>(null);

  // Virtualizer setup
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ESTIMATED_ITEM_HEIGHT,
    overscan: 3,
  });

  const header = (
    <div className="border-b px-3 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-base font-semibold">Chat History</h3>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">messages: {parsed.messages.length}</Badge>
          <Badge variant="outline">input: {parsed.stats.inputCount}</Badge>
          <Badge variant="outline">output: {parsed.stats.outputCount}</Badge>
          {parsed.stats.streamEventCount > 0 ? (
            <Badge variant="outline">stream events: {parsed.stats.streamEventCount}</Badge>
          ) : null}
          {parsed.stats.streamPartial ? <Badge variant="secondary">stream partial</Badge> : null}
          <Badge variant={hasWarnings ? 'secondary' : 'outline'}>
            {hasWarnings ? `warnings: ${parsed.warnings.length}` : 'parse ok'}
          </Badge>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">由 request + response/stream 自动还原的消息历史</p>
    </div>
  );

  const warningsSection = hasWarnings ? (
    <div className="px-3 pt-3">
      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle>解析提示</AlertTitle>
        <AlertDescription>
          {parsed.warnings.map((warning) => (
            <div key={warning}>• {warning}</div>
          ))}
        </AlertDescription>
      </Alert>
    </div>
  ) : null;

  // For small datasets, render normally without virtualization
  if (messages.length < VIRTUALIZATION_THRESHOLD) {
    return (
      <section className="rounded-lg border bg-background">
        {header}
        <div className="space-y-3 px-3 py-3">
          {warningsSection}
          {messages.length === 0 ? (
            <pre className="max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs">
              无可还原的消息历史。
            </pre>
          ) : (
            <div className="space-y-2">
              {messages.map((message, index) => (
                <ChatMessageItem
                  key={`${index}-${message.role}-${message.source}`}
                  message={message}
                  index={index}
                />
              ))}
            </div>
          )}
        </div>
      </section>
    );
  }

  // For large datasets, use virtualization with edge fade mask
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <section className="rounded-lg border bg-background">
      {header}
      <div className="space-y-3 px-3">
        {warningsSection}
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
              const message = messages[virtualItem.index];
              return (
                <div
                  key={`${virtualItem.index}-${message.role}-${message.source}`}
                  ref={virtualizer.measureElement}
                  data-index={virtualItem.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualItem.start}px)`,
                    paddingBottom: '8px',
                  }}
                  className="box-border"
                >
                  <ChatMessageItem message={message} index={virtualItem.index} />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}

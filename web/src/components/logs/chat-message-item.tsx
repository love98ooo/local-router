import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type { NormalizedChatMessage, NormalizedContentBlock } from '@/lib/log-chat-history/types';

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function roleClassName(role: NormalizedChatMessage['role']): string {
  if (role === 'assistant') return 'border-sky-300/50 bg-sky-500/5';
  if (role === 'user') return 'border-emerald-300/50 bg-emerald-500/5';
  if (role === 'system') return 'border-violet-300/50 bg-violet-500/5';
  return 'border-amber-300/50 bg-amber-500/5';
}

function BlockContainer({
  title,
  defaultOpen = false,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-md border bg-muted/20">
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 w-full justify-between rounded-b-none rounded-t-md px-2">
            <span className="text-xs text-muted-foreground">{title}</span>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-2 pb-2">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function renderBlock(block: NormalizedContentBlock, index: number): React.ReactNode {
  if (block.type === 'text') {
    return (
      <pre key={index} className="overflow-auto rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">
        {block.text || '(empty text)'}
      </pre>
    );
  }

  if (block.type === 'thinking') {
    return (
      <BlockContainer key={index} title="thinking" defaultOpen={false}>
        <pre className="overflow-auto rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">
          {block.thinking || '(empty thinking)'}
        </pre>
        {block.signature ? (
          <pre className="mt-2 overflow-auto rounded-md border bg-background p-2 text-xs whitespace-pre-wrap">
            signature: {block.signature}
          </pre>
        ) : null}
      </BlockContainer>
    );
  }

  if (block.type === 'image') {
    return (
      <BlockContainer key={index} title="image" defaultOpen={false}>
        <div className="space-y-1 text-xs">
          <div>url: {block.url ?? '-'}</div>
          <div>mime: {block.mimeType ?? '-'}</div>
          <div>detail: {block.detail ?? '-'}</div>
        </div>
        {block.data ? (
          <pre className="mt-2 max-h-40 overflow-auto rounded-md border bg-background p-2 text-xs">
            {block.data.slice(0, 1200)}
            {block.data.length > 1200 ? '\n... (truncated)' : ''}
          </pre>
        ) : null}
      </BlockContainer>
    );
  }

  if (block.type === 'tool_use') {
    return (
      <BlockContainer key={index} title={`tool_use${block.partial ? ' (partial)' : ''}`} defaultOpen={false}>
        <div className="space-y-1 text-xs">
          <div>id: {block.id ?? '-'}</div>
          <div>name: {block.name ?? '-'}</div>
        </div>
        <pre className="mt-2 max-h-52 overflow-auto rounded-md border bg-background p-2 text-xs">
          {block.input !== undefined ? prettyJson(block.input) : (block.rawInput ?? '(no input)')}
        </pre>
      </BlockContainer>
    );
  }

  if (block.type === 'tool_result') {
    return (
      <BlockContainer key={index} title={`tool_result${block.isError ? ' (error)' : ''}`} defaultOpen={false}>
        <div className="space-y-1 text-xs">
          <div>tool_use_id: {block.toolUseId ?? '-'}</div>
        </div>
        <pre className="mt-2 max-h-52 overflow-auto rounded-md border bg-background p-2 text-xs">
          {prettyJson(block.content)}
        </pre>
      </BlockContainer>
    );
  }

  return (
    <BlockContainer key={index} title={block.label ?? 'unknown'} defaultOpen={false}>
      <pre className="max-h-52 overflow-auto rounded-md border bg-background p-2 text-xs">
        {prettyJson(block.raw)}
      </pre>
    </BlockContainer>
  );
}

export function ChatMessageItem({ message, index }: { message: NormalizedChatMessage; index: number }) {
  const blocksContent = (
    <div className="space-y-2">
      {message.blocks.length > 0 ? message.blocks.map((block, blockIndex) => renderBlock(block, blockIndex)) : null}
    </div>
  );

  return (
    <div className={cn('space-y-2 rounded-md border p-2', roleClassName(message.role))}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline">#{index + 1}</Badge>
        <Badge variant="outline">{message.role}</Badge>
        <Badge variant="outline">{message.source}</Badge>
        {message.meta?.stopReason ? <Badge variant="secondary">stop: {message.meta.stopReason}</Badge> : null}
        {message.meta?.partial ? <Badge variant="secondary">partial</Badge> : null}
      </div>

      {message.role === 'system' ? (
        <BlockContainer title="system content" defaultOpen={false}>
          {blocksContent}
        </BlockContainer>
      ) : (
        blocksContent
      )}
    </div>
  );
}

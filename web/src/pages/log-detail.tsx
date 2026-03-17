import { useNavigate, useParams } from '@tanstack/react-router';
import JsonView from '@uiw/react-json-view';
import { ArrowLeft, ChevronDown, Copy } from 'lucide-react';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ChatHistoryCard } from '@/components/logs/chat-history-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchLogEventDetail, type LogEventDetail } from '@/lib/api';
import { parseChatHistory } from '@/lib/log-chat-history/parse-chat-history';
import { cn } from '@/lib/utils';

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const JSON_VIEW_STYLE = {
  '--w-rjv-font-family':
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  '--w-rjv-background-color': 'transparent',
  '--w-rjv-color': 'var(--foreground)',
  '--w-rjv-border-left': '1px dashed var(--border)',
  '--w-rjv-line-color': 'var(--border)',
  '--w-rjv-arrow-color': 'var(--muted-foreground)',
  '--w-rjv-info-color': 'var(--muted-foreground)',
  '--w-rjv-curlybraces-color': 'var(--foreground)',
  '--w-rjv-brackets-color': 'var(--foreground)',
  '--w-rjv-colon-color': 'var(--muted-foreground)',
  '--w-rjv-key-string': 'var(--foreground)',
  '--w-rjv-type-string-color': 'oklch(0.52 0.16 250)',
  '--w-rjv-type-int-color': 'oklch(0.56 0.16 145)',
  '--w-rjv-type-float-color': 'oklch(0.56 0.16 145)',
  '--w-rjv-type-boolean-color': 'oklch(0.58 0.19 30)',
  '--w-rjv-type-null-color': 'var(--muted-foreground)',
  '--w-rjv-type-undefined-color': 'var(--muted-foreground)',
  '--w-rjv-type-date-color': 'oklch(0.56 0.16 145)',
  '--w-rjv-type-url-color': 'oklch(0.52 0.16 250)',
} as CSSProperties;

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

function captureReason(detail: LogEventDetail): string | null {
  if (detail.capture.bodyPolicy === 'off') {
    return 'Body 记录策略为 off，未记录请求/响应 body。';
  }
  if (detail.capture.bodyPolicy === 'full') {
    return 'Body 记录策略为 full，当前展示的是完整内容。';
  }
  if (detail.capture.bodyPolicy === 'masked') {
    return '当前配置中的 bodyPolicy=masked 会按完整内容展示。';
  }
  return null;
}

function getInterfaceType(routeType: string): string {
  if (routeType.startsWith('openai')) return 'openai';
  if (routeType.startsWith('anthropic')) return 'anthropic';
  return routeType;
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function stringifyBody(body: unknown): string | null {
  if (body == null) return null;
  return typeof body === 'string' ? body : JSON.stringify(body, null, 2);
}

function looksLikeJsonContentType(contentType?: string | null): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return normalized.includes('application/json') || normalized.includes('+json');
}

function looksLikeJsonText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  return /^(?:\{|\[|"|-?\d|true$|false$|null$)/.test(trimmed);
}

function parseJsonCandidate(
  value: unknown,
  contentType?: string | null
): {
  kind: 'empty' | 'json-tree' | 'json-primitive' | 'text';
  value?: unknown;
  text?: string;
} {
  if (value == null) return { kind: 'empty' };

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return { kind: 'text', text: value };
    }

    if (looksLikeJsonContentType(contentType) || looksLikeJsonText(trimmed)) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (parsed !== null && typeof parsed === 'object') {
          return { kind: 'json-tree', value: parsed };
        }
        return { kind: 'json-primitive', value: parsed };
      } catch {
        return { kind: 'text', text: value };
      }
    }

    return { kind: 'text', text: value };
  }

  if (typeof value === 'object') {
    return { kind: 'json-tree', value };
  }

  return { kind: 'json-primitive', value };
}

function normalizeHeaders(
  headers: Record<string, string>,
  mode: 'local-router' | 'provider'
): Array<[string, string]> {
  const filtered = Object.entries(headers).filter(([key]) => {
    const lower = key.toLowerCase();
    if (lower === 'content-length' || lower === 'host') return false;
    if (mode === 'provider' && (lower === 'authorization' || lower === 'x-api-key')) return false;
    return true;
  });

  return filtered.sort(([a], [b]) => a.localeCompare(b));
}

function getProviderAuthHeader(routeType: string): [string, string] {
  if (routeType.startsWith('anthropic')) {
    return ['x-api-key', '<PROVIDER_API_KEY>'];
  }
  return ['Authorization', 'Bearer <PROVIDER_API_KEY>'];
}

function restoreLocalRouterBody(detail: LogEventDetail): unknown {
  const body = detail.request.requestBody;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  return {
    ...body,
    model: detail.summary.modelIn,
  };
}

function buildCurlCommand(detail: LogEventDetail, mode: 'local-router' | 'provider'): string {
  const url =
    mode === 'provider'
      ? detail.upstream.targetUrl
      : new URL(detail.request.path, window.location.origin).toString();
  const body = mode === 'provider' ? detail.request.requestBody : restoreLocalRouterBody(detail);
  const bodyText = stringifyBody(body);
  const headers = normalizeHeaders(detail.request.requestHeaders ?? {}, mode);
  const authHeader = mode === 'provider' ? getProviderAuthHeader(detail.summary.routeType) : null;

  const lines = ['curl', `  -X ${detail.request.method}`, `  ${shellEscape(url)}`];

  headers.forEach(([key, value]) => {
    lines.push(`  -H ${shellEscape(`${key}: ${value}`)}`);
  });

  if (mode === 'provider' && authHeader) {
    lines.push(`  -H ${shellEscape(`${authHeader[0]}: ${authHeader[1]}`)}`);
    lines.push(`  -H ${shellEscape('accept-encoding: identity')}`);
  }

  if (bodyText !== null) {
    lines.push(`  --data-raw ${shellEscape(bodyText)}`);
  }

  return `${lines.join(' \\\n')}`;
}

export function LogDetailPage() {
  const navigate = useNavigate();
  const { id } = useParams({ from: '/logs/$id' });

  const [detail, setDetail] = useState<LogEventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDetail() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchLogEventDetail(id);
        if (!cancelled) {
          setDetail(data);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '日志详情加载失败');
          setLoading(false);
        }
      }
    }

    void loadDetail();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const hintText = useMemo(() => {
    if (!detail) return [];
    const hints = [...detail.capture.truncatedHints];
    const reason = captureReason(detail);
    if (reason) hints.unshift(reason);
    return hints;
  }, [detail]);

  const interfaceType = useMemo(
    () => (detail ? getInterfaceType(detail.summary.routeType) : '-'),
    [detail]
  );

  const parsedChatHistory = useMemo(() => {
    if (!detail) return null;
    return parseChatHistory(detail);
  }, [detail]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-56 w-full" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <Empty className="min-h-[240px] p-6 md:p-6">
        <EmptyHeader>
          <EmptyTitle>日志详情加载失败</EmptyTitle>
          <EmptyDescription>{error ?? '日志事件不存在'}</EmptyDescription>
        </EmptyHeader>
        <Button
          variant="outline"
          onClick={() => navigate({ to: '/logs', search: { user: undefined, session: undefined } })}
        >
          返回日志列表
        </Button>
      </Empty>
    );
  }

  const hasPlugins = Boolean(
    detail.plugins && (detail.plugins.request?.length || detail.plugins.response?.length)
  );

  return (
    <Tabs defaultValue="overview" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-background px-3 py-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate({ to: '/logs', search: { user: undefined, session: undefined } })}
        >
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>

        <TabsList variant="line" className="h-auto shrink-0">
          <TabsTrigger value="overview">概览</TabsTrigger>
          <TabsTrigger value="request-response">请求 / 响应</TabsTrigger>
          {hasPlugins ? <TabsTrigger value="plugins">插件</TabsTrigger> : null}
          <TabsTrigger value="session-tracing">会话 / 追踪</TabsTrigger>
          <TabsTrigger value="raw">Raw</TabsTrigger>
        </TabsList>

        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          onClick={async () => {
            await navigator.clipboard.writeText(prettyJson(detail.rawEvent));
            toast.success('已复制完整日志 JSON');
          }}
        >
          <Copy className="h-4 w-4" />
          复制 Raw JSON
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline">
              <Copy className="h-4 w-4" />
              Copy as cURL
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={async () => {
                await navigator.clipboard.writeText(buildCurlCommand(detail, 'local-router'));
                toast.success('已复制 local-router cURL');
              }}
            >
              复制发给 local-router 的请求
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={async () => {
                await navigator.clipboard.writeText(buildCurlCommand(detail, 'provider'));
                toast.success('已复制 provider cURL（API Key 为占位符）');
              }}
            >
              复制发给 provider 的请求
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <TabsContent value="overview" className="mt-0 space-y-4">
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">概览</h3>
            <p className="text-sm text-muted-foreground">核心元信息与定位字段</p>
          </div>
          <div className="space-y-3 px-3 py-3">
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">{detail.summary.level}</Badge>
              <Badge variant="outline">{detail.summary.provider}</Badge>
              <Badge variant="outline">{detail.summary.routeType}</Badge>
              <Badge variant="outline">{detail.summary.statusClass}</Badge>
              <Badge variant={detail.summary.hasError ? 'secondary' : 'outline'}>
                {detail.summary.upstreamStatus}
              </Badge>
            </div>

            <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <MetaItem label="时间" value={formatDateTime(detail.summary.ts)} />
              <MetaItem label="request_id" value={detail.summary.requestId} mono />
              <MetaItem label="model_in" value={detail.summary.modelIn} mono />
              <MetaItem label="model_out" value={detail.summary.modelOut} mono />
              <MetaItem label="route_rule_key" value={detail.summary.routeRuleKey} mono />
              <MetaItem label="latency" value={`${detail.summary.latencyMs} ms`} />
              <MetaItem label="target_url" value={detail.upstream.targetUrl} mono />
              <MetaItem label="proxy_url" value={detail.upstream.proxyUrl ?? '-'} mono />
              <MetaItem
                label="定位"
                value={`${detail.location.file}:${detail.location.line}`}
                mono
              />
            </div>

            {hintText.length > 0 ? (
              <div className="space-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                {hintText.map((hint) => (
                  <div key={hint}>• {hint}</div>
                ))}
              </div>
            ) : null}
          </div>
        </section>

        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">路由链路</h3>
            <p className="text-sm text-muted-foreground">入站请求到出站转发的完整可视化链路</p>
          </div>
          <div className="px-3 py-3">
            <RouteFlowCard
              interfaceType={interfaceType}
              routeType={detail.summary.routeType}
              modelIn={detail.summary.modelIn}
              provider={detail.summary.provider}
              modelOut={detail.summary.modelOut}
              routeRuleKey={detail.summary.routeRuleKey}
            />
          </div>
        </section>
      </TabsContent>

      <TabsContent value="request-response" className="mt-0 space-y-4">
        <RequestResponseFlowSections detail={detail} />
      </TabsContent>

      {hasPlugins ? (
        <TabsContent value="plugins" className="mt-0 space-y-4">
          <PluginPipelineSection detail={detail} />
        </TabsContent>
      ) : null}

      <TabsContent value="session-tracing" className="mt-0 space-y-4">
        {parsedChatHistory ? <ChatHistoryCard parsed={parsedChatHistory} /> : null}

        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">Upstream / Tracing</h3>
          </div>
          <div className="grid gap-2 px-3 py-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <MetaItem
              label="provider_request_id"
              value={detail.upstream.providerRequestId ?? '-'}
              mono
            />
            <MetaItem label="error_type" value={detail.upstream.errorType ?? '-'} mono />
            <MetaItem label="error_message" value={detail.upstream.errorMessage ?? '-'} />
            <MetaItem label="is_stream" value={detail.upstream.isStream ? 'true' : 'false'} />
            <MetaItem
              label="stream_file"
              value={detail.upstream.streamFile ?? '无 stream 数据'}
              mono
            />
          </div>
          <div className="px-3 pb-3">
            <StreamContentBlock
              title="stream content"
              content={detail.upstream.streamContent}
              emptyText={
                detail.upstream.isStream ? '未捕获 stream 内容。' : '非流式请求，无 stream 内容。'
              }
            />
          </div>
        </section>
      </TabsContent>

      <TabsContent value="raw" className="mt-0">
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">Raw</h3>
            <p className="text-sm text-muted-foreground">完整事件 JSON</p>
          </div>
          <div className="px-3 py-3">
            <JsonBlock title="event" value={detail.rawEvent} />
          </div>
        </section>
      </TabsContent>
    </Tabs>
  );
}

function FlowStepHeader({
  step,
  title,
  description,
}: {
  step: number;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-3 border-b px-3 py-3">
      <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {step}
      </div>
      <div>
        <h3 className="text-base font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

interface FlowStep {
  key: string;
  step: number;
  title: string;
  shortTitle: string;
  description: string;
  tag: 'request' | 'response';
  connector?: string;
}

function RequestResponseFlowSections({ detail }: { detail: LogEventDetail }) {
  const plugins = detail.plugins;
  const hasPlugins = Boolean(plugins && (plugins.request?.length || plugins.response?.length));
  const [activeStep, setActiveStep] = useState(1);

  const userRequestBody = restoreLocalRouterBody(detail);
  const providerRequestBody = plugins?.requestBodyAfterPlugins ?? detail.request.requestBody;
  const providerRequestUrl = plugins?.requestUrlAfterPlugins ?? detail.upstream.targetUrl;
  const providerResponseBody = plugins?.responseBodyBeforePlugins ?? detail.response.responseBody;
  const finalResponseBody = detail.response.responseBody;

  const steps: FlowStep[] = [
    {
      key: 'user-request',
      step: 1,
      title: '用户请求',
      shortTitle: '用户请求',
      description: '用户发送给 local-router 的原始请求（插件处理前）',
      tag: 'request',
      connector: hasPlugins
        ? `插件: ${plugins?.request?.map((p) => p.name).join(' → ') ?? '-'}`
        : undefined,
    },
    {
      key: 'provider-request',
      step: 2,
      title: '发送给 Provider 的请求',
      shortTitle: 'Provider 请求',
      description: `local-router 插件处理后最终发给 ${detail.summary.provider} 的请求`,
      tag: 'request',
      connector: `${detail.summary.provider} 处理`,
    },
    {
      key: 'provider-response',
      step: 3,
      title: 'Provider 响应',
      shortTitle: 'Provider 响应',
      description: `${detail.summary.provider} 返回给 local-router 的原始响应（插件处理前）`,
      tag: 'response',
      connector: hasPlugins
        ? `插件: ${plugins?.response ? [...plugins.response].reverse().map((p) => p.name).join(' → ') : '-'}`
        : undefined,
    },
    {
      key: 'final-response',
      step: 4,
      title: '最终响应',
      shortTitle: '最终响应',
      description: 'local-router 插件处理后最终返回给用户的响应',
      tag: 'response',
    },
  ];

  return (
    <div className="space-y-3 md:space-y-0">
      {/* Mobile step switcher */}
      <div className="flex gap-1 md:hidden">
        {steps.map((s) => (
          <button
            key={s.key}
            type="button"
            onClick={() => setActiveStep(s.step)}
            className={cn(
              'flex-1 rounded-md border px-2 py-1.5 text-center text-xs transition-colors',
              activeStep === s.step
                ? 'border-primary bg-primary/10 font-medium text-foreground'
                : 'text-muted-foreground hover:bg-muted/50'
            )}
          >
            <div className="font-medium">{s.step}</div>
            <div className="mt-0.5 truncate text-[10px]">{s.shortTitle}</div>
          </button>
        ))}
      </div>

      <div className="flex gap-5">
        {/* Left timeline - desktop only */}
        <div className="hidden w-44 shrink-0 md:block">
          <div className="sticky top-4 rounded-lg border bg-background px-2 py-3">
            <div className="relative flex flex-col">
              {steps.map((s, i) => (
                <div key={s.key} className="flex flex-col">
                  {/* Step node */}
                  <button
                    type="button"
                    onClick={() => setActiveStep(s.step)}
                    className={cn(
                      'group relative flex items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-all',
                      activeStep === s.step
                        ? 'bg-primary/8 shadow-sm ring-1 ring-primary/20'
                        : 'hover:bg-muted/60'
                    )}
                  >
                    {/* Circle */}
                    <div
                      className={cn(
                        'relative z-10 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all',
                        activeStep === s.step
                          ? 'bg-primary text-primary-foreground shadow-md shadow-primary/25'
                          : 'border-2 bg-background text-muted-foreground group-hover:border-primary/40 group-hover:text-foreground'
                      )}
                    >
                      {s.step}
                    </div>
                    {/* Label */}
                    <div className="min-w-0 pt-0.5">
                      <div
                        className={cn(
                          'text-sm font-medium leading-tight transition-colors',
                          activeStep === s.step ? 'text-foreground' : 'text-muted-foreground group-hover:text-foreground'
                        )}
                      >
                        {s.shortTitle}
                      </div>
                      <div className={cn(
                        'mt-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none',
                        s.tag === 'request'
                          ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400'
                          : 'bg-green-500/10 text-green-600 dark:text-green-400'
                      )}>
                        {s.tag === 'request' ? 'REQUEST' : 'RESPONSE'}
                      </div>
                    </div>
                  </button>

                  {/* Connector */}
                  {i < steps.length - 1 && (
                    <div className="flex items-stretch gap-3 px-2.5">
                      <div className="flex w-7 justify-center">
                        <div
                          className={cn(
                            'w-px',
                            /* highlight the segment between active and next */
                            activeStep === s.step || activeStep === steps[i + 1].step
                              ? 'bg-primary/40'
                              : 'bg-border'
                          )}
                          style={{ minHeight: '40px' }}
                        />
                      </div>
                      <div className="flex items-center py-2">
                        {s.connector ? (
                          <div className="rounded-md border bg-muted/40 px-2 py-1 text-[10px] leading-snug text-muted-foreground">
                            {s.connector}
                          </div>
                        ) : (
                          <div className="h-px" />
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right content */}
        <div className="min-w-0 flex-1">
        {activeStep === 1 && (
          <section className="rounded-lg border bg-background">
            <FlowStepHeader
              step={1}
              title="用户请求"
              description="用户发送给 local-router 的原始请求（插件处理前）"
            />
            <div className="space-y-3 px-3 py-3">
              <div className="grid gap-2 text-sm sm:grid-cols-3">
                <MetaItem label="method" value={detail.request.method} />
                <MetaItem label="path" value={detail.request.path} mono />
                <MetaItem label="content-type" value={detail.request.contentType ?? '-'} mono />
              </div>
              <HeadersTableBlock title="headers" headers={detail.request.requestHeaders} />
              <JsonBlock
                title="body"
                value={userRequestBody}
                contentType={detail.request.contentType}
                emptyText="无请求 body 或未采集。"
              />
            </div>
          </section>
        )}

        {activeStep === 2 && (
          <section className="rounded-lg border bg-background">
            <FlowStepHeader
              step={2}
              title="发送给 Provider 的请求"
              description={`local-router 插件处理后最终发给 ${detail.summary.provider} 的请求`}
            />
            <div className="space-y-3 px-3 py-3">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <MetaItem label="target_url" value={providerRequestUrl} mono />
                <MetaItem label="provider" value={detail.summary.provider} />
              </div>
              <JsonBlock
                title="body"
                value={providerRequestBody}
                contentType={detail.request.contentType}
                emptyText="无请求 body 或未采集。"
              />
              {hasPlugins && plugins?.requestBodyAfterPlugins !== undefined ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  插件已修改请求 body，此处展示的是修改后的内容。
                </div>
              ) : !hasPlugins ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  无插件处理，请求内容与用户请求一致（model 已由路由改写）。
                </div>
              ) : null}
            </div>
          </section>
        )}

        {activeStep === 3 && (
          <section className="rounded-lg border bg-background">
            <FlowStepHeader
              step={3}
              title="Provider 响应"
              description={`${detail.summary.provider} 返回给 local-router 的原始响应（插件处理前）`}
            />
            <div className="space-y-3 px-3 py-3">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <MetaItem label="upstream_status" value={String(detail.response.upstreamStatus)} />
                <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
              </div>
              <HeadersTableBlock title="headers" headers={detail.response.responseHeaders} />
              <JsonBlock
                title="body"
                value={providerResponseBody}
                contentType={detail.response.contentType}
                emptyText={
                  detail.upstream.isStream
                    ? '流式响应，请在「会话 / 追踪」标签页查看 stream 内容。'
                    : '无响应 body 或未采集。'
                }
              />
            </div>
          </section>
        )}

        {activeStep === 4 && (
          <section className="rounded-lg border bg-background">
            <FlowStepHeader
              step={4}
              title="最终响应"
              description="local-router 插件处理后最终返回给用户的响应"
            />
            <div className="space-y-3 px-3 py-3">
              <div className="grid gap-2 text-sm sm:grid-cols-2">
                <MetaItem label="status" value={String(detail.response.upstreamStatus)} />
                <MetaItem label="content-type" value={detail.response.contentType ?? '-'} mono />
              </div>
              <JsonBlock
                title="body"
                value={finalResponseBody}
                contentType={detail.response.contentType}
                emptyText={
                  detail.upstream.isStream
                    ? '流式响应，请在「会话 / 追踪」标签页查看 stream 内容。'
                    : '无响应 body 或未采集。'
                }
              />
              {hasPlugins && plugins?.responseBodyAfterPlugins !== undefined ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
                  插件已修改响应 body，此处展示的是修改后的最终内容。
                </div>
              ) : !hasPlugins ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                  无插件处理，响应内容与 Provider 响应一致。
                </div>
              ) : null}
            </div>
          </section>
        )}
        </div>
      </div>
    </div>
  );
}

function PluginPipelineSection({ detail }: { detail: LogEventDetail }) {
  const plugins = detail.plugins;

  if (!plugins || (!plugins.request?.length && !plugins.response?.length)) {
    return null;
  }

  return (
    <>
      <section className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">插件管线</h3>
          <p className="text-sm text-muted-foreground">
            请求/响应经过的插件处理链路（洋葱模型）
          </p>
        </div>
        <div className="space-y-3 px-3 py-3">
          {plugins.request && plugins.request.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">请求阶段（正序）</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-xs">用户请求</Badge>
                {plugins.request.map((p, i) => (
                  <div key={`req-${p.name}-${i}`} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="secondary" className="text-xs">
                      {p.name}
                    </Badge>
                  </div>
                ))}
                <span className="text-muted-foreground">→</span>
                <Badge variant="outline" className="text-xs">Provider 请求</Badge>
              </div>
            </div>
          )}

          {plugins.response && plugins.response.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-muted-foreground">响应阶段（逆序）</div>
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant="outline" className="text-xs">Provider 响应</Badge>
                {[...plugins.response].reverse().map((p, i) => (
                  <div key={`res-${p.name}-${i}`} className="flex items-center gap-1.5">
                    <span className="text-muted-foreground">→</span>
                    <Badge variant="secondary" className="text-xs">
                      {p.name}
                    </Badge>
                  </div>
                ))}
                <span className="text-muted-foreground">→</span>
                <Badge variant="outline" className="text-xs">用户响应</Badge>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="rounded-lg border bg-background">
        <div className="border-b px-3 py-3">
          <h3 className="text-base font-semibold">插件详情</h3>
          <p className="text-sm text-muted-foreground">各插件的包名与参数配置</p>
        </div>
        <div className="space-y-3 px-3 py-3">
          {(plugins.request ?? plugins.response ?? []).map((p, i) => (
            <div key={`detail-${p.name}-${i}`} className="rounded-md border bg-muted/20 p-3">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-xs">{p.name}</Badge>
                <span className="font-mono text-xs text-muted-foreground">{p.package}</span>
              </div>
              {Object.keys(p.params).length > 0 && (
                <div className="mt-2">
                  <div className="text-xs text-muted-foreground">params</div>
                  <pre className="mt-1 rounded-md border bg-muted/30 p-2 text-xs">
                    {JSON.stringify(p.params, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          ))}
        </div>
      </section>

      {plugins.requestUrlAfterPlugins && (
        <section className="rounded-lg border bg-background">
          <div className="border-b px-3 py-3">
            <h3 className="text-base font-semibold">插件修改记录</h3>
            <p className="text-sm text-muted-foreground">插件对请求/响应的修改</p>
          </div>
          <div className="space-y-3 px-3 py-3">
            <div className="space-y-1">
              <div className="text-xs text-muted-foreground">插件处理后 URL</div>
              <div className="rounded-md border bg-muted/30 p-2 font-mono text-xs break-all">
                {plugins.requestUrlAfterPlugins}
              </div>
            </div>
          </div>
        </section>
      )}
    </>
  );
}

function MetaItem({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-muted/20 px-3 py-2">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{label}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`已复制 ${label}`);
          }}
          aria-label={`复制 ${label}`}
          title={`复制 ${label}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <div className={`mt-1 break-all ${mono ? 'font-mono text-xs' : 'text-sm'}`}>{value}</div>
    </div>
  );
}

function FlowPill({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background/90 px-2 py-1">
      <div className="flex items-center justify-between gap-1 text-[11px] leading-4 text-muted-foreground">
        <span>{label}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            toast.success(`已复制 ${label}`);
          }}
          aria-label={`复制 ${label}`}
          title={`复制 ${label}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <div className={`mt-0.5 break-all text-xs ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

function RouteFlowCard({
  interfaceType,
  routeType,
  modelIn,
  provider,
  modelOut,
  routeRuleKey,
}: {
  interfaceType: string;
  routeType: string;
  modelIn: string;
  provider: string;
  modelOut: string;
  routeRuleKey: string;
}) {
  return (
    <div className="rounded-xl border bg-linear-to-br from-muted/20 to-muted/40 p-3">
      <div className="grid gap-3 lg:grid-cols-[1fr_auto_1fr] lg:items-center">
        <div className="space-y-2 rounded-lg border bg-background/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">入站请求</div>
            <Badge variant="outline">IN</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <FlowPill label="接口类型" value={interfaceType} />
            <FlowPill label="routeType" value={routeType} mono />
          </div>
          <FlowPill label="原始模型（model_in）" value={modelIn} mono />
        </div>

        <div className="flex flex-col items-center justify-center gap-1 py-1">
          <div className="hidden h-0.5 w-16 bg-border lg:block" />
          <div className="rounded-full border bg-background px-3 py-1 text-xs text-muted-foreground">
            路由匹配并改写
          </div>
          <div className="text-xl leading-none text-muted-foreground">→</div>
          <div className="hidden h-0.5 w-16 bg-border lg:block" />
        </div>

        <div className="space-y-2 rounded-lg border bg-background/70 p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium">出站转发</div>
            <Badge variant="outline">OUT</Badge>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <FlowPill label="目标 provider" value={provider} />
            <FlowPill label="命中规则" value={routeRuleKey} mono />
          </div>
          <FlowPill label="路由模型（model_out）" value={modelOut} mono />
        </div>
      </div>
    </div>
  );
}

type StreamLine =
  | { type: 'json'; lineNo: number; value: unknown }
  | { type: 'raw'; lineNo: number; value: string };

function parseStreamLines(content: string): StreamLine[] {
  const rawLines = content.split('\n');
  const lines: StreamLine[] = [];

  rawLines.forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (!trimmed) return;

    const lineNo = index + 1;

    if (trimmed.startsWith('data:')) {
      const payload = trimmed.slice(5).trim();
      if (!payload) return;
      try {
        lines.push({ type: 'json', lineNo, value: JSON.parse(payload) });
      } catch {
        lines.push({ type: 'raw', lineNo, value: trimmed });
      }
      return;
    }

    try {
      lines.push({ type: 'json', lineNo, value: JSON.parse(trimmed) });
    } catch {
      lines.push({ type: 'raw', lineNo, value: trimmed });
    }
  });

  return lines;
}

function StreamContentBlock({
  title,
  content,
  emptyText,
}: {
  title: string;
  content: string | null;
  emptyText?: string;
}) {
  const lines = useMemo(() => (content ? parseStreamLines(content) : []), [content]);

  const header = (
    <div className="flex items-center justify-between gap-2">
      <div className="text-xs text-muted-foreground">{title}</div>
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

  return (
    <div className="space-y-1">
      {header}
      <div className="space-y-2 rounded-md border bg-muted/30 p-3">
        {lines.map((line) => (
          <div
            key={`${line.lineNo}-${line.type}`}
            className="space-y-1 rounded-md border bg-background/80 p-2"
          >
            <div className="text-[11px] text-muted-foreground">line {line.lineNo}</div>
            <StructuredDataBlock
              value={line.type === 'json' ? line.value : line.value}
              className="bg-muted/40"
              noScroll
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function StructuredDataBlock({
  value,
  contentType,
  emptyText,
  className,
  noScroll = false,
}: {
  value: unknown;
  contentType?: string | null;
  emptyText?: string;
  className?: string;
  noScroll?: boolean;
}) {
  const parsed = useMemo(() => parseJsonCandidate(value, contentType), [contentType, value]);

  if (parsed.kind === 'empty') {
    return (
      <div
        className={cn('rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground', className)}
      >
        {emptyText ?? '-'}
      </div>
    );
  }

  if (parsed.kind === 'json-tree') {
    return (
      <div
        className={cn(
          noScroll
            ? 'rounded-md border bg-muted/20 p-3 text-xs'
            : 'max-h-[320px] overflow-auto rounded-md border bg-muted/20 p-3 text-xs',
          className
        )}
      >
        <JsonView
          value={parsed.value as object}
          displayDataTypes={false}
          displayObjectSize={false}
          enableClipboard={true}
          shortenTextAfterLength={0}
          shouldExpandNodeInitially={(_, { level }) => level < 2}
          style={JSON_VIEW_STYLE}
        />
      </div>
    );
  }

  const text =
    parsed.kind === 'json-primitive'
      ? prettyJson(parsed.value)
      : (parsed.text ?? prettyJson(value));

  return (
    <pre
      className={cn(
        noScroll
          ? 'rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all'
          : 'max-h-[320px] overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-all',
        className
      )}
    >
      {text}
    </pre>
  );
}

function JsonBlock({
  title,
  value,
  contentType,
  emptyText,
}: {
  title: string;
  value: unknown;
  contentType?: string | null;
  emptyText?: string;
}) {
  const copyText = useMemo(() => {
    if (value == null) return '';
    if (typeof value === 'string') return value;
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  }, [value]);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{title}</span>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          disabled={!copyText}
          onClick={async () => {
            if (!copyText) return;
            await navigator.clipboard.writeText(copyText);
            toast.success(`已复制 ${title}`);
          }}
          aria-label={`复制 ${title}`}
          title={`复制 ${title}`}
        >
          <Copy className="h-3 w-3" />
        </Button>
      </div>
      <StructuredDataBlock value={value} contentType={contentType} emptyText={emptyText} />
    </div>
  );
}

function HeadersTableBlock({
  title,
  headers,
  emptyText,
}: {
  title: string;
  headers: Record<string, string> | null | undefined;
  emptyText?: string;
}) {
  const entries = useMemo(() => {
    if (!headers) return [];
    return Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  }, [headers]);

  return (
    <div className="space-y-1">
      <div className="text-xs text-muted-foreground">{title}</div>
      {entries.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          {emptyText ?? '-'}
        </div>
      ) : (
        <div className="overflow-hidden rounded-md border bg-muted/10">
          <Table className="text-xs">
            <TableBody>
              {entries.map(([key, value]) => (
                <TableRow key={key} className="hover:bg-transparent">
                  <TableCell className="w-[240px] max-w-[240px] align-top font-mono text-[11px] text-muted-foreground whitespace-normal break-all">
                    {key}
                  </TableCell>
                  <TableCell className="align-top font-mono whitespace-normal break-all">
                    {value}
                  </TableCell>
                  <TableCell className="w-10 align-top text-right">
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost"
                      onClick={async () => {
                        await navigator.clipboard.writeText(`${key}: ${value}`);
                        toast.success(`已复制 ${key}`);
                      }}
                      aria-label={`复制 ${key}`}
                      title={`复制 ${key}`}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}

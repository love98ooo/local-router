import { Eye, EyeOff, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import type { BalanceConfig, ProviderConfig, ProviderType } from '@/types/config';
import { ModelEditor } from './model-editor';

const PROVIDER_TYPES: { value: ProviderType; label: string }[] = [
  { value: 'openai-completions', label: 'OpenAI Completions' },
  { value: 'openai-responses', label: 'OpenAI Responses' },
  { value: 'anthropic-messages', label: 'Anthropic Messages' },
];

const PROVIDER_TARGET_PATH: Record<ProviderType, string> = {
  'openai-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
  'anthropic-messages': '/v1/messages',
};

const BALANCE_METHODS = ['GET', 'POST', 'PUT', 'PATCH'] as const;

interface ProviderFormProps {
  name: string;
  config: ProviderConfig;
  isNew: boolean;
  onChange: (config: ProviderConfig) => void;
}

function BalanceEditor({
  balance,
  onChange,
}: {
  balance?: BalanceConfig;
  onChange: (balance: BalanceConfig | undefined) => void;
}) {
  const [expanded, setExpanded] = useState(!!balance);
  const [headersText, setHeadersText] = useState(() =>
    balance?.request.headers ? JSON.stringify(balance.request.headers, null, 2) : ''
  );
  const [bodyText, setBodyText] = useState(() =>
    balance?.request.body ? JSON.stringify(balance.request.body, null, 2) : ''
  );
  const [headersError, setHeadersError] = useState<string | null>(null);
  const [bodyError, setBodyError] = useState<string | null>(null);

  function enableBalance() {
    setExpanded(true);
    if (!balance) {
      onChange({
        request: { url: '' },
        extractor: '',
      });
    }
  }

  function disableBalance() {
    setExpanded(false);
    onChange(undefined);
    setHeadersText('');
    setBodyText('');
    setHeadersError(null);
    setBodyError(null);
  }

  function updateRequest(partial: Partial<BalanceConfig['request']>) {
    if (!balance) return;
    onChange({
      ...balance,
      request: { ...balance.request, ...partial },
    });
  }

  function handleHeadersChange(text: string) {
    setHeadersText(text);
    if (text.trim() === '') {
      setHeadersError(null);
      updateRequest({ headers: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setHeadersError('必须是 JSON 对象');
        return;
      }
      setHeadersError(null);
      updateRequest({ headers: parsed });
    } catch {
      setHeadersError('JSON 格式错误');
    }
  }

  function handleBodyChange(text: string) {
    setBodyText(text);
    if (text.trim() === '') {
      setBodyError(null);
      updateRequest({ body: undefined });
      return;
    }
    try {
      const parsed = JSON.parse(text);
      setBodyError(null);
      updateRequest({ body: parsed });
    } catch {
      setBodyError('JSON 格式错误');
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">余额查询（可选）</Label>
        {balance ? (
          <Button type="button" variant="outline" size="sm" onClick={disableBalance}>
            <Trash2 className="h-3.5 w-3.5 mr-1" />
            移除
          </Button>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={enableBalance}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            配置
          </Button>
        )}
      </div>

      {!balance && !expanded && (
        <p className="text-xs text-muted-foreground">
          配置自定义 HTTP 请求来查询此 provider 的账户余额，结果将在用量统计页面展示。
        </p>
      )}

      {balance && (
        <div className="space-y-3 rounded-md border p-3">
          <div className="space-y-1.5">
            <Label className="text-xs">请求 URL</Label>
            <Input
              value={balance.request.url}
              onChange={(e) => updateRequest({ url: e.target.value })}
              placeholder="https://api.example.com/v1/dashboard/billing/usage"
              className="text-sm"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">HTTP 方法</Label>
            <Select
              value={balance.request.method ?? 'GET'}
              onValueChange={(v) => updateRequest({ method: v })}
            >
              <SelectTrigger className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BALANCE_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">请求头（JSON 对象，可选）</Label>
            <Textarea
              value={headersText}
              onChange={(e) => handleHeadersChange(e.target.value)}
              placeholder={'{\n  "Authorization": "Bearer sk-xxx"\n}'}
              className="font-mono text-xs min-h-[60px]"
              rows={3}
            />
            {headersError && <p className="text-xs text-destructive">{headersError}</p>}
          </div>

          {(balance.request.method ?? 'GET') !== 'GET' && (
            <div className="space-y-1.5">
              <Label className="text-xs">请求体（JSON，可选）</Label>
              <Textarea
                value={bodyText}
                onChange={(e) => handleBodyChange(e.target.value)}
                placeholder='{ "key": "value" }'
                className="font-mono text-xs min-h-[60px]"
                rows={3}
              />
              {bodyError && <p className="text-xs text-destructive">{bodyError}</p>}
            </div>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">Extractor（JS 表达式）</Label>
            <Textarea
              value={balance.extractor}
              onChange={(e) => onChange({ ...balance, extractor: e.target.value })}
              placeholder='({ remaining: response.data.balance, unit: "USD" })'
              className="font-mono text-xs min-h-[60px]"
              rows={3}
            />
            <p className="text-xs text-muted-foreground">
              JS 表达式，接收 <code className="bg-muted px-1 rounded">response</code> 变量（响应
              JSON），需返回{' '}
              <code className="bg-muted px-1 rounded">{'{ remaining: number, unit: string }'}</code>
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export function ProviderForm({ name, config, isNew, onChange }: ProviderFormProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const normalizedBase = config.base.replace(/\/+$/, '');
  const previewUrl = `${normalizedBase}${PROVIDER_TARGET_PATH[config.type]}`;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label htmlFor="provider-name">Provider 名称</Label>
        <Input
          id="provider-name"
          value={name}
          disabled={!isNew}
          readOnly={!isNew}
          className="font-mono"
        />
        {!isNew && <p className="text-xs text-muted-foreground">名称在创建后不可修改</p>}
      </div>

      <div className="space-y-1.5">
        <Label>协议类型</Label>
        <Select
          value={config.type}
          onValueChange={(v) => onChange({ ...config, type: v as ProviderType })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_TYPES.map((t) => (
              <SelectItem key={t.value} value={t.value}>
                {t.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-base">Base URL</Label>
        <Input
          id="provider-base"
          value={config.base}
          onChange={(e) => onChange({ ...config, base: e.target.value })}
          placeholder="https://api.example.com"
        />
        {config.base && (
          <p className="text-xs text-muted-foreground break-all">
            预览 URL: <span className="font-mono">{previewUrl}</span>
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-proxy">Proxy URL（可选）</Label>
        <Input
          id="provider-proxy"
          value={config.proxy ?? ''}
          onChange={(e) => onChange({ ...config, proxy: e.target.value })}
          placeholder="http://127.0.0.1:7890"
        />
        <p className="text-xs text-muted-foreground">
          留空表示直连上游；仅此 provider 生效，不读取环境变量代理。
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="provider-apikey">API Key</Label>
        <div className="relative">
          <Input
            id="provider-apikey"
            type={showApiKey ? 'text' : 'password'}
            value={config.apiKey}
            onChange={(e) => onChange({ ...config, apiKey: e.target.value })}
            className="pr-10 font-mono"
            placeholder="sk-..."
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-0 top-0 h-full px-3 hover:bg-transparent"
            onClick={() => setShowApiKey(!showApiKey)}
          >
            {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      <Separator />

      <ModelEditor models={config.models} onChange={(models) => onChange({ ...config, models })} />

      <Separator />

      <BalanceEditor
        key={name}
        balance={config.balance}
        onChange={(balance) => {
          const next = { ...config };
          if (balance) {
            next.balance = balance;
          } else {
            delete next.balance;
          }
          onChange(next);
        }}
      />
    </div>
  );
}

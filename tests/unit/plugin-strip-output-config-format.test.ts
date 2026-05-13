import { describe, expect, test } from 'bun:test';
import definition from '../../packages/plugin-strip-output-config-format/src';

describe('strip-output-config-format 插件', () => {
  test('应剔除请求体中的 output_config.format 字段并保留其他字段', async () => {
    const plugin = await definition.create({});
    const body = {
      model: 'xxx',
      messages: [],
      output_config: {
        effort: 'medium',
        format: {
          type: 'json_schema',
          schema: {},
        },
      },
    };

    const result = await plugin.onRequest?.({
      ctx: {
        requestId: 'req-1',
        provider: 'provider-1',
        modelIn: 'xxx',
        modelOut: 'xxx',
        routeType: 'openai-completions',
        isStream: false,
      },
      url: 'https://example.test/v1/chat/completions',
      headers: new Headers(),
      body,
    });

    expect(result?.body).toEqual({
      model: 'xxx',
      messages: [],
      output_config: {
        effort: 'medium',
      },
    });
  });

  test('output_config 缺失或非对象时不修改请求体', async () => {
    const plugin = await definition.create({});
    const body = {
      model: 'xxx',
      messages: [],
      output_config: null,
    };

    const result = await plugin.onRequest?.({
      ctx: {
        requestId: 'req-1',
        provider: 'provider-1',
        modelIn: 'xxx',
        modelOut: 'xxx',
        routeType: 'openai-completions',
        isStream: false,
      },
      url: 'https://example.test/v1/chat/completions',
      headers: new Headers(),
      body,
    });

    expect(result).toBeUndefined();
    expect(body).toEqual({
      model: 'xxx',
      messages: [],
      output_config: null,
    });
  });
});

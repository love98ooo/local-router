/**
 * 剔除请求体中 output_config.format 字段的插件
 *
 * 配置示例：
 *   { "package": "./packages/plugin-strip-output-config-format" }
 */
import type { Plugin, PluginDefinition } from '@lakphy/local-router/plugin';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const definition: PluginDefinition = {
  name: 'strip-output-config-format',
  version: '0.1.0',

  create(): Plugin {
    return {
      async onRequest({ body }) {
        const outputConfig = body.output_config;
        if (!isRecord(outputConfig) || !('format' in outputConfig)) {
          return;
        }

        delete outputConfig.format;
        return { body };
      },
    };
  },
};

export default definition;

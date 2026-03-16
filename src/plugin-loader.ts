import { resolve, dirname } from 'node:path';
import type { PluginConfig, ProviderConfig } from './config';
import type { Plugin, PluginDefinition } from './plugin';

interface LoadedPlugin {
  config: PluginConfig;
  definition: PluginDefinition;
  instance: Plugin;
}

function isLocalPath(pkg: string): boolean {
  return pkg.startsWith('./') || pkg.startsWith('../') || pkg.startsWith('/');
}

async function importPlugin(pkg: string, configDir: string): Promise<PluginDefinition> {
  let modulePath: string;

  if (isLocalPath(pkg)) {
    const absolutePath = resolve(configDir, pkg);
    // 追加 ?t=Date.now() 绕过 Bun 模块缓存，支持热重载
    modulePath = `${absolutePath}?t=${Date.now()}`;
  } else {
    modulePath = pkg;
  }

  const mod = (await import(modulePath)) as Record<string, unknown>;
  const definition = (mod.default ?? mod) as PluginDefinition;

  if (!definition || typeof definition.name !== 'string' || typeof definition.create !== 'function') {
    throw new Error(
      `插件 "${pkg}" 导出格式不正确，需导出包含 name 和 create 的 PluginDefinition`
    );
  }

  return definition;
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin[]>();
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  async loadForProvider(
    providerName: string,
    pluginConfigs: PluginConfig[]
  ): Promise<void> {
    const loaded: LoadedPlugin[] = [];

    for (const config of pluginConfigs) {
      try {
        const definition = await importPlugin(config.package, this.configDir);
        const instance = await definition.create(config.params ?? {});
        loaded.push({ config, definition, instance });
      } catch (err) {
        console.error(
          `[plugin] 加载插件 "${config.package}" 失败 (provider: ${providerName}):`,
          err instanceof Error ? err.message : err
        );
      }
    }

    this.plugins.set(providerName, loaded);
  }

  async reloadAll(
    providers: Record<string, ProviderConfig>
  ): Promise<void> {
    await this.disposeAll();

    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (providerConfig.plugins && providerConfig.plugins.length > 0) {
        await this.loadForProvider(providerName, providerConfig.plugins);
      }
    }
  }

  getPlugins(providerName: string): Plugin[] {
    const loaded = this.plugins.get(providerName);
    if (!loaded) return [];
    return loaded.map((l) => l.instance);
  }

  getLoadedPlugins(providerName: string): LoadedPlugin[] {
    return this.plugins.get(providerName) ?? [];
  }

  async disposeAll(): Promise<void> {
    for (const [, loadedPlugins] of this.plugins) {
      for (const { instance, config } of loadedPlugins) {
        try {
          await instance.dispose?.();
        } catch (err) {
          console.error(
            `[plugin] 销毁插件 "${config.package}" 失败:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
    this.plugins.clear();
  }
}

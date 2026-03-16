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

export interface ReloadResult {
  ok: boolean;
  failures: { provider: string; package: string; error: string }[];
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin[]>();
  private configDir: string;

  constructor(configDir: string) {
    this.configDir = configDir;
  }

  private async loadPluginsForProvider(
    providerName: string,
    pluginConfigs: PluginConfig[]
  ): Promise<{ loaded: LoadedPlugin[]; failures: { provider: string; package: string; error: string }[] }> {
    const loaded: LoadedPlugin[] = [];
    const failures: { provider: string; package: string; error: string }[] = [];

    for (const config of pluginConfigs) {
      try {
        const definition = await importPlugin(config.package, this.configDir);
        const instance = await definition.create(config.params ?? {});
        loaded.push({ config, definition, instance });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.error(
          `[plugin] 加载插件 "${config.package}" 失败 (provider: ${providerName}):`,
          errorMsg
        );
        failures.push({ provider: providerName, package: config.package, error: errorMsg });
      }
    }

    return { loaded, failures };
  }

  /**
   * 原子热重载：先在临时容器中完成所有新插件的加载，
   * 全部成功后原子替换旧 map，最后异步 dispose 旧实例。
   * 即使部分插件加载失败，旧插件也不会被提前卸载。
   */
  async reloadAll(
    providers: Record<string, ProviderConfig>
  ): Promise<ReloadResult> {
    const newPlugins = new Map<string, LoadedPlugin[]>();
    const allFailures: { provider: string; package: string; error: string }[] = [];

    // 阶段 1：在临时容器中加载所有新插件
    for (const [providerName, providerConfig] of Object.entries(providers)) {
      if (providerConfig.plugins && providerConfig.plugins.length > 0) {
        const { loaded, failures } = await this.loadPluginsForProvider(
          providerName,
          providerConfig.plugins
        );
        newPlugins.set(providerName, loaded);
        allFailures.push(...failures);
      }
    }

    // 阶段 2：保存旧实例引用，原子替换 map
    const oldPlugins = this.plugins;
    this.plugins = newPlugins;

    // 阶段 3：异步 dispose 旧实例（不阻塞新请求，保护 in-flight 请求）
    // 延迟 dispose 给 in-flight 请求留出完成时间
    setTimeout(() => {
      this.disposePluginMap(oldPlugins).catch((err) => {
        console.error('[plugin] 旧插件销毁失败:', err);
      });
    }, 5000);

    if (allFailures.length > 0) {
      console.warn(
        `[plugin] 热重载完成，但有 ${allFailures.length} 个插件加载失败:`,
        allFailures.map((f) => `${f.provider}/${f.package}`).join(', ')
      );
    }

    return { ok: allFailures.length === 0, failures: allFailures };
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
    await this.disposePluginMap(this.plugins);
    this.plugins.clear();
  }

  private async disposePluginMap(pluginMap: Map<string, LoadedPlugin[]>): Promise<void> {
    for (const [, loadedPlugins] of pluginMap) {
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
  }
}

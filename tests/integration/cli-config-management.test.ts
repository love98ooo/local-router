import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import JSON5 from 'json5';

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const proc = Bun.spawnSync(['bun', 'run', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  };
}

describe('CLI config management', () => {
  test('provider/route/resolve workflow', () => {
    const dir = mkdtempSync(join(tmpdir(), 'local-router-cli-config-'));
    const configPath = join(dir, 'config.json5');
    writeFileSync(
      configPath,
      `{
  providers: {
    p1: {
      type: "openai-completions",
      base: "https://example.com/v1",
      apiKey: "sk-test-12345",
      models: {
        "m1": {}
      }
    }
  },
  routes: {
    "openai-completions": {
      "*": { provider: "p1", model: "m1" }
    }
  }
}`,
      'utf-8'
    );

    try {
      const list = runCli(['config', 'provider', 'list', '--json', '--config', configPath]);
      expect(list.exitCode).toBe(0);
      expect(list.stdout).toContain('p1');

      const addProvider = runCli([
        'config',
        'provider',
        'add',
        'p2',
        '--type',
        'openai-completions',
        '--base',
        'https://example.org/v1',
        '--api-key',
        'sk-abc',
        '--model',
        'boot-model',
        '--config',
        configPath,
      ]);
      expect(addProvider.exitCode).toBe(0);

      const addModel = runCli([
        'config',
        'provider',
        'model',
        'add',
        'p2',
        'gpt-4o-mini',
        '--image-input',
        'true',
        '--reasoning',
        'true',
        '--config',
        configPath,
      ]);
      expect(addModel.exitCode).toBe(0);

      const routeSet = runCli([
        'config',
        'route',
        'set',
        'openai-completions',
        'gpt-4o',
        '--provider',
        'p2',
        '--model',
        'gpt-4o-mini',
        '--config',
        configPath,
      ]);
      expect(routeSet.exitCode).toBe(0);

      const resolve = runCli([
        'config',
        'resolve',
        '--entry',
        'openai-completions',
        '--model',
        'gpt-4o',
        '--json',
        '--config',
        configPath,
      ]);
      expect(resolve.exitCode).toBe(0);
      const resolved = JSON.parse(resolve.stdout) as { provider: string; targetModel: string };
      expect(resolved.provider).toBe('p2');
      expect(resolved.targetModel).toBe('gpt-4o-mini');

      const validate = runCli(['config', 'validate', '--config', configPath]);
      expect(validate.exitCode).toBe(0);

      const finalConfig = JSON5.parse(readFileSync(configPath, 'utf-8')) as {
        routes: Record<string, Record<string, { provider: string; model: string }>>;
      };
      expect(finalConfig.routes['openai-completions']['gpt-4o'].provider).toBe('p2');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

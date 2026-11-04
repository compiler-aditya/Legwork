import { mkdirSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

export type Status = 'pass' | 'fail' | 'skip' | 'manual';

export interface CheckResult {
  group: string;
  name: string;
  status: Status;
  detail: string;
  ms: number;
}

/** A check returns its evidence as a short line; throwing marks it failed; Skip marks it skipped. */
export class Skip extends Error {}

export class Run {
  readonly results: CheckResult[] = [];
  readonly id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}${Math.floor(Math.random() * 1e6)}`;

  constructor(readonly interactive: boolean) {}

  async check(group: string, name: string, fn: () => Promise<string>): Promise<boolean> {
    const started = Date.now();
    let status: Status = 'pass';
    let detail = '';
    try {
      detail = await fn();
    } catch (err) {
      if (err instanceof Skip) {
        status = 'skip';
        detail = err.message;
      } else {
        status = 'fail';
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    const result = { group, name, status, detail, ms: Date.now() - started };
    this.results.push(result);
    console.log(`${icon(status)} ${group}: ${name}\n    ${detail}`);
    return status === 'pass';
  }

  manual(group: string, name: string, how: string): void {
    this.results.push({ group, name, status: 'manual', detail: how, ms: 0 });
    console.log(`${icon('manual')} ${group}: ${name}\n    ${how}`);
  }

  /** Waits for a person (for example, to approve a payment in PayPal). Non-interactive runs skip. */
  async waitFor(instruction: string): Promise<void> {
    if (!this.interactive) throw new Skip(`Needs a person: ${instruction}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      await rl.question(`\n>>> ${instruction}\n>>> Press Enter when done. `);
    } finally {
      rl.close();
    }
  }

  write(): string {
    mkdirSync('.day-one', { recursive: true });
    const counts = ['pass', 'fail', 'skip', 'manual'].map((s) => `${s} ${this.results.filter((r) => r.status === s).length}`).join(', ');
    const rows = this.results
      .map((r) => `| ${r.group} | ${r.name} | ${r.status} | ${r.detail.replace(/\|/g, '/').replace(/\n/g, ' ')} |`)
      .join('\n');
    const md = `# Day-one checks, run ${this.id}\n\n${counts}\n\n| Area | Check | Result | Evidence |\n| --- | --- | --- | --- |\n${rows}\n`;
    const path = `.day-one/results-${this.id}.md`;
    writeFileSync(path, md);
    writeFileSync(`.day-one/results-${this.id}.json`, JSON.stringify(this.results, null, 2));
    return path;
  }
}

function icon(status: Status): string {
  return { pass: '[PASS]', fail: '[FAIL]', skip: '[SKIP]', manual: '[TODO]' }[status];
}

export function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

export function needEnv(...names: string[]): Record<string, string> {
  const missing = names.filter((n) => !env(n));
  if (missing.length) throw new Skip(`Set ${missing.join(', ')} in .env`);
  return Object.fromEntries(names.map((n) => [n, env(n) as string]));
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Day-one checks: everything the design relies on that has not yet been run
 * against the real sandbox and services. See docs/day-one-checks.md.
 *
 *   npm run check:day-one                      # every group, interactive
 *   npm run check:day-one -- --only=paypal     # one or more groups, comma-separated
 *   npm run check:day-one -- --call=+14155550100   # also place one real AI call
 *   npm run check:day-one -- --only=paypal --order=<id>   # resume a hold the buyer already approved
 */
import { existsSync } from 'node:fs';
import { paypalChecks } from './paypal';
import { Run } from './report';
import { channel3Checks, elasticChecks, elevenLabsChecks, kernelChecks, manualChecks } from './services';

const GROUPS = ['paypal', 'elevenlabs', 'channel3', 'elastic', 'kernel'] as const;
type Group = (typeof GROUPS)[number];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

if (existsSync('.env')) process.loadEnvFile('.env');

const only = arg('only')?.split(',').map((s) => s.trim()) ?? [...GROUPS];
const unknown = only.filter((g) => !GROUPS.includes(g as Group));
if (unknown.length) {
  console.error(`Unknown group(s): ${unknown.join(', ')}. Choose from: ${GROUPS.join(', ')}`);
  process.exit(2);
}
const wanted = new Set(only as Group[]);
const run = new Run(Boolean(process.stdin.isTTY));

console.log(`Legwork day-one checks, run ${run.id}${run.interactive ? '' : ' (non-interactive: checks that need a person are skipped)'}\n`);

if (wanted.has('paypal')) await paypalChecks(run);
if (wanted.has('elevenlabs')) await elevenLabsChecks(run, arg('call'));
if (wanted.has('channel3')) await channel3Checks(run);
if (wanted.has('elastic')) await elasticChecks(run);
if (wanted.has('kernel')) await kernelChecks(run);
if (wanted.size === GROUPS.length) manualChecks(run);

const path = run.write();
const failed = run.results.filter((r) => r.status === 'fail').length;
console.log(`\nResults written to ${path}`);
process.exit(failed ? 1 : 0);

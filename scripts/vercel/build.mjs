// Builds the API for Vercel with the Build Output API: one Node.js function
// that serves every path. Vercel runs this as the build command and deploys
// .vercel/output as it is, so no framework detection is involved.
import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';

const out = '.vercel/output';
const func = `${out}/functions/index.func`;

await rm(out, { recursive: true, force: true });
await mkdir(func, { recursive: true });

await build({
  entryPoints: ['apps/api/src/vercel.ts'],
  outfile: `${func}/index.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: 'linked',
  // pg loads its optional native binding only when asked; it is not installed.
  external: ['pg-native'],
  // Bundled CommonJS packages still call require() for Node built-ins.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});

await cp('packages/db/migrations', `${func}/migrations`, { recursive: true });

await writeFile(
  `${func}/.vc-config.json`,
  JSON.stringify(
    {
      runtime: 'nodejs22.x',
      handler: 'index.mjs',
      launcherType: 'Nodejs',
      // Fastify reads the request stream itself; Vercel's body helpers would consume it first.
      shouldAddHelpers: false,
      shouldAddSourcemapSupport: true,
      maxDuration: 60,
    },
    null,
    2,
  ),
);

await writeFile(`${out}/config.json`, JSON.stringify({ version: 3, routes: [{ src: '/(.*)', dest: '/index' }] }, null, 2));
console.log(`Built ${func}`);

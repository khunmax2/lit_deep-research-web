// Bundle cli/litstorm.ts into one file that plain Node runs, with no
// node_modules beside it: lit-storm copies it into its Worker image.
//   pnpm run build:litstorm   ->   dist/litstorm-deep.mjs
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

await build({
  entryPoints: [`${root}cli/litstorm.ts`],
  outfile: `${root}dist/litstorm-deep.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  alias: { '~~': root.replace(/[\\/]$/, '') },
  // Some dependencies are CommonJS and call require().
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'info',
})

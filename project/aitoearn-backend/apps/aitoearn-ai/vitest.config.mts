import type { Plugin } from 'vite'
import { resolve } from 'node:path'
import { nxCopyAssetsPlugin } from '@nx/vite/plugins/nx-copy-assets.plugin'
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin'
import ts from 'typescript'
import { defineConfig } from 'vitest/config'

function nestDecoratorMetadata(): Plugin {
  let program: ts.Program | undefined

  return {
    name: 'nest-decorator-metadata',
    enforce: 'pre',
    watchChange() {
      program = undefined
    },
    transform(code, id) {
      if (!id.endsWith('.ts') || id.includes('/node_modules/') || !/@\w/.test(code)) {
        return
      }

      // Oxc cannot infer decorator metadata for imported types such as Mongoose enums.
      if (!program) {
        const config = ts.getParsedCommandLineOfConfigFile(resolve(__dirname, 'tsconfig.spec.json'), {
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          inlineSources: true,
        }, {
          ...ts.sys,
          onUnRecoverableConfigFileDiagnostic: diagnostic => this.error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
        })
        if (!config) {
          return this.error('Unable to load the AI TypeScript configuration')
        }
        program = ts.createProgram(config.fileNames, config.options)
      }

      const source = program.getSourceFile(id)
      if (!source) {
        return
      }
      function hasDecorators(node: ts.Node): boolean {
        return (ts.canHaveDecorators(node) && !!ts.getDecorators(node)?.length)
          || ts.forEachChild(node, child => hasDecorators(child) || undefined) === true
      }
      if (!hasDecorators(source)) {
        return
      }

      let javascript: string | undefined
      let sourceMap: string | undefined
      program.emit(source, (filename, output) => {
        if (filename.endsWith('.js')) {
          javascript = output
        }
        else if (filename.endsWith('.js.map')) {
          sourceMap = output
        }
      })
      return javascript === undefined ? undefined : { code: javascript, map: sourceMap }
    },
  }
}

export default defineConfig(() => ({
  root: __dirname,
  cacheDir: '../../node_modules/.vite/apps/aitoearn-ai',
  plugins: [nestDecoratorMetadata(), nxViteTsPaths(), nxCopyAssetsPlugin(['*.md'])],
  test: {
    name: 'aitoearn-ai',
    watch: false,
    globals: true,
    environment: 'node',
    include: ['{src,tests}/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    setupFiles: ['./test/setup.ts'],
    coverage: {
      reportsDirectory: '../../coverage/apps/aitoearn-ai',
      provider: 'v8' as const,
    },
  },
}))

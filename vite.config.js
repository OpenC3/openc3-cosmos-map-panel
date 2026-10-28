import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Dashboards loads one JavaScript file per panel, so fold the component
// styles into it: they're added to the page when the module loads
function injectCss() {
  return {
    name: 'inject-css',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const cssFiles = Object.keys(bundle).filter((file) =>
        file.endsWith('.css'),
      )
      const css = cssFiles.map((file) => bundle[file].source).join('\n')
      for (const file of cssFiles) delete bundle[file]
      if (!css) return
      const entry = Object.values(bundle).find(
        (chunk) => chunk.type === 'chunk' && chunk.isEntry,
      )
      entry.code =
        `(function(){var s=document.createElement('style');` +
        `s.textContent=${JSON.stringify(css)};document.head.appendChild(s)})();\n` +
        entry.code
    },
  }
}

// Builds one SystemJS module, tools/panels/MAP/MAP.js, which the Dashboards
// tool imports. vue and vuetify come from COSMOS, so they stay external.
export default defineConfig({
  build: {
    outDir: 'tools/panels/MAP',
    emptyOutDir: true,
    sourcemap: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: 'src/index.js',
      output: {
        format: 'system',
        entryFileNames: 'MAP.js',
        inlineDynamicImports: true,
      },
      external: ['vue', 'vuetify'],
      preserveEntrySignatures: 'strict',
    },
  },
  plugins: [vue(), injectCss()],
})

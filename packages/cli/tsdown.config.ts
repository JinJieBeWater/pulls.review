import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'devframe': 'src/devframe.ts',
    'spa': 'src/spa.ts',
  },
  platform: 'node',
  dts: false,
})

import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    'index': 'src/index.ts',
    'devframe': 'src/devframe.ts',
    'spa': 'src/spa.ts',
    'daemon-process': 'src/daemon/process.ts',
    'daemon-child': 'src/daemon/child.ts',
  },
  platform: 'node',
  dts: false,
})

import { widthOf } from './design-system/ansi.js'
import { previewContext, renderStateScene } from './demo-scenes.js'

declare const process: { env: Record<string, string | undefined>; stdout: { write(value: string): void } }

const ctx = previewContext(process.env)
const output = renderStateScene(ctx.scene, ctx)

for (const row of output) {
  if (widthOf(row) > ctx.width) throw new Error(`preview overflow: ${widthOf(row)} > ${ctx.width}`)
}
process.stdout.write(output.join('\n') + '\n')

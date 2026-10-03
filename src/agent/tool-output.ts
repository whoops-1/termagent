import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, summarizeToolOutputPreview, ToolOutputStore } from './tool-output-store.js'

const DEFAULT_MAX_CHARS = 6000

/**
 * Compatibility helper retained for older callers/tests. New tool execution
 * uses ToolOutputStore.bind() so complete oversized results are persisted and
 * the model receives a stable reference rather than a lossy summary only.
 */
export function summarizeToolOutput(output: string, maxChars = DEFAULT_MAX_CHARS): string {
  if (!output || output.length <= maxChars) return output
  const preview = summarizeToolOutputPreview(output, Math.max(32, Math.min(DEFAULT_MAX_BYTES, maxChars)), Math.max(8, Math.min(DEFAULT_MAX_LINES, Math.floor(maxChars / 4))))
  return `${preview}\n[tool output summarized: ${Buffer.byteLength(output, 'utf8')} bytes]`
}

export { ToolOutputStore, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES }

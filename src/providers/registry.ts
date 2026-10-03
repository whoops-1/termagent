import process from 'node:process'
import type { Provider, ProviderConfig } from './types.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import { AnthropicProvider } from './anthropic.js'
import { GeminiProvider } from './gemini.js'

export function createProvider(cfg:ProviderConfig):Provider{
  const p=cfg.provider||'openai-compatible'
  const resolved={...cfg,apiKey:cfg.apiKey|| (cfg.apiKeyEnv ? process.env[cfg.apiKeyEnv] : undefined)}
  if(p==='anthropic')return new AnthropicProvider(resolved)
  if(p==='gemini')return new GeminiProvider(resolved)
  return new OpenAICompatibleProvider(resolved)
}

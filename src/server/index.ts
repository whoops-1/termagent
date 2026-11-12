import { createRuntime } from './runtime.js'
import { startServer, type StartServerOptions, type TermAgentHttpServer } from './http.js'
import { acquireDaemonOwner } from './daemon-owner.js'

export async function serve(cwd: string, opts: StartServerOptions) {
  const owner = await acquireDaemonOwner(cwd, { mode: 'server' })
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined
  let server: TermAgentHttpServer | undefined
  let closing: Promise<void> | undefined

  try {
    runtime = await createRuntime(cwd, () => owner.publicInfo())
    server = await startServer(runtime, opts)

    const address = server.address()
    const actualPort = typeof address === 'object' && address ? address.port : opts.port
    const secure = Boolean(opts.tlsCertFile && opts.tlsKeyFile)
    const scheme = secure ? 'https' : 'http'
    const localHost = opts.host === '0.0.0.0' || opts.host === '::' || opts.host === '[::]' ? '127.0.0.1' : opts.host
    const displayHost = localHost.includes(':') && !localHost.startsWith('[') ? `[${localHost}]` : localHost
    const browserOrigin = server.termagent.publicOrigin || `${scheme}://${displayHost}:${actualPort}`

    await owner.update({ state: 'ready', endpoint: browserOrigin })
    await runtime.recoverQueuedPrompts?.()
    console.log(`TermAgent server listening on ${server.termagent.publicOrigin || `${scheme}://${opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host}:${actualPort}`}`)
    console.log(`Web View: ${browserOrigin}/`)
    console.log(`Health: ${browserOrigin}/health`)
    if (server.termagent.authMode === 'device-pairing') {
      const expiresIn = Math.max(1, Math.ceil(((server.termagent.pairingExpiresAt || Date.now()) - Date.now()) / 1000))
      console.log(`One-time pairing code: ${server.termagent.pairingCode} (expires in ${expiresIn}s)`)
      console.log('Pairing codes rotate after redemption or expiry and are printed only in this terminal.')
      console.log('Browser device tokens remain in page memory. Terminal device credentials are stored locally with owner-only permissions; revoke them with /device revoke.')
    } else if (opts.token) {
      console.log('Web View API authentication is enabled; enter the configured runtime token in the browser prompt.')
    } else {
      console.log('Local loopback access is enabled; browser API requests do not require a token.')
    }

    const close = () => {
      if (closing) return closing
      closing = (async () => {
        await owner.update({ state: 'stopping' }).catch(() => undefined)
        try {
          if (server) {
            const closed = new Promise<void>(resolve => server!.close(() => resolve()))
            server.closeAllConnections?.()
            await closed
          }
        } finally {
          try { await runtime?.close() } finally { await owner.release() }
        }
      })()
      return closing
    }
    server.termagent.shutdown = close
    process.once('SIGINT', () => { void close().finally(() => process.exit(0)) })
    process.once('SIGTERM', () => { void close().finally(() => process.exit(0)) })
    return server
  } catch (error) {
    if (server) {
      const closed = new Promise<void>(resolve => server!.close(() => resolve()))
      server.closeAllConnections?.()
      await closed.catch(() => undefined)
    }
    await runtime?.close().catch(() => undefined)
    await owner.release().catch(() => undefined)
    throw error
  }
}

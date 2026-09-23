import type { RunnerStore } from './store.js'

export interface ProtocolRunnerListenServer {
  listen(port: number, host: string, onListening: () => void): unknown
}

export interface StartProtocolRunnerListenerOptions {
  store: Pick<RunnerStore, 'getDiagnostics'>
  server: ProtocolRunnerListenServer
  port: number
  host: string
  onListening: () => void
}

export async function startProtocolRunnerListener(options: StartProtocolRunnerListenerOptions): Promise<void> {
  // Listener reachability is the readiness boundary. The store owner completes
  // schema, integrity, and interrupted-artifact recovery before any caller can
  // reach an otherwise observational GET route.
  await options.store.getDiagnostics()
  options.server.listen(options.port, options.host, options.onListening)
}

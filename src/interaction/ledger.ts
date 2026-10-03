import type { CommandEnvelope, CommandReceipt, DurableSequence } from '../protocol/types.js'
import { commandFingerprint, commandIdempotencyKey, expectedStateMatches } from '../protocol/types.js'
import type { SessionStore } from '../session/store.js'

export type CommandExecutionResult<T> = {
  readonly receipt: CommandReceipt
  readonly result?: T
}

export class CommandLedger {
  constructor(private readonly store: SessionStore) {}

  async get(command: Pick<CommandEnvelope, 'sessionId' | 'clientId' | 'commandId'>) {
    return await this.store.getCommandReceipt(command.sessionId, commandIdempotencyKey(command))
  }

  async execute<T>(command: CommandEnvelope, handler: () => Promise<{ result?: T; appliedSequence?: DurableSequence }>): Promise<CommandExecutionResult<T>> {
    return await this.store.withSessionMutation(command.sessionId, async () => {
      const key = commandIdempotencyKey(command)
      const existing = await this.store.getCommandReceipt(command.sessionId, key)
      const fingerprint = commandFingerprint(command)
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          return {
            receipt: {
              ...existing.receipt,
              status: 'rejected',
              reason: 'idempotency-conflict',
              currentSequence: await this.store.currentSequence(command.sessionId),
            },
          }
        }
        return {
          receipt: {
            ...existing.receipt,
            status: 'duplicate',
            currentSequence: await this.store.currentSequence(command.sessionId),
            originalReceipt: existing.receipt.commandId,
          },
        }
      }

      const currentSequence = await this.store.currentSequence(command.sessionId)
      const revision = await this.store.revision(command.sessionId)
      if (!expectedStateMatches(command, { sequence: currentSequence, revision })) {
        const receipt: CommandReceipt = {
          version: command.version,
          commandId: command.commandId,
          clientId: command.clientId,
          sessionId: command.sessionId,
          status: 'stale',
          currentSequence,
          reason: command.expectedSequence !== undefined && command.expectedSequence !== currentSequence
            ? 'expected-sequence-mismatch'
            : 'expected-revision-mismatch',
        }
        await this.store.appendCommandReceipt(command.sessionId, key, fingerprint, receipt)
        return { receipt }
      }

      const execution = await handler()
      const appliedSequence = execution.appliedSequence ?? await this.store.currentSequence(command.sessionId)
      const receipt: CommandReceipt = {
        version: command.version,
        commandId: command.commandId,
        clientId: command.clientId,
        sessionId: command.sessionId,
        status: 'accepted',
        currentSequence: appliedSequence,
        appliedSequence,
      }
      await this.store.appendCommandReceipt(command.sessionId, key, fingerprint, receipt)
      return { receipt, result: execution.result }
    })
  }
}

import type { Message } from 'chat'
import type { ZappazMessage } from './types.ts'

type Batch = {
  messages: Message<ZappazMessage>[]
  timer: ReturnType<typeof setTimeout> | undefined
  startedAt: number
  chars: number
  done: Promise<void>
  resolve: () => void
}

/** Optional, process-local batching. Pending batches are discarded on disconnect. */
export class MessageBuffer {
  private readonly pending = new Map<string, Batch>()
  private readonly running = new Map<string, Promise<void>>()

  constructor(
    private readonly delayMs: number,
    private readonly dispatch: (messages: Message<ZappazMessage>[]) => Promise<void>,
    private readonly onError: () => void,
  ) {}

  enqueue(message: Message<ZappazMessage>): Promise<void> {
    const key = message.threadId
    let batch = this.pending.get(key)
    if (batch && (batch.messages.length >= 100 || batch.chars + message.text.length > 65_536)) {
      this.flush(key)
      batch = undefined
    }
    if (!batch) {
      let complete = () => {}
      const done = new Promise<void>((resolve) => {
        complete = resolve
      })
      batch = {
        messages: [],
        timer: undefined,
        startedAt: Date.now(),
        chars: 0,
        done,
        resolve: complete,
      }
      this.pending.set(key, batch)
    }
    clearTimeout(batch.timer)
    batch.messages.push(message)
    batch.chars += message.text.length
    batch.timer = setTimeout(
      () => this.flush(key),
      Math.max(0, Math.min(this.delayMs, 60_000 - (Date.now() - batch.startedAt))),
    )
    return batch.done
  }

  private flush(key: string): void {
    const batch = this.pending.get(key)
    if (!batch) return
    clearTimeout(batch.timer)
    this.pending.delete(key)
    const task = (this.running.get(key) ?? Promise.resolve())
      .then(() => this.dispatch(batch.messages))
      .catch(this.onError)
      .finally(() => {
        batch.resolve()
        if (this.running.get(key) === task) this.running.delete(key)
      })
    this.running.set(key, task)
  }

  cancel(key: string): void {
    const batch = this.pending.get(key)
    if (!batch) return
    clearTimeout(batch.timer)
    this.pending.delete(key)
    batch.resolve()
  }

  async disconnect(): Promise<void> {
    for (const key of this.pending.keys()) this.cancel(key)
    await Promise.all(this.running.values())
  }
}

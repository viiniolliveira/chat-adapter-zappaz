import { ZappazAdapter } from './adapter.ts'
import type { ZappazAdapterConfig } from './types.ts'

export { ZappazAdapter } from './adapter.ts'
export { ZappazFormatConverter } from './format-converter.ts'
export type { ZappazAdapterConfig, ZappazMessage, ZappazThreadId } from './types.ts'

export function createZappazAdapter(config: ZappazAdapterConfig): ZappazAdapter {
  return new ZappazAdapter(config)
}

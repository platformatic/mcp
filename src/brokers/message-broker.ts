import type { JSONRPCMessage } from '../schema.ts'

export interface MessageBroker {
  /** Resolves only when the broker has accepted delivery to the intended consumers. */
  publish(topic: string, message: JSONRPCMessage): Promise<void>
  subscribe(topic: string, handler: (message: JSONRPCMessage) => void): Promise<void>
  unsubscribe(topic: string): Promise<void>
  close(): Promise<void>
}

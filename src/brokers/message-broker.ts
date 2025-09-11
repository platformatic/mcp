export interface MessageBroker {
  publish(topic: string, message: any): Promise<void>
  subscribe(topic: string, handler: (message: any) => void): Promise<void>
  unsubscribe(topic: string): Promise<void>
  close(): Promise<void>
}

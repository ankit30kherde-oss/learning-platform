import Redis from 'ioredis';
import { EventEnvelope, EventName } from './events';
import { newEventId } from './correlation';

/**
 * Minimal publish/subscribe abstraction.
 *
 * Dev: Redis Pub/Sub + a Redis list as a lightweight dead-letter store.
 * Prod: swap the body of publish/subscribe for EventBridge PutEvents and an
 *       SQS consumer. Nothing in the services changes because they only ever
 *       see EventEnvelope<T>.
 */
export class EventBus {
  private publisher: Redis;
  private subscriber?: Redis;

  constructor(
    private readonly redisUrl: string,
    private readonly source: string,
  ) {
    this.publisher = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
  }

  async publish<T>(name: EventName, data: T, correlationId?: string): Promise<EventEnvelope<T>> {
    const envelope: EventEnvelope<T> = {
      id: newEventId(),
      name,
      occurredAt: new Date().toISOString(),
      correlationId,
      source: this.source,
      version: 1,
      data,
    };
    await this.publisher.publish(`lp.${name}`, JSON.stringify(envelope));
    // Keep a short audit trail of what we emitted (dev aid only).
    await this.publisher.lpush('lp.events.log', JSON.stringify(envelope));
    await this.publisher.ltrim('lp.events.log', 0, 499);
    return envelope;
  }

  /**
   * Subscribe to one or more events. The handler must be idempotent:
   * at-least-once delivery is assumed (true for SQS, and for Redis on reconnect).
   */
  async subscribe(
    names: EventName[],
    handler: (evt: EventEnvelope<any>) => Promise<void>,
  ): Promise<void> {
    this.subscriber = new Redis(this.redisUrl, { maxRetriesPerRequest: null });
    await this.subscriber.subscribe(...names.map((n) => `lp.${n}`));
    this.subscriber.on('message', async (_channel: string, raw: string) => {
      let evt: EventEnvelope<any>;
      try {
        evt = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        await handler(evt);
      } catch (err) {
        // Dead-letter: in prod this is the SQS redrive policy / DLQ.
        await this.publisher.lpush(
          'lp.events.dlq',
          JSON.stringify({ evt, error: (err as Error).message, at: new Date().toISOString() }),
        );
      }
    });
  }

  async close(): Promise<void> {
    await this.subscriber?.quit();
    await this.publisher.quit();
  }
}

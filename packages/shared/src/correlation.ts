import { randomUUID } from 'crypto';

export function newCorrelationId(): string {
  return randomUUID();
}

export function newEventId(): string {
  return randomUUID();
}

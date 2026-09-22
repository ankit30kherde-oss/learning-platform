import type { LabTemplate } from '@prisma/client';

/**
 * What lab-service needs from "a thing that can give a student a shell".
 *
 * Keeping this interface narrow is what lets Codespaces run Docker containers
 * and production run pods in per-session Kubernetes namespaces without the
 * session logic, the TTL reaper or the WebSocket layer knowing which is which.
 */
export interface ProvisionResult {
  driver: 'KUBERNETES' | 'LOCAL_DOCKER';
  namespace: string | null;
  podName: string | null;
  containerId: string | null;
}

export interface LabAttachment {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  onData(cb: (chunk: Buffer | string) => void): void;
  onExit(cb: () => void): void;
  close(): void;
}

export interface LabDriverPort {
  readonly name: 'KUBERNETES' | 'LOCAL_DOCKER';
  provision(sessionId: string, template: LabTemplate): Promise<ProvisionResult>;
  attach(handle: ProvisionResult, template: LabTemplate): Promise<LabAttachment>;
  destroy(handle: ProvisionResult): Promise<void>;
  listOrphans?(activeIds: string[]): Promise<string[]>;
}

export const LAB_DRIVER = Symbol('LAB_DRIVER');

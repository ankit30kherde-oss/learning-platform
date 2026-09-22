import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough } from 'node:stream';
import * as k8s from '@kubernetes/client-node';
import type { LabTemplate } from '@prisma/client';
import type { LabAttachment, LabDriverPort, ProvisionResult } from './driver.port';

/**
 * Production driver.
 *
 * One namespace per session. That sounds heavy, and it is the point: a
 * namespace is the unit that ResourceQuota, LimitRange, NetworkPolicy and RBAC
 * all attach to, so "this student gets exactly one pod, half a core, no
 * network and no service account" becomes a property of the namespace rather
 * than a set of flags someone can forget on the pod.
 *
 * What the pod does NOT get, deliberately:
 *   - no service account token (automountServiceAccountToken: false), so even
 *     a full shell cannot talk to the Kubernetes API
 *   - no privilege escalation, no capabilities, non-root, read-only rootfs
 *   - no host mounts, no hostPath, no Docker socket, no hostNetwork/PID/IPC
 *   - RuntimeDefault seccomp, which blocks the syscalls used by most container
 *     escapes
 *   - egress denied except cluster DNS, unless the template opts in
 *
 * Whether this belongs on its own EKS cluster: yes, for production. Student
 * containers are hostile-by-assumption workloads, and a kernel-level escape on
 * a shared node puts your payment service on the same kernel. A separate lab
 * cluster (or at minimum a dedicated, tainted node group with Bottlerocket or
 * gVisor/Firecracker-style isolation) keeps the blast radius inside the labs.
 */
@Injectable()
export class KubernetesDriver implements LabDriverPort {
  readonly name = 'KUBERNETES' as const;
  private readonly logger = new Logger(KubernetesDriver.name);

  private readonly kc = new k8s.KubeConfig();
  private readonly core: k8s.CoreV1Api;
  private readonly net: k8s.NetworkingV1Api;
  private readonly exec: k8s.Exec;

  constructor(private readonly config: ConfigService) {
    // In-cluster when running on EKS (projected SA token), kubeconfig locally.
    try {
      if (process.env.KUBERNETES_SERVICE_HOST) this.kc.loadFromCluster();
      else this.kc.loadFromDefault();
    } catch (err) {
      this.logger.error(`no usable kube config: ${(err as Error).message}`);
    }
    this.core = this.kc.makeApiClient(k8s.CoreV1Api);
    this.net = this.kc.makeApiClient(k8s.NetworkingV1Api);
    this.exec = new k8s.Exec(this.kc);
  }

  async provision(sessionId: string, template: LabTemplate): Promise<ProvisionResult> {
    const ns = `lab-${sessionId.slice(0, 18)}`;
    const podName = 'shell';

    await this.core.createNamespace({
      body: {
        metadata: {
          name: ns,
          labels: {
            'app.kubernetes.io/part-of': 'learning-platform',
            'lp.io/workload': 'lab',
            'lp.io/session': sessionId,
            // Enforce the restricted Pod Security Standard at admission. If the
            // pod spec below ever regresses, the API server rejects it.
            'pod-security.kubernetes.io/enforce': 'restricted',
            'pod-security.kubernetes.io/enforce-version': 'latest',
          },
        },
      },
    });

    await this.core.createNamespacedResourceQuota({
      namespace: ns,
      body: {
        metadata: { name: 'lab-quota' },
        spec: {
          hard: {
            pods: '1',
            'requests.cpu': template.cpuLimit,
            'requests.memory': template.memoryLimit,
            'limits.cpu': template.cpuLimit,
            'limits.memory': template.memoryLimit,
            'requests.ephemeral-storage': template.ephemeralLimit,
            'limits.ephemeral-storage': template.ephemeralLimit,
            services: '0',
            'persistentvolumeclaims': '0',
            secrets: '1',
          },
        },
      },
    });

    await this.core.createNamespacedLimitRange({
      namespace: ns,
      body: {
        metadata: { name: 'lab-limits' },
        spec: {
          limits: [
            {
              type: 'Container',
              default: { cpu: template.cpuLimit, memory: template.memoryLimit },
              defaultRequest: { cpu: template.cpuRequest, memory: template.memoryRequest },
              max: { cpu: template.cpuLimit, memory: template.memoryLimit },
            },
          ],
        },
      },
    });

    // Default-deny both directions, then allow only DNS out.
    await this.net.createNamespacedNetworkPolicy({
      namespace: ns,
      body: {
        metadata: { name: 'deny-all' },
        spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] },
      },
    });

    await this.net.createNamespacedNetworkPolicy({
      namespace: ns,
      body: {
        metadata: { name: 'allow-dns' },
        spec: {
          podSelector: {},
          policyTypes: ['Egress'],
          egress: [
            {
              to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } }],
              ports: [
                { protocol: 'UDP', port: 53 },
                { protocol: 'TCP', port: 53 },
              ],
            },
            ...(template.allowEgress
              ? [
                  {
                    to: (template.allowedEgressCidrs.length
                      ? template.allowedEgressCidrs
                      : ['0.0.0.0/0']
                    ).map((cidr) => ({
                      ipBlock: {
                        cidr,
                        // Never let a lab reach the node's instance metadata
                        // endpoint - that is how you turn a shell into an IAM role.
                        except: ['169.254.169.254/32', '10.0.0.0/8'],
                      },
                    })),
                  },
                ]
              : []),
          ],
        },
      },
    });

    await this.core.createNamespacedPod({
      namespace: ns,
      body: {
        metadata: { name: podName, labels: { 'lp.io/session': sessionId } },
        spec: {
          automountServiceAccountToken: false,
          enableServiceLinks: false,
          restartPolicy: 'Never',
          // Keep labs off the nodes that run the platform itself.
          nodeSelector: { 'lp.io/workload': 'lab' },
          tolerations: [{ key: 'lp.io/lab', operator: 'Exists', effect: 'NoSchedule' }],
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            seccompProfile: { type: 'RuntimeDefault' },
          },
          containers: [
            {
              name: 'shell',
              image: template.image,
              command: ['sleep', String(template.ttlSeconds + 60)],
              workingDir: template.workingDir,
              env: [
                { name: 'HOME', value: template.workingDir },
                { name: 'TERM', value: 'xterm-256color' },
              ],
              resources: {
                requests: {
                  cpu: template.cpuRequest,
                  memory: template.memoryRequest,
                  'ephemeral-storage': '256Mi',
                },
                limits: {
                  cpu: template.cpuLimit,
                  memory: template.memoryLimit,
                  'ephemeral-storage': template.ephemeralLimit,
                },
              },
              securityContext: {
                allowPrivilegeEscalation: false,
                privileged: false,
                readOnlyRootFilesystem: true,
                capabilities: { drop: ['ALL'] },
              },
              volumeMounts: [
                { name: 'home', mountPath: template.workingDir },
                { name: 'tmp', mountPath: '/tmp' },
              ],
            },
          ],
          volumes: [
            { name: 'home', emptyDir: { sizeLimit: '256Mi' } },
            { name: 'tmp', emptyDir: { sizeLimit: '64Mi' } },
          ],
        },
      },
    });

    await this.waitForRunning(ns, podName, 60_000);
    this.logger.log(`lab pod ready: ${ns}/${podName}`);

    return { driver: this.name, namespace: ns, podName, containerId: null };
  }

  async attach(handle: ProvisionResult, template: LabTemplate): Promise<LabAttachment> {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();

    const listeners = { data: [] as ((c: Buffer) => void)[], exit: [] as (() => void)[] };
    stdout.on('data', (c: Buffer) => listeners.data.forEach((f) => f(c)));
    stderr.on('data', (c: Buffer) => listeners.data.forEach((f) => f(c)));

    const ws = await this.exec.exec(
      handle.namespace!,
      handle.podName!,
      'shell',
      [template.shell],
      stdout,
      stderr,
      stdin,
      true, // tty
      () => listeners.exit.forEach((f) => f()),
    );

    return {
      write: (data: string) => stdin.write(data),
      resize: (cols: number, rows: number) => {
        // Channel 4 is the resize channel in the Kubernetes exec protocol.
        try {
          const frame = Buffer.concat([
            Buffer.from([4]),
            Buffer.from(JSON.stringify({ Width: cols, Height: rows })),
          ]);
          (ws as any)?.send?.(frame);
        } catch {
          /* best effort - a missed resize is cosmetic */
        }
      },
      onData: (cb) => listeners.data.push(cb),
      onExit: (cb) => listeners.exit.push(cb),
      close: () => {
        stdin.end();
        try {
          (ws as any)?.close?.();
        } catch {
          /* already gone */
        }
      },
    };
  }

  /** Deleting the namespace takes the pod, the quota and the policies with it. */
  async destroy(handle: ProvisionResult): Promise<void> {
    if (!handle.namespace) return;
    await this.core
      .deleteNamespace({ name: handle.namespace, gracePeriodSeconds: 5 })
      .catch((err: Error) => this.logger.warn(`namespace delete failed: ${err.message}`));
  }

  /** Namespaces whose session we no longer track, e.g. after a crash. */
  async listOrphans(activeIds: string[]): Promise<string[]> {
    const res = await this.core.listNamespace({ labelSelector: 'lp.io/workload=lab' });
    return res.items
      .map((n) => n.metadata?.labels?.['lp.io/session'])
      .filter((id): id is string => Boolean(id) && !activeIds.includes(id!));
  }

  private async waitForRunning(ns: string, pod: string, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await this.core.readNamespacedPodStatus({ name: pod, namespace: ns });
      const phase = res.status?.phase;
      if (phase === 'Running') return;
      if (phase === 'Failed') throw new ServiceUnavailableException('The lab pod failed to start.');
      await new Promise((r) => setTimeout(r, 750));
    }
    throw new ServiceUnavailableException('The lab took too long to start. Try again.');
  }
}

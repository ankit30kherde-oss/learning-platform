import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LabTemplate } from '@prisma/client';
import type { LabAttachment, LabDriverPort, ProvisionResult } from './driver.port';

/**
 * Development driver for Codespaces, where there is no Kubernetes but there is
 * a Docker daemon.
 *
 * It applies the same shape of isolation Kubernetes gives us in production -
 * no network, dropped capabilities, read-only root filesystem, memory/CPU/PID
 * caps, non-root user, tmpfs home - using docker run flags. It is not a
 * substitute for the real thing (a container escape here lands on the
 * Codespace VM), but it means the lab lesson is genuinely runnable end to end
 * before anyone pays for an EKS cluster.
 *
 * The pty trick: `docker exec -i` gives us pipes, not a terminal, so programs
 * like `top` and shell line editing would misbehave. Running the shell under
 * util-linux/busybox `script` allocates a pty *inside* the container, so we get
 * proper terminal behaviour without a native node-pty dependency.
 */
@Injectable()
export class LocalDockerDriver implements LabDriverPort {
  readonly name = 'LOCAL_DOCKER' as const;
  private readonly logger = new Logger(LocalDockerDriver.name);

  constructor(private readonly config: ConfigService) {}

  async provision(sessionId: string, template: LabTemplate): Promise<ProvisionResult> {
    const containerName = `lp-lab-${sessionId.slice(0, 12)}`;
    const image = this.config.get<string>('LAB_IMAGE') ?? template.image;

    const args = [
      'run',
      '-d',
      '--name', containerName,
      '--label', 'app=lp-lab',
      '--label', `session=${sessionId}`,

      // --- isolation -------------------------------------------------------
      ...(template.allowEgress ? [] : ['--network', 'none']),
      '--memory', template.memoryLimit.replace('Mi', 'm').replace('Gi', 'g'),
      '--memory-swap', template.memoryLimit.replace('Mi', 'm').replace('Gi', 'g'),
      '--cpus', String(millicoresToCpus(template.cpuLimit)),
      '--pids-limit', String(template.pidsLimit),
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--read-only',
      '--tmpfs', `${template.workingDir}:rw,size=64m,uid=1000,gid=1000,exec`,
      '--tmpfs', '/tmp:rw,size=32m',
      '--tmpfs', '/run:rw,size=8m',
      '-u', '1000:1000',
      '-w', template.workingDir,
      '-e', 'HOME=' + template.workingDir,
      '-e', 'TERM=xterm-256color',
      '-e', 'PS1=lab:\\w\\$ ',

      image,
      // The container itself just idles; every attach is a separate exec.
      'sleep', String(template.ttlSeconds + 60),
    ];

    await this.run('docker', args);
    this.logger.log(`started container ${containerName} from ${image}`);

    return { driver: this.name, containerId: containerName, namespace: null, podName: null };
  }

  async attach(handle: ProvisionResult, template: LabTemplate): Promise<LabAttachment> {
    const shell = await this.pickShell(handle.containerId!, template.shell);

    // `script` gives the shell a real pty; `-q` keeps its banner out of the
    // student's terminal.
    const child: ChildProcessWithoutNullStreams = spawn(
      'docker',
      ['exec', '-i', '-e', 'TERM=xterm-256color', handle.containerId!, 'script', '-q', '-c', shell, '/dev/null'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );

    const listeners = { data: [] as ((c: Buffer) => void)[], exit: [] as (() => void)[] };
    child.stdout.on('data', (c: Buffer) => listeners.data.forEach((f) => f(c)));
    child.stderr.on('data', (c: Buffer) => listeners.data.forEach((f) => f(c)));
    child.on('exit', () => listeners.exit.forEach((f) => f()));

    return {
      write: (data: string) => {
        if (!child.killed) child.stdin.write(data);
      },
      // Without node-pty there is no TIOCSWINSZ to set, so we tell the shell
      // directly. `stty` inside the container is close enough for line wrap.
      resize: (cols: number, rows: number) => {
        if (!child.killed) child.stdin.write(`stty cols ${cols} rows ${rows} 2>/dev/null\n`);
      },
      onData: (cb) => listeners.data.push(cb),
      onExit: (cb) => listeners.exit.push(cb),
      close: () => {
        child.stdin.end();
        child.kill('SIGKILL');
      },
    };
  }

  async destroy(handle: ProvisionResult): Promise<void> {
    if (!handle.containerId) return;
    await this.run('docker', ['rm', '-f', handle.containerId]).catch(() => undefined);
    this.logger.log(`removed container ${handle.containerId}`);
  }

  /** Reaper support: containers we lost track of (process restart, crash). */
  async listOrphans(activeIds: string[]): Promise<string[]> {
    const out = await this.run('docker', ['ps', '-a', '-q', '--filter', 'label=app=lp-lab', '--format', '{{.Names}}']);
    return out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((name) => !activeIds.includes(name));
  }

  private async pickShell(containerId: string, preferred: string): Promise<string> {
    try {
      await this.run('docker', ['exec', containerId, 'test', '-x', preferred]);
      return preferred;
    } catch {
      return '/bin/sh';
    }
  }

  private run(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const p = spawn(cmd, args);
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => (out += d.toString()));
      p.stderr.on('data', (d) => (err += d.toString()));
      p.on('error', reject);
      p.on('close', (code) =>
        code === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args[0]} failed: ${err.trim() || code}`)),
      );
    });
  }
}

/** "500m" -> 0.5, "2" -> 2 */
function millicoresToCpus(v: string): number {
  return v.endsWith('m') ? Number(v.slice(0, -1)) / 1000 : Number(v);
}

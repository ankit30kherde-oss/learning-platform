import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Server, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { LabsService } from './labs.service';
import { LAB_DRIVER, type LabAttachment, type LabDriverPort } from './drivers/driver.port';

/**
 * The terminal bridge.
 *
 * Deliberately NOT a Nest WebSocket gateway: we want to own the HTTP upgrade so
 * the ticket is validated before the socket is accepted. A rejected ticket gets
 * a 401 on the upgrade and never becomes a WebSocket at all, which keeps
 * unauthenticated clients from holding open connections.
 *
 * Wire protocol, browser -> server, is JSON text frames:
 *   {"type":"stdin","data":"ls\r"}      keystrokes
 *   {"type":"resize","cols":120,"rows":30}
 * Server -> browser is raw binary terminal output, plus one JSON control frame
 * ({"type":"exit"}) when the shell dies.
 */
@Injectable()
export class LabTerminalGateway implements OnModuleDestroy {
  private readonly logger = new Logger(LabTerminalGateway.name);
  private readonly wss = new WebSocketServer({ noServer: true });

  /** Live attachments, so a server shutdown can close them cleanly. */
  private readonly live = new Map<string, { socket: WebSocket; attachment: LabAttachment }>();

  constructor(
    private readonly labs: LabsService,
    private readonly config: ConfigService,
    @Inject(LAB_DRIVER) private readonly driver: LabDriverPort,
  ) {}

  /** Called from main.ts once the HTTP server exists. */
  bind(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://placeholder');
      if (url.pathname !== '/labs/ws') return; // not ours; leave it alone

      void this.handleUpgrade(req, socket, head, url);
    });
    this.logger.log('lab terminal websocket listening on /labs/ws');
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    const ticket = url.searchParams.get('ticket');
    if (!ticket) return reject(socket, 400, 'Missing ticket');

    let session;
    let template;
    try {
      ({ session, template } = await this.labs.redeemTicket(ticket));
    } catch (err) {
      this.logger.warn(`rejected lab upgrade: ${(err as Error).message}`);
      return reject(socket, 401, 'Invalid or expired ticket');
    }

    this.wss.handleUpgrade(req, socket, head, (ws) => {
      void this.attach(ws, session!, template!);
    });
  }

  private async attach(ws: WebSocket, session: any, template: any) {
    let attachment: LabAttachment;
    try {
      attachment = await this.driver.attach(
        {
          driver: this.driver.name,
          namespace: session.namespace,
          podName: session.podName,
          containerId: session.containerId,
        },
        template,
      );
    } catch (err) {
      this.logger.error(`attach failed for ${session.id}: ${(err as Error).message}`);
      ws.send(JSON.stringify({ type: 'exit', reason: 'attach_failed' }));
      ws.close();
      return;
    }

    this.live.set(session.id, { socket: ws, attachment });

    let bytesIn = 0;
    let bytesOut = 0;
    // One write per 10 s of activity instead of one per keystroke: the idle
    // reaper only needs coarse resolution, and this keeps lab_sessions from
    // becoming the hottest table on the box.
    const heartbeat = setInterval(() => {
      if (bytesIn || bytesOut) {
        void this.labs.touch(session.id, bytesIn, bytesOut);
        bytesIn = 0;
        bytesOut = 0;
      }
    }, 10_000);

    attachment.onData((chunk) => {
      bytesOut += chunk.length;
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    });

    attachment.onExit(() => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'exit' }));
      ws.close();
    });

    ws.on('message', (raw) => {
      const text = raw.toString();
      bytesIn += text.length;

      // Cap a single frame: a client that pastes 2 MB into a 512 MB container
      // is not learning Linux.
      if (text.length > 16_384) {
        ws.send(JSON.stringify({ type: 'exit', reason: 'frame_too_large' }));
        ws.close();
        return;
      }

      let msg: { type?: string; data?: string; cols?: number; rows?: number };
      try {
        msg = JSON.parse(text);
      } catch {
        return; // ignore malformed frames rather than killing the session
      }

      if (msg.type === 'stdin' && typeof msg.data === 'string') {
        attachment.write(msg.data);
      } else if (msg.type === 'resize') {
        const cols = clamp(msg.cols ?? 80, 20, 300);
        const rows = clamp(msg.rows ?? 24, 5, 100);
        attachment.resize(cols, rows);
      }
    });

    const teardown = async (reason: string) => {
      clearInterval(heartbeat);
      this.live.delete(session.id);
      attachment.close();
      // Closing the tab should return the container, not leave it billing until
      // the idle reaper wakes up.
      await this.labs.stop(session.id, null, reason).catch(() => undefined);
    };

    ws.on('close', () => void teardown('client_closed'));
    ws.on('error', () => void teardown('socket_error'));
  }

  async onModuleDestroy() {
    for (const [id, { socket, attachment }] of this.live) {
      attachment.close();
      socket.close();
      await this.labs.stop(id, null, 'service_shutdown').catch(() => undefined);
    }
    this.wss.close();
  }
}

function reject(socket: Duplex, code: number, message: string) {
  socket.write(`HTTP/1.1 ${code} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(n)));
}

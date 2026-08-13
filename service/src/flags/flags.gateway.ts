import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Flag } from './flags.types';

/**
 * Push-based invalidation channel. SDKs open one socket connection per
 * process and receive a `flag:updated` event carrying the *full* new flag
 * state the instant a change commits -- no polling, no extra round trip to
 * fetch what changed.
 *
 * This is a single-process fan-out (`this.server.emit(...)` reaches every
 * socket connected to *this* instance). Running more than one service
 * instance behind a load balancer requires a shared fan-out layer so a
 * write on instance A reaches SDKs connected to instance B: either Postgres
 * `LISTEN/NOTIFY` (each instance also listens on a channel and re-emits to
 * its own local sockets) or Redis pub/sub (same pattern, lower latency,
 * common when Postgres is already the system of record and you don't want
 * NOTIFY payload-size limits). Both are a small addition here: publish the
 * changed flag in `broadcastFlagChanged` in addition to the local emit, and
 * subscribe once at boot to re-emit to local sockets.
 */
@WebSocketGateway({ cors: { origin: '*' } })
export class FlagsGateway implements OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  handleConnection(client: Socket) {
    client.emit('connected', { ts: Date.now() });
  }

  broadcastFlagChanged(flag: Flag) {
    this.server?.emit('flag:updated', flag);
  }
}

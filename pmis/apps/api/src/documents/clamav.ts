import { connect, type Socket } from 'node:net';
import { Readable } from 'node:stream';

/**
 * ClamAV over clamd's INSTREAM command (owner answer Q134). The file is sent in chunks (4-byte big-endian length, then the data, then a
 * zero-length chunk); clamd answers `stream: OK`, `stream: <signature> FOUND` or an error. Connects by unix socket (CLAMD_SOCKET) or TCP
 * (CLAMD_HOST, CLAMD_PORT). Any failure to reach or read clamd is a ScannerUnavailable, which the storage layer turns into 503 or a
 * rescan flag according to SCAN_FAILURE.
 */
export class ScannerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScannerUnavailable';
  }
}

export interface ScanVerdict {
  infected: boolean;
  signature?: string;
}

export interface Scanner {
  scan(body: Buffer | Readable): Promise<ScanVerdict>;
  ping(): Promise<boolean>;
}

export interface ClamdOptions {
  socket?: string;
  host?: string;
  port?: number;
  timeoutMs: number;
  chunkBytes?: number;
}

const MAX_CHUNK_DEFAULT = 64 * 1024;

function connectTo(o: ClamdOptions): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = o.socket ? connect(o.socket) : connect(o.port ?? 3310, o.host ?? '127.0.0.1');
    s.setTimeout(o.timeoutMs);
    s.once('connect', () => resolve(s));
    s.once('timeout', () => {
      s.destroy();
      reject(new ScannerUnavailable('clamd timed out'));
    });
    s.once('error', (e) => reject(new ScannerUnavailable(`clamd unreachable: ${e.message}`)));
  });
}

/** Reads one reply (up to the NUL terminator, or the end of the connection). */
function readReply(s: Socket, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    const finish = (): void => {
      const text = Buffer.concat(parts).toString('utf8').replace(/\0+$/, '').trim();
      resolve(text);
    };
    s.on('data', (d: Buffer) => {
      parts.push(d);
      if (d.includes(0)) finish();
    });
    s.once('end', finish);
    s.once('close', finish);
    s.once('error', (e) => reject(new ScannerUnavailable(`clamd read failed: ${e.message}`)));
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      reject(new ScannerUnavailable('clamd timed out'));
    });
  });
}

export class ClamdScanner implements Scanner {
  constructor(private readonly o: ClamdOptions) {}

  async scan(body: Buffer | Readable): Promise<ScanVerdict> {
    const sock = await connectTo(this.o);
    const chunk = this.o.chunkBytes ?? MAX_CHUNK_DEFAULT;
    try {
      sock.write(Buffer.from('zINSTREAM\0'));
      if (Buffer.isBuffer(body)) {
        for (let off = 0; off < body.length; off += chunk) await writeChunk(sock, body.subarray(off, off + chunk));
      } else {
        for await (const c of body) {
          const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
          for (let off = 0; off < b.length; off += chunk) await writeChunk(sock, b.subarray(off, off + chunk));
        }
      }
      sock.write(Buffer.alloc(4));
      const reply = await readReply(sock, this.o.timeoutMs);
      return parseReply(reply);
    } finally {
      sock.destroy();
    }
  }

  async ping(): Promise<boolean> {
    try {
      const sock = await connectTo(this.o);
      sock.write(Buffer.from('zPING\0'));
      const r = await readReply(sock, this.o.timeoutMs);
      sock.destroy();
      return r === 'PONG';
    } catch {
      return false;
    }
  }
}

function writeChunk(s: Socket, data: Buffer): Promise<void> {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  return new Promise((resolve, reject) => {
    s.write(Buffer.concat([len, data]), (e) => (e ? reject(new ScannerUnavailable(`clamd write failed: ${e.message}`)) : resolve()));
  });
}

/** `stream: OK` is clean, `stream: NAME FOUND` is infected; anything else (ERROR, size limit, unknown text) is not a verdict. */
export function parseReply(reply: string): ScanVerdict {
  if (/^stream: OK$/.test(reply)) return { infected: false };
  const m = /^stream: (.+) FOUND$/.exec(reply);
  if (m && m[1]) return { infected: true, signature: m[1].slice(0, 200) };
  throw new ScannerUnavailable(`clamd did not give a verdict: ${reply.slice(0, 120)}`);
}

import { createServer, type Server } from 'node:net';

/** The EICAR test signature (the standard antivirus test file, harmless). */
export const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

/**
 * A stand-in for clamd on a unix socket. It speaks the two commands the API uses: zPING and zINSTREAM (length-prefixed chunks, a zero-length
 * end chunk). A stream that contains the EICAR string gets `stream: Win.Test.EICAR_HDB-1 FOUND`, anything else `stream: OK`.
 * `mode` = 'error' answers every scan with an ERROR line (clamd up, but it could not scan).
 */
export interface FakeClamd {
  socketPath: string;
  scans: number;
  mode: 'normal' | 'error';
  close(): Promise<void>;
}

export function startFakeClamd(socketPath: string): Promise<FakeClamd> {
  const fake: FakeClamd = {
    socketPath,
    scans: 0,
    mode: 'normal',
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
  const server: Server = createServer((sock) => {
    let buf = Buffer.alloc(0);
    let cmd: 'none' | 'instream' = 'none';
    const parts: Buffer[] = [];
    let done = false;
    const reply = (text: string): void => {
      if (done) return;
      done = true;
      sock.end(`${text}\0`);
    };
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (cmd === 'none') {
        if (buf.length < 6) return;
        if (buf.subarray(0, 6).toString() === 'zPING\0') return reply('PONG');
        if (buf.subarray(0, 10).toString() === 'zINSTREAM\0') {
          cmd = 'instream';
          buf = buf.subarray(10);
        } else {
          return reply('UNKNOWN COMMAND');
        }
      }
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32BE(0);
        if (len === 0) {
          fake.scans++;
          buf = buf.subarray(4);
          if (fake.mode === 'error') return reply('INSTREAM size limit exceeded. ERROR');
          const text = Buffer.concat(parts).toString('latin1');
          return reply(text.includes(EICAR) ? 'stream: Win.Test.EICAR_HDB-1 FOUND' : 'stream: OK');
        }
        if (buf.length < 4 + len) return;
        parts.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
    sock.on('error', () => undefined);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve(fake));
  });
}

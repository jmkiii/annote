// Minimal zero-dependency WebSocket (RFC 6455): server + client, text frames.
// Enough for the Annote relay protocol; no extensions, no compression.
import { createServer } from "http";
import { createHash, randomBytes } from "crypto";
import { connect as netConnect } from "net";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function makeConn(socket, maskOutgoing) {
  const conn = { onmessage: null, onclose: null, send, close, open: true };
  let buf = Buffer.alloc(0);
  socket.on("data", (d) => { buf = Buffer.concat([buf, d]); parse(); });
  socket.on("close", fireClose);
  socket.on("error", fireClose);
  function fireClose() { if (conn.open) { conn.open = false; conn.onclose?.(); } }

  function parse() {
    while (true) {
      if (buf.length < 2) return;
      const op = buf[0] & 0x0f;
      const masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const m = buf.subarray(off, off + 4);
        payload = Buffer.from(payload);
        for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3];
      }
      buf = buf.subarray(off + maskLen + len);
      if (op === 8) { try { socket.end(); } catch {} fireClose(); return; }
      if (op === 9) { try { socket.write(frame(payload, 10)); } catch {} continue; } // ping → pong
      if (op === 1 || op === 2) conn.onmessage?.(payload.toString("utf8"));
    }
  }

  function frame(payload, op = 1) {
    const p = Buffer.from(payload);
    let header;
    if (p.length < 126) header = Buffer.from([0x80 | op, p.length | (maskOutgoing ? 0x80 : 0)]);
    else if (p.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op; header[1] = 126 | (maskOutgoing ? 0x80 : 0);
      header.writeUInt16BE(p.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op; header[1] = 127 | (maskOutgoing ? 0x80 : 0);
      header.writeBigUInt64BE(BigInt(p.length), 2);
    }
    if (!maskOutgoing) return Buffer.concat([header, p]);
    const m = randomBytes(4);
    const mp = Buffer.from(p);
    for (let i = 0; i < mp.length; i++) mp[i] ^= m[i & 3];
    return Buffer.concat([header, m, mp]);
  }

  function send(text) { if (conn.open) { try { socket.write(frame(text, 1)); } catch {} } }
  function close() { try { socket.end(); } catch {} fireClose(); }
  return conn;
}

export function serve(port, onConn) {
  const server = createServer((_req, res) => { res.writeHead(426); res.end("Annote relay: WebSocket only\n"); });
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`);
    onConn(makeConn(socket, false));
  });
  server.listen(port);
  return server;
}

export function connect(url, handlers = {}) {
  const u = new URL(url);
  const key = randomBytes(16).toString("base64");
  const socket = netConnect(Number(u.port) || 80, u.hostname);
  let headerBuf = Buffer.alloc(0);
  socket.on("connect", () => {
    socket.write(
      `GET ${u.pathname || "/"} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  });
  const onData = (d) => {
    headerBuf = Buffer.concat([headerBuf, d]);
    const idx = headerBuf.indexOf("\r\n\r\n");
    if (idx < 0) return;
    socket.off("data", onData);
    const conn = makeConn(socket, true); // client masks outgoing frames
    conn.onmessage = handlers.onmessage || null;
    conn.onclose = handlers.onclose || null;
    const rest = headerBuf.subarray(idx + 4);
    if (rest.length) socket.emit("data", rest);
    handlers.onopen?.(conn);
  };
  socket.on("data", onData);
  socket.on("error", () => handlers.onclose?.());
}

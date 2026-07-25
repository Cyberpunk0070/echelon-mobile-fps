/* ECHELON latency probe — zero-dependency WebSocket echo + static host.
 *
 * Measures the transport the multiplayer server would actually use, at the
 * rate it would actually use it. Deliberately has no npm dependencies so it
 * runs under a bare `node:20-alpine` container with no install step and no
 * network access at build time.
 *
 *   node server.js [port]        (default 7900)
 *
 * Protocol: client sends "<seq>,<clientSendMs>" as a text frame. Server echoes
 * "<seq>,<clientSendMs>,<serverRecvMs>" padded to SNAPSHOT_BYTES, so the
 * downstream direction carries a realistic 30 Hz snapshot payload rather than
 * a few bytes. Client-to-server stays small, matching an input command.
 */
"use strict";

const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || 7900);
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// Emulates a delta-compressed 12-entity snapshot. Kept well under the 1280-byte
// WireGuard MTU so a single snapshot never spans multiple TCP segments.
const SNAPSHOT_BYTES = 250;

/* ---------------- RFC 6455 framing ---------------- */

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload));
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;          // FIN set, single-frame messages only
  return Buffer.concat([header, data]);
}

/* Incremental frame reader. TCP gives no message boundaries, so bytes are
   accumulated and frames are drained only once fully present. */
function makeParser({ onMessage, onClose, onPing }) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (buf.length < 2) return;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < off + 2) return;
        len = buf.readUInt16BE(off); off += 2;
      } else if (len === 127) {
        if (buf.length < off + 8) return;
        len = Number(buf.readBigUInt64BE(off)); off += 8;
      }
      let mask = null;
      if (masked) {
        if (buf.length < off + 4) return;
        mask = buf.subarray(off, off + 4); off += 4;
      }
      if (buf.length < off + len) return;
      const payload = Buffer.from(buf.subarray(off, off + len));
      if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(off + len);

      if (opcode === 0x1 || opcode === 0x2) onMessage(payload);
      else if (opcode === 0x8) { onClose(); return; }
      else if (opcode === 0x9) onPing(payload);
    }
  };
}

/* ---------------- static host ---------------- */

const INDEX = path.join(__dirname, "index.html");

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }
  if (url === "/" || url === "/index.html") {
    let html;
    try { html = fs.readFileSync(INDEX); }
    catch { res.writeHead(500); return res.end("index.html missing"); }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(html);
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

/* ---------------- websocket echo ---------------- */

let liveClients = 0;

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();

  const accept = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  /* Nagle batches small writes for up to ~40 ms. Left on, it would inject
     delay of the same order as the thing being measured — and would do the
     same to real game traffic. This single line matters more than it looks. */
  socket.setNoDelay(true);

  const peer = req.headers["cf-connecting-ip"] || socket.remoteAddress;
  liveClients++;
  console.log(`[+] ${peer} connected (${liveClients} live)`);

  let closed = false;
  const shutdown = () => {
    if (closed) return;
    closed = true;
    liveClients--;
    console.log(`[-] ${peer} disconnected (${liveClients} live)`);
    socket.destroy();
  };

  const parser = makeParser({
    onMessage: payload => {
      const body = `${payload.toString("latin1")},${Date.now()}`;
      const pad = SNAPSHOT_BYTES - body.length - 1;
      socket.write(encodeFrame(pad > 0 ? `${body}|${"x".repeat(pad)}` : body));
    },
    onPing: payload => socket.write(encodeFrame(payload, 0xa)),
    onClose: shutdown,
  });

  socket.on("data", chunk => { try { parser(chunk); } catch (e) { console.error(e.message); shutdown(); } });
  socket.on("error", shutdown);
  socket.on("close", shutdown);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`ECHELON latency probe listening on 0.0.0.0:${PORT}`);
  console.log(`snapshot payload: ${SNAPSHOT_BYTES} B  ·  open / in a browser to test`);
});

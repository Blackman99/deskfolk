import { expect, test } from "bun:test";
import { RfbSniffer } from "./rfb-sniff";

const enc = (s: string) => new TextEncoder().encode(s);
function u16(n: number) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, n); return b; }
function u32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n); return b; }
function i32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, n); return b; }
function cat(...parts: Uint8Array[]) { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }

/** What macOS Screen Sharing sends a VNC client through an ARD sign-in, then its first update. */
function ardSession(width: number, height: number, encoding: number) {
  const keyLength = 128;
  const server = cat(
    enc("RFB 003.889\n"),
    Uint8Array.of(4, 30, 33, 36, 35),
    u16(2), u16(keyLength), new Uint8Array(keyLength).fill(1), new Uint8Array(keyLength).fill(2),
    u32(0),
    u16(width), u16(height), new Uint8Array(16), u32(3), enc("Mac"),
    Uint8Array.of(0, 0), u16(1), u16(0), u16(0), u16(width), u16(height), i32(encoding), new Uint8Array(100),
  );
  const client = cat(enc("RFB 003.008\n"), Uint8Array.of(30));
  return { server, client };
}

test("reads the security types, the chosen one, the framebuffer and the first update's encoding through ARD", () => {
  const { server, client } = ardSession(3456, 2234, 16);
  const sniffer = new RfbSniffer();
  // Arrives in pieces, interleaved the way the two directions really are.
  sniffer.fromServer(server.subarray(0, 12));
  sniffer.fromClient(client.subarray(0, 12));
  sniffer.fromServer(server.subarray(12, 20));
  sniffer.fromClient(client.subarray(12));
  for (let i = 20; i < server.length; i += 37) sniffer.fromServer(server.subarray(i, i + 37));
  expect(sniffer.facts).toEqual({
    securityTypes: [30, 33, 36, 35], chosen: 30, width: 3456, height: 2234, name: "Mac",
    firstMessage: { type: 0, rects: 1, rect: { x: 0, y: 0, width: 3456, height: 2234, encoding: 16 } },
  });
});

test("a refused sign-in and a type it cannot read both stop it", () => {
  const refused = new RfbSniffer();
  refused.fromServer(cat(enc("RFB 003.889\n"), Uint8Array.of(1, 2), new Uint8Array(16), u32(1)));
  refused.fromClient(cat(enc("RFB 003.008\n"), Uint8Array.of(2)));
  expect(refused.facts.failed).toBe("authentication refused");
  const opaque = new RfbSniffer();
  opaque.fromServer(cat(enc("RFB 003.889\n"), Uint8Array.of(1, 33)));
  opaque.fromClient(cat(enc("RFB 003.008\n"), Uint8Array.of(33)));
  expect(opaque.facts.failed).toBe("security type 33 is not read");
});

/**
 * Parser for the receive-pack response (report-status, #606). The broker
 * stores what it finds for logs and assertions only; a response it cannot read
 * (a plain-text 4xx body, for example) parses to null and is never an error.
 *
 * Plain form: pkt-lines `unpack <ok|reason>`, `ok <ref>` / `ng <ref> <reason>`
 * (report-status-v2 adds `option ...` lines, ignored here), then a flush.
 * side-band-64k form: outer pkt-lines whose first payload byte is the band;
 * band 1 carries the inner pkt-line stream (a pkt-line may span two band-1
 * packets), bands 2 and 3 are progress and error text and are skipped.
 */

export interface ReportStatus {
  unpack: string | null;
  refs: Array<{ ref: string; ok: boolean; reason?: string }>;
}

const UTF8 = new TextDecoder("utf-8");
const HEX_LEN = /^[0-9a-f]{4}$/;

/** Split a buffer into pkt-line payloads (null = flush); null if malformed. */
function readPkts(buf: Uint8Array): Array<Uint8Array | null> | null {
  const out: Array<Uint8Array | null> = [];
  let offset = 0;
  while (offset < buf.length) {
    if (buf.length - offset < 4) return null;
    let lenHex = "";
    for (let i = 0; i < 4; i++) {
      lenHex += String.fromCharCode(buf[offset + i] ?? 0);
    }
    lenHex = lenHex.toLowerCase();
    if (!HEX_LEN.test(lenHex)) return null;
    const len = Number.parseInt(lenHex, 16);
    if (len === 0) {
      out.push(null);
      offset += 4;
      continue;
    }
    if (len < 5 || buf.length - offset < len) return null;
    out.push(buf.subarray(offset + 4, offset + len));
    offset += len;
  }
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function parseReportLines(pkts: Array<Uint8Array | null>): ReportStatus | null {
  const report: ReportStatus = { unpack: null, refs: [] };
  for (const pkt of pkts) {
    if (pkt === null) break;
    const line = UTF8.decode(pkt).replace(/\n$/, "");
    if (line.startsWith("unpack ")) {
      report.unpack = line.slice("unpack ".length);
    } else if (line.startsWith("ok ")) {
      report.refs.push({ ref: line.slice(3), ok: true });
    } else if (line.startsWith("ng ")) {
      const rest = line.slice(3);
      const space = rest.indexOf(" ");
      report.refs.push(
        space === -1
          ? { ref: rest, ok: false }
          : {
              ref: rest.slice(0, space),
              ok: false,
              reason: rest.slice(space + 1),
            },
      );
    }
    // `option ...` (report-status-v2) and anything else is ignored.
  }
  return report.unpack === null ? null : report;
}

export function parseReportStatus(body: Uint8Array): ReportStatus | null {
  const outer = readPkts(body);
  const first = outer?.find((pkt) => pkt !== null);
  if (!outer || !first) return null;
  if (first.length >= 1 && first[0] !== undefined && first[0] <= 3) {
    // side-band: collect band 1, skip 2 and 3.
    const data: Uint8Array[] = [];
    for (const pkt of outer) {
      if (pkt === null) break;
      if (pkt[0] === 1) data.push(pkt.subarray(1));
    }
    const inner = readPkts(concat(data));
    return inner ? parseReportLines(inner) : null;
  }
  return parseReportLines(outer);
}

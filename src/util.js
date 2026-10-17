import os from 'node:os';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const PHONE_RE = /^1[3-9]\d{9}$/;

const BOM = String.fromCharCode(0xfeff);
const CRLF = String.fromCharCode(13, 10);

function isInvisible(c) {
  const n = c.charCodeAt(0);
  return n < 0x20 || n === 0x7f || (n >= 0x200b && n <= 0x200f) || n === 0x2028 || n === 0x2029 || n === 0xfeff;
}

/** 去掉控制字符与首尾空白，并限制长度。 */
export function cleanText(value, max) {
  return String(value ?? '')
    .split('').filter((c) => !isInvisible(c)).join('')
    .trim()
    .slice(0, max);
}

export function maskPhone(phone) {
  return phone && phone.length === 11 ? `${phone.slice(0, 3)}****${phone.slice(7)}` : '';
}

export function toInt(value, { min = -Infinity, max = Infinity, name = '参数' } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name}无效`);
  return n;
}

/** 解析简单 Cookie 头，避免额外依赖。 */
export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      out[key] = part.slice(idx + 1).trim();
    }
  }
  return out;
}

/** 局域网地址优先级：常见私网段在前；198.18/15（代理软件虚拟网卡）、169.254（链路本地）排最后。 */
function addressRank(ip) {
  if (/^192\.168\./.test(ip)) return 0;
  if (/^10\./.test(ip)) return 1;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 2;
  if (/^(198\.1[89]|169\.254)\./.test(ip)) return 9;
  return 5;
}

export function lanAddresses() {
  const list = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) list.push({ ifname, address: a.address });
    }
  }
  return list.sort((x, y) => addressRank(x.address) - addressRank(y.address));
}

/** CSV 单元格转义，并防止 Excel 公式注入。 */
export function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header, rows) {
  // 带 BOM，Excel 打开中文不乱码
  return BOM + [header, ...rows].map((r) => r.map(csvCell).join(',')).join(CRLF);
}

/** 解析 CSV（支持引号包裹、逗号/制表符分隔）。 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  const src = String(text).replace(new RegExp('^' + BOM), '');
  const delim = src.split(/\r?\n/, 1)[0].includes('\t') && !src.split(/\r?\n/, 1)[0].includes(',') ? '\t' : ',';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

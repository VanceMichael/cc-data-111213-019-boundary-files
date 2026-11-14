// 编码处理：CPG 声明优先，LDID 仅作辅助提示；未声明时保留原始字节，绝不猜测。
import { TextDecoder } from 'node:util';

// dBASE LDID（表头第 29 字节）到 IANA 标签的常见映射，仅作提示用。
export const LDID_MAP = {
  0x00: null,
  0x01: 'cp437',
  0x02: 'cp850',
  0x03: 'cp1252',
  0x04: 'macintosh',
  0x08: 'cp865',
  0x09: 'cp437',
  0x0a: 'cp850',
  0x0b: 'cp437',
  0x0d: 'cp437',
  0x0e: 'cp850',
  0x0f: 'cp437',
  0x10: 'cp850',
  0x11: 'cp437',
  0x12: 'cp850',
  0x13: 'cp932',
  0x14: 'cp936',
  0x15: 'cp949',
  0x16: 'cp950',
  0x17: 'cp1252',
  0x18: 'cp852',
  0x19: 'cp1250',
  0x1a: 'cp1251',
  0x1c: 'cp1254',
  0x1f: 'cp1257',
  0x22: 'cp737',
  0x23: 'cp775',
  0x24: 'cp852',
  0x25: 'cp857',
  0x26: 'cp863',
  0x37: 'cp866',
  0x40: 'cp852',
  0x4d: 'cp936',
  0x4e: 'cp949',
  0x4f: 'cp950',
  0x57: 'cp932',
  0x59: 'iso-8859-2',
  0x64: 'cp852',
  0x65: 'cp866',
  0xc8: 'cp1250',
  0xc9: 'cp1251',
  0xca: 'cp1254',
  0xcb: 'cp1253',
};

export const CPG_ALIASES = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  '65001': 'utf-8',
  'gbk': 'gbk',
  'gb2312': 'gbk',
  'gb18030': 'gb18030',
  '936': 'gbk',
  'big5': 'big5',
  '950': 'big5',
  'shift-jis': 'shift_jis',
  'sjis': 'shift_jis',
  '932': 'shift_jis',
  'euc-kr': 'euc-kr',
  '949': 'euc-kr',
  'ansi': 'cp1252',
  '1252': 'cp1252',
  'oem': 'cp437',
  '437': 'cp437',
  '850': 'cp850',
  '866': 'cp866',
  '1251': 'cp1251',
  '1250': 'cp1250',
};

// 规范化 CPG 文本为 IANA 标签；无法识别时返回 unknown，由调用方按问题处理。
export function normalizeCpgLabel(cpgText) {
  const trimmed = cpgText.replace(/^﻿/, '').replace(/\0+$/g, '').trim();
  const key = trimmed.toLowerCase();
  if (CPG_ALIASES[key]) return { label: CPG_ALIASES[key], raw: trimmed };
  // 直接交给 TextDecoder 验证一次（如 "ISO-8859-1"、"windows-1252"）。
  try {
    // eslint-disable-next-line no-new
    new TextDecoder(trimmed);
    return { label: trimmed, raw: trimmed };
  } catch {
    return { label: null, raw: trimmed, unrecognized: true };
  }
}

function trimField(raw) {
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0x20 || raw[end - 1] === 0x00)) end -= 1;
  return raw.subarray(0, end);
}

function isAsciiOnly(raw) {
  return raw.every((b) => b === 0 || b <= 0x7f);
}

// 生成给 parseDbf 使用的字段解码回调。
// plan: { declared: boolean, label, ldidHint, ldid }
export function makeFieldDecoder(plan) {
  let decoder = null;
  if (plan.declared && plan.label) {
    decoder = new TextDecoder(plan.label, { fatal: true, ignoreBOM: true });
  }
  return function decodeField(raw, field, recordNumber) {
    const trimmed = trimField(raw);
    if (trimmed.length === 0) return { text: '', null: true, encoding: plan.label ?? null };
    const numeric = ['N', 'F', 'B', 'I', 'Y', 'O', '@'].includes(field.type);
    const logical = field.type === 'L';
    const date = field.type === 'D';
    if (numeric || logical || date) {
      return { text: trimmed.toString('ascii'), encoding: plan.label ?? 'ascii', numeric, logical, date,
        undeclared: !plan.declared };
    }
    // 字符/备忘字段才涉及代码页。
    if (!plan.declared) {
      if (isAsciiOnly(trimmed)) {
        return { text: trimmed.toString('ascii'), encoding: 'ascii', undeclared: true, asciiOnly: true };
      }
      return {
        text: null,
        encoding: null,
        undeclared: true,
        asciiOnly: false,
        issue: { code: 'encoding-undeclared', recordNumber, field: field.name, ldidHint: plan.ldidHint },
        rawHex: trimmed.toString('hex'),
      };
    }
    try {
      const text = decoder.decode(trimmed);
      return { text, encoding: plan.label };
    } catch (error) {
      return {
        text: null,
        encoding: plan.label,
        issue: { code: 'encoding-decode-failed', recordNumber, field: field.name, label: plan.label, message: error.message },
        rawHex: trimmed.toString('hex'),
      };
    }
  };
}

// 汇总编码方案：CPG 优先；缺失时不猜测，LDID 只作为提示暴露。
export function buildEncodingPlan({ cpgBytes = null, ldid = 0 } = {}) {
  const ldidHint = LDID_MAP[ldid] ?? null;
  if (cpgBytes == null) {
    return { declared: false, label: null, ldid, ldidHint, source: 'none' };
  }
  const text = cpgBytes.toString('latin1');
  const normalized = normalizeCpgLabel(text);
  if (normalized.unrecognized) {
    return { declared: true, label: null, ldid, ldidHint, source: 'cpg', cpgRaw: normalized.raw, unrecognized: true };
  }
  return { declared: true, label: normalized.label, ldid, ldidHint, source: 'cpg', cpgRaw: normalized.raw };
}

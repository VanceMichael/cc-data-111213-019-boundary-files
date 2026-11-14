// Shapefile 成套二进制解析：SHP / SHX / DBF。
// 设计原则：
// - 记录号、删除标记、Null Shape、多部件与孔洞、Z/M 与无数据值全部显式保留，不静默丢弃。
// - 解析只报告字节事实，不做编码猜测、不假定坐标参考。
// - 所有几何/属性都带原始字节偏移，供溯源使用。

export const SHP_FILE_CODE = 9994;
export const SHP_VERSION = 1000;
export const SHP_HEADER_LENGTH = 100;
export const DBF_TERMINATOR = 0x1a;

// ESRI 无数据哨兵为 -10^38；部分实现（GDAL）写出 -10^39，按阈值一并识别，原始值另行保留。
export const NO_DATA_THRESHOLD = -1e38;
export const isNoData = (value) => Number.isFinite(value) && value <= NO_DATA_THRESHOLD;

export const SHAPE_TYPES = {
  0: 'NullShape',
  1: 'Point',
  3: 'Polyline',
  5: 'Polygon',
  8: 'MultiPoint',
  11: 'PointZ',
  13: 'PolylineZ',
  15: 'PolygonZ',
  18: 'MultiPointZ',
  21: 'PointM',
  23: 'PolylineM',
  25: 'PolygonM',
  28: 'MultiPointM',
  31: 'MultiPatch',
};

class Cursor {
  constructor(buffer, base = 0, end = buffer.length) {
    this.buffer = buffer;
    this.pos = base;
    this.base = base;
    this.end = end;
    this.issues = [];
  }
  remaining() { return this.end - this.pos; }
  int32LE() { const v = this.buffer.readInt32LE(this.pos); this.pos += 4; return v; }
  doubleLE() { const v = this.buffer.readDoubleLE(this.pos); this.pos += 8; return v; }
  pointXY() { const x = this.doubleLE(); const y = this.doubleLE(); return { x, y }; }
  expectEnd(kind) {
    if (this.pos !== this.end) {
      this.issues.push({ code: 'shape-length-mismatch', kind, expected: this.end - this.base, consumed: this.pos - this.base });
    }
  }
}

function readZMArray(cursor, count, dimension) {
  // 返回 { declaredMin, declaredMax, values: (number|null)[], noDataIndexes: number[], truncated }
  const declaredMin = cursor.doubleLE();
  const declaredMax = cursor.doubleLE();
  const values = [];
  const noDataIndexes = [];
  let truncated = false;
  for (let i = 0; i < count; i += 1) {
    if (cursor.remaining() < 8) {
      cursor.issues.push({ code: `${dimension.toLowerCase()}-section-truncated`, at: i, expected: count });
      truncated = true;
      break;
    }
    const raw = cursor.doubleLE();
    if (isNoData(raw)) { noDataIndexes.push(i); values.push(null); } else values.push(raw);
  }
  return { declaredMin, declaredMax, values, noDataIndexes, truncated };
}

// M 区间可能整体缺席（光标已到记录末尾）；部分缺席按截断问题报告。
function readMSection(cursor, count) {
  if (cursor.remaining() === 0) {
    return { present: false, declaredMin: null, declaredMax: null, values: new Array(count).fill(null), noDataIndexes: [] };
  }
  if (cursor.remaining() < 16) {
    cursor.issues.push({ code: 'm-section-truncated', remaining: cursor.remaining() });
    return { present: true, truncated: true, declaredMin: null, declaredMax: null, values: new Array(count).fill(null), noDataIndexes: [] };
  }
  return { present: true, ...readZMArray(cursor, count, 'M') };
}

function attachZM(shape, z, m) {
  if (z) {
    shape.zRange = { declaredMin: z.declaredMin, declaredMax: z.declaredMax,
      noData: z.noDataIndexes.length > 0, truncated: z.truncated === true };
    shape.noDataZ = z.noDataIndexes;
  }
  shape.mRange = m.present
    ? { present: true, declaredMin: m.declaredMin, declaredMax: m.declaredMax, noData: m.noDataIndexes.length > 0, truncated: m.truncated === true }
    : { present: false };
  shape.noDataM = m.noDataIndexes;
  const points = shape.points ?? [];
  points.forEach((point, index) => {
    if (z) point.z = index < z.values.length ? z.values[index] : null;
    point.m = index < m.values.length ? m.values[index] : null;
  });
}

function readPointLike(cursor, shapeType) {
  const point = cursor.pointXY();
  const shape = { shapeType, typeName: SHAPE_TYPES[shapeType], points: [point] };
  if (shapeType === 11) {
    const z = readZMArray(cursor, 1, 'Z');
    const m = readMSection(cursor, 1);
    attachZM(shape, z, m);
  } else if (shapeType === 21) {
    const m = readMSection(cursor, 1);
    attachZM(shape, null, m);
  }
  return shape;
}

function readMultiPoint(cursor, shapeType) {
  const box = [0, 1, 2, 3].map(() => cursor.doubleLE());
  const numPoints = cursor.int32LE();
  const points = Array.from({ length: numPoints }, () => cursor.pointXY());
  const shape = { shapeType, typeName: SHAPE_TYPES[shapeType], box, points };
  if (shapeType === 18) attachZM(shape, readZMArray(cursor, numPoints, 'Z'), readMSection(cursor, numPoints));
  else if (shapeType === 28) attachZM(shape, null, readMSection(cursor, numPoints));
  return shape;
}

function ringOrientation(ring) {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i += 1) {
    area += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
  }
  // ESRI 约定：外环顺时针（面积为负），孔洞逆时针。
  if (area === 0) return 'degenerate';
  return area < 0 ? 'cw' : 'ccw';
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i].x, yi = ring[i].y, xj = ring[j].x, yj = ring[j].y;
    const intersect = ((yi > point.y) !== (yj > point.y))
      && (point.x < ((xj - xi) * (point.y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function ringContains(outer, inner) {
  // 取内环首点判定；闭合环首点即代表点。
  return pointInRing(inner[0], outer);
}

// 按空间包含关系区分外环/孔洞并分组；方向只作记录与可疑提示，不作为唯一依据。
function classifyRings(rings) {
  const described = rings.map((points, ringIndex) => ({
    ringIndex,
    points,
    pointCount: points.length,
    orientation: ringOrientation(points),
  }));
  const containers = described.map((ring) =>
    described.filter((other) => other.ringIndex !== ring.ringIndex && ringContains(ring.points, other.points)).map((r) => r.ringIndex));
  described.forEach((ring) => {
    const containedIn = described
      .filter((other) => other.ringIndex !== ring.ringIndex && ringContains(other.points, ring.points))
      .map((r) => r.ringIndex);
    if (containedIn.length === 0) {
      ring.role = 'outer';
      ring.orientationMismatch = ring.orientation === 'ccw';
    } else {
      ring.role = 'hole';
      ring.outerRingIndex = containedIn.sort((a, b) => containers[a].length - containers[b].length)[0];
      ring.orientationMismatch = ring.orientation === 'cw';
    }
  });
  const shells = described.filter((r) => r.role === 'outer').map((outer) => ({
    outerRingIndex: outer.ringIndex,
    holeRingIndexes: described.filter((r) => r.role === 'hole' && r.outerRingIndex === outer.ringIndex).map((r) => r.ringIndex),
  }));
  return { rings: described, shells };
}

function readPoly(cursor, shapeType) {
  const box = [0, 1, 2, 3].map(() => cursor.doubleLE());
  const numParts = cursor.int32LE();
  const numPoints = cursor.int32LE();
  const partIndexes = Array.from({ length: numParts }, () => cursor.int32LE());
  const points = Array.from({ length: numPoints }, () => cursor.pointXY());
  const rings = partIndexes.map((start, index) =>
    points.slice(start, index + 1 < numParts ? partIndexes[index + 1] : numPoints));
  const shape = { shapeType, typeName: SHAPE_TYPES[shapeType], box, numParts, numPoints, partIndexes, points };
  if (shapeType === 5 || shapeType === 15 || shapeType === 25) {
    Object.assign(shape, classifyRings(rings));
  } else {
    shape.parts = rings.map((ringPoints, index) => ({ partIndex: index, points: ringPoints }));
  }
  if (shapeType === 13 || shapeType === 15) attachZM(shape, readZMArray(cursor, numPoints, 'Z'), readMSection(cursor, numPoints));
  else if (shapeType === 23 || shapeType === 25) attachZM(shape, null, readMSection(cursor, numPoints));
  return shape;
}

function readShapeContent(buffer, contentOffset, contentLengthWords) {
  const cursor = new Cursor(buffer, contentOffset, contentOffset + contentLengthWords * 2);
  if (cursor.remaining() === 0) {
    return { shape: { shapeType: 0, typeName: 'NullShape', null: true, points: [] }, issues: [] };
  }
  const shapeType = cursor.int32LE();
  const typeName = SHAPE_TYPES[shapeType];
  if (!typeName) {
    return { shape: { shapeType, typeName: 'Unknown', unsupported: true }, issues: [{ code: 'shape-type-unknown', shapeType }] };
  }
  if (shapeType === 31) {
    return { shape: { shapeType, typeName, unsupported: true }, issues: [{ code: 'shape-type-unsupported', shapeType, message: 'MultiPatch 不在本套解析支持范围，避免按普通面误读' }] };
  }
  let shape;
  if (shapeType === 0) {
    shape = { shapeType, typeName, null: true, points: [] };
  } else if (shapeType === 1 || shapeType === 11 || shapeType === 21) {
    shape = readPointLike(cursor, shapeType);
  } else if (shapeType === 8 || shapeType === 18 || shapeType === 28) {
    shape = readMultiPoint(cursor, shapeType);
  } else {
    shape = readPoly(cursor, shapeType);
  }
  cursor.expectEnd(typeName);
  return { shape, issues: cursor.issues };
}

export function parseShp(buffer) {
  const issues = [];
  if (buffer.length < SHP_HEADER_LENGTH) throw new Error('SHP 短于 100 字节文件头');
  if (buffer.readInt32BE(0) !== SHP_FILE_CODE) throw new Error('SHP 文件码不是 9994');
  if (buffer.readInt32LE(28) !== SHP_VERSION) throw new Error('SHP 版本不是 1000');
  const declaredLength = buffer.readInt32BE(24) * 2;
  if (declaredLength !== buffer.length) {
    issues.push({ code: 'shp-length-mismatch', declaredLength, actualLength: buffer.length });
  }
  const header = {
    fileLength: declaredLength,
    shapeType: buffer.readInt32LE(32),
    shapeTypeName: SHAPE_TYPES[buffer.readInt32LE(32)] ?? 'Unknown',
    extent: {
      xmin: buffer.readDoubleLE(36), ymin: buffer.readDoubleLE(44),
      xmax: buffer.readDoubleLE(52), ymax: buffer.readDoubleLE(60),
      zmin: buffer.readDoubleLE(68), zmax: buffer.readDoubleLE(76),
      mmin: buffer.readDoubleLE(84), mmax: buffer.readDoubleLE(92),
    },
  };
  const records = [];
  let offset = SHP_HEADER_LENGTH;
  while (offset < buffer.length) {
    if (buffer.length - offset < 8) {
      issues.push({ code: 'shp-trailing-bytes', byteOffset: offset, remaining: buffer.length - offset });
      break;
    }
    const recordNumber = buffer.readInt32BE(offset);
    const contentLengthWords = buffer.readInt32BE(offset + 4);
    const byteOffset = offset;
    const byteLength = 8 + contentLengthWords * 2;
    if (contentLengthWords < 0 || offset + byteLength > buffer.length) {
      issues.push({ code: 'shp-record-truncated', recordNumber, byteOffset, contentLengthWords });
      break;
    }
    let parsed;
    try {
      parsed = readShapeContent(buffer, offset + 8, contentLengthWords);
    } catch (error) {
      issues.push({ code: 'shp-record-unreadable', recordNumber, byteOffset, message: error.message });
      records.push({ recordNumber, contentLengthWords, byteOffset, byteLength, contentByteOffset: offset + 8,
        shape: { shapeType: null, typeName: 'Unreadable', unreadable: true }, issues: [{ code: 'shp-record-unreadable', message: error.message }] });
      offset += byteLength;
      continue;
    }
    const { shape, issues: shapeIssues } = parsed;
    records.push({ recordNumber, contentLengthWords, byteOffset, byteLength, contentByteOffset: offset + 8, shape, issues: shapeIssues });
    offset += byteLength;
  }
  return { header, records, issues, recordCount: records.length };
}

export function parseShx(buffer) {
  const issues = [];
  if (buffer.length < SHP_HEADER_LENGTH) throw new Error('SHX 短于 100 字节文件头');
  if (buffer.readInt32BE(0) !== SHP_FILE_CODE) throw new Error('SHX 文件码不是 9994');
  const declaredLength = buffer.readInt32BE(24) * 2;
  if (declaredLength !== buffer.length) {
    issues.push({ code: 'shx-length-mismatch', declaredLength, actualLength: buffer.length });
  }
  const header = {
    fileLength: declaredLength,
    shapeType: buffer.readInt32LE(32),
    shapeTypeName: SHAPE_TYPES[buffer.readInt32LE(32)] ?? 'Unknown',
  };
  const entries = [];
  let offset = SHP_HEADER_LENGTH;
  let index = 0;
  while (offset + 8 <= buffer.length) {
    const offsetWords = buffer.readInt32BE(offset);
    const contentLengthWords = buffer.readInt32BE(offset + 4);
    entries.push({ index, recordNumber: index + 1, offsetWords, contentLengthWords,
      byteOffset: offsetWords * 2, byteLength: contentLengthWords * 2, entryByteOffset: offset });
    offset += 8;
    index += 1;
  }
  if (offset !== buffer.length) issues.push({ code: 'shx-trailing-bytes', remaining: buffer.length - offset });
  return { header, entries, issues, entryCount: entries.length };
}

// 逐条核对 SHX 索引与 SHP 实际记录头，返回不一致明细（损坏索引不靠行号糊过去）。
export function verifyShx(shp, shx) {
  const findings = [];
  if (shx.entries.length !== shp.records.length) {
    findings.push({ code: 'shx-count-mismatch', shxEntries: shx.entries.length, shpRecords: shp.records.length });
  }
  const count = Math.min(shx.entries.length, shp.records.length);
  for (let i = 0; i < count; i += 1) {
    const entry = shx.entries[i];
    const record = shp.records[i];
    if (entry.offsetWords * 2 !== record.byteOffset || entry.contentLengthWords !== record.contentLengthWords) {
      findings.push({
        code: 'shx-entry-mismatch', index: i, recordNumber: record.recordNumber,
        shx: { byteOffset: entry.offsetWords * 2, byteLength: entry.contentLengthWords * 2 },
        shp: { byteOffset: record.byteOffset, byteLength: record.contentLengthWords * 2 },
      });
    }
    if (entry.recordNumber !== record.recordNumber) {
      findings.push({ code: 'shx-record-number-mismatch', index: i, shxRecordNumber: entry.recordNumber, shpRecordNumber: record.recordNumber });
    }
  }
  return findings;
}

function decodeDefault(raw) {
  return { text: raw.toString('latin1'), status: 'binary-raw' };
}

// decodeText: 可选回调 (rawBuffer, field, recordNumber) => { text, status, issue? }
export function parseDbf(buffer, decodeText = decodeDefault) {
  if (buffer.length < 32) throw new Error('DBF 短于 32 字节文件头');
  const version = buffer[0];
  const recordCount = buffer.readUInt32LE(4);
  const headerLength = buffer.readUInt16LE(8);
  const recordLength = buffer.readUInt16LE(10);
  const ldid = buffer[29];
  if (headerLength < 33 || recordLength < 1) throw new Error('DBF 文件头长度字段无效');
  const fields = [];
  let descriptorOffset = 32;
  while (descriptorOffset + 32 <= headerLength && buffer[descriptorOffset] !== 0x0d) {
    const raw = buffer.subarray(descriptorOffset, descriptorOffset + 32);
    const nul = raw.indexOf(0);
    const name = raw.subarray(0, nul === -1 ? 11 : nul).toString('ascii');
    const type = String.fromCharCode(raw[11]);
    const length = raw[16];
    const decimalCount = raw[17];
    fields.push({ name, type, length, decimalCount, descriptorByteOffset: descriptorOffset,
      fieldOffset: 1 + fields.reduce((sum, f) => sum + f.length, 0) });
    descriptorOffset += 32;
  }
  const issues = [];
  const fieldSpan = 1 + fields.reduce((sum, f) => sum + f.length, 0);
  if (fieldSpan > recordLength) {
    issues.push({ code: 'dbf-field-span-exceeds-record', fieldSpan, recordLength });
  }
  if (buffer[descriptorOffset] !== 0x0d) issues.push({ code: 'dbf-header-terminator-missing' });
  const expectedLength = headerLength + recordCount * recordLength + 1;
  if (buffer.length < expectedLength) {
    issues.push({ code: 'dbf-truncated', expectedLength, actualLength: buffer.length });
  }
  const terminatorOffset = headerLength + recordCount * recordLength;
  const terminatorOk = buffer[terminatorOffset] === DBF_TERMINATOR;
  if (!terminatorOk) issues.push({ code: 'dbf-terminator-missing', byteOffset: terminatorOffset, found: buffer[terminatorOffset] ?? null });

  const records = [];
  for (let i = 0; i < recordCount; i += 1) {
    const recordByteOffset = headerLength + i * recordLength;
    if (recordByteOffset + recordLength > buffer.length) {
      issues.push({ code: 'dbf-record-out-of-range', recordNumber: i + 1, byteOffset: recordByteOffset });
      break;
    }
    const flag = buffer[recordByteOffset];
    const deleted = flag === 0x2a;
    if (flag !== 0x20 && flag !== 0x2a) issues.push({ code: 'dbf-delete-flag-unknown', recordNumber: i + 1, flag });
    const values = {};
    for (const field of fields) {
      const start = recordByteOffset + field.fieldOffset;
      const raw = buffer.subarray(start, start + field.length);
      const decoded = decodeText(raw, field, i + 1);
      values[field.name] = { ...decoded, byteOffset: start, byteLength: field.length, fieldType: field.type };
    }
    records.push({ recordNumber: i + 1, deleted, deleteFlag: String.fromCharCode(flag),
      byteOffset: recordByteOffset, byteLength: recordLength, values });
  }
  return {
    header: { version, recordCount, headerLength, recordLength, ldid, lastUpdate: [buffer[1], buffer[2], buffer[3]] },
    fields, records, issues, terminatorOk,
  };
}

// 按记录号（而非过滤后的行号）建立几何与属性对应；删除行、Null Shape 都保留。
export function joinRecords(shp, dbf) {
  const findings = [];
  const shpByNumber = new Map(shp.records.map((r) => [r.recordNumber, r]));
  const dbfByNumber = new Map(dbf.records.map((r) => [r.recordNumber, r]));
  const numbers = [...new Set([...shpByNumber.keys(), ...dbfByNumber.keys()])].sort((a, b) => a - b);
  const features = numbers.map((recordNumber) => {
    const shapeRecord = shpByNumber.get(recordNumber);
    const attributeRecord = dbfByNumber.get(recordNumber);
    if (!shapeRecord) findings.push({ code: 'join-shp-missing', recordNumber });
    if (!attributeRecord) findings.push({ code: 'join-dbf-missing', recordNumber });
    return {
      recordNumber,
      deleted: attributeRecord?.deleted ?? null,
      nullShape: shapeRecord ? (shapeRecord.shape?.null === true) : null,
      shape: shapeRecord ?? null,
      attributes: attributeRecord ?? null,
    };
  });
  if (shp.records.length !== dbf.records.length) {
    findings.push({ code: 'record-count-mismatch', shpRecords: shp.records.length, dbfRecords: dbf.records.length });
  }
  return { features, findings };
}

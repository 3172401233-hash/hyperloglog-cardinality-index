import { createHash } from 'node:crypto';

export const TAG_STRING = 0x01;
export const TAG_NUMBER = 0x02;
export const TAG_BIGINT = 0x03;
export const TAG_BOOLEAN = 0x04;
export const TAG_NULL = 0x05;
export const TAG_BYTES = 0x06;

function canonicalEncode(value) {
  if (typeof value === 'string') {
    return Buffer.concat([Buffer.from([TAG_STRING]), Buffer.from(value, 'utf8')]);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('不支持 NaN 或 Infinity，只能哈希有限数值');
    }
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new RangeError(`整数 ${value} 超出安全整数边界，请改用 BigInt 或字符串`);
    }
    return Buffer.concat([
      Buffer.from([TAG_NUMBER]),
      Buffer.from(String(value), 'utf8'),
    ]);
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new RangeError('BigInt 哈希域为无符号整数，拒绝负值');
    }
    return Buffer.concat([
      Buffer.from([TAG_BIGINT]),
      Buffer.from(value.toString(10), 'utf8'),
    ]);
  }
  if (typeof value === 'boolean') {
    return Buffer.from([TAG_BOOLEAN, value ? 1 : 0]);
  }
  if (value === null) {
    return Buffer.from([TAG_NULL]);
  }
  if (value instanceof Uint8Array) {
    return Buffer.concat([Buffer.from([TAG_BYTES]), Buffer.from(value)]);
  }
  throw new TypeError(`不支持的哈希输入类型: ${typeof value}`);
}

function frame(namespace, item) {
  const nsBuf = Buffer.from(namespace, 'utf8');
  const itemBuf = canonicalEncode(item);
  if (nsBuf.length > 0xffffffff || itemBuf.length > 0xffffffff) {
    throw new RangeError('帧长度超出 uint32 边界');
  }
  const frame = Buffer.allocUnsafe(4 + nsBuf.length + 4 + itemBuf.length);
  frame.writeUInt32LE(nsBuf.length, 0);
  nsBuf.copy(frame, 4);
  frame.writeUInt32LE(itemBuf.length, 4 + nsBuf.length);
  itemBuf.copy(frame, 8 + nsBuf.length);
  return frame;
}

/**
 * 带命名空间的稳定 SHA-256 哈希，取摘要前 8 字节作为 uint64。
 * 相同 (namespace, value) 在任意进程、任意机器上结果一致。
 * @param {string} namespace
 * @param {string|number|bigint|boolean|null|Uint8Array} value
 * @returns {bigint} 64 位无符号哈希值
 */
export function stableHash64(namespace, value) {
  if (typeof namespace !== 'string') {
    throw new TypeError('namespace 必须是字符串');
  }
  const digest = createHash('sha256').update(frame(namespace, value)).digest();
  return digest.subarray(0, 8).readBigUInt64LE(0);
}

/**
 * 导出完整 32 字节摘要，便于测试与外部系统做对照。
 */
export function stableHash256(namespace, value) {
  if (typeof namespace !== 'string') {
    throw new TypeError('namespace 必须是字符串');
  }
  return createHash('sha256').update(frame(namespace, value)).digest();
}

export { canonicalEncode };

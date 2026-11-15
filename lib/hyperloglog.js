import { stableHash64 } from './hash.js';

export const FORMAT_MAGIC = Buffer.from('HLL1', 'ascii');
export const FORMAT_VERSION = 1;
export const MIN_PRECISION = 4;
export const MAX_PRECISION = 18;
const TWO_POW_64 = 0x10000000000000000n;

function alpha(m) {
  if (m === 16) return 0.673;
  if (m === 32) return 0.697;
  if (m === 64) return 0.709;
  return 0.7213 / (1 + 1.079 / m);
}

function assertPrecision(precision) {
  if (!Number.isInteger(precision)) {
    throw new TypeError('precision 必须是整数');
  }
  if (precision < MIN_PRECISION || precision > MAX_PRECISION) {
    throw new RangeError(
      `precision 必须在 [${MIN_PRECISION}, ${MAX_PRECISION}] 之间，收到 ${precision}`,
    );
  }
}

function rankFromHash(hash64, precision) {
  const remaining = 64 - precision;
  const index = Number(hash64 >> BigInt(remaining));
  let w = hash64 & ((1n << BigInt(remaining)) - 1n);
  if (w === 0n) {
    return { index, rank: remaining + 1 };
  }
  let rank = 1;
  let bit = BigInt(remaining - 1);
  while (((w >> bit) & 1n) === 0n) {
    rank += 1;
    bit -= 1n;
  }
  return { index, rank };
}

export class HyperLogLog {
  #precision;
  #namespace;
  #registers;

  constructor(precision = 14, namespace = 'default') {
    assertPrecision(precision);
    if (typeof namespace !== 'string' || namespace.length === 0) {
      throw new TypeError('namespace 必须是非空字符串');
    }
    this.#precision = precision;
    this.#namespace = namespace;
    this.#registers = new Uint8Array(1 << precision);
  }

  get precision() {
    return this.#precision;
  }

  get namespace() {
    return this.#namespace;
  }

  get registerCount() {
    return this.#registers.length;
  }

  get size() {
    let count = 0;
    for (const value of this.#registers) {
      if (value !== 0) count += 1;
    }
    return count;
  }

  /** 分区增量更新：登记单个元素，返回是否提高了目标寄存器。 */
  add(value) {
    const hash64 = stableHash64(this.#namespace, value);
    const { index, rank } = rankFromHash(hash64, this.#precision);
    if (rank > 255) {
      throw new RangeError('寄存器秩超出 uint8 边界');
    }
    const previous = this.#registers[index];
    if (rank > previous) {
      this.#registers[index] = rank;
      return true;
    }
    return false;
  }

  addAll(values) {
    let changed = 0;
    for (const value of values) {
      if (this.add(value)) changed += 1;
    }
    return changed;
  }

  /**
   * 返回基数估计与理论误差范围。
   * relativeStandardError = 1.04 / sqrt(m)
   * 95% 置信区间按 1.96 * RSE 计算。
   */
  estimate() {
    const m = this.#registers.length;
    const registers = this.#registers;
    let sum = 0;
    let zeros = 0;
    for (const register of registers) {
      sum += 2 ** -register;
      if (register === 0) zeros += 1;
    }

    let estimate;
    let range;
    if (sum === m) {
      estimate = 0;
      range = 'empty';
    } else {
      const raw = (alpha(m) * m * m) / sum;
      if (raw <= (5 / 2) * m && zeros > 0) {
        estimate = m * Math.log(m / zeros);
        range = 'linear-counting';
      } else if (raw <= (1 / 30) * 2 ** 64) {
        estimate = raw;
        range = 'standard';
      } else {
        estimate = -(2 ** 64) * Math.log(1 - raw / 2 ** 64);
        range = 'large-range';
      }
    }

    const relativeStandardError = 1.04 / Math.sqrt(m);
    const standardError = estimate * relativeStandardError;
    const lower = Math.max(0, estimate - 1.96 * standardError);
    const upper = estimate + 1.96 * standardError;

    return {
      estimate,
      estimateRounded: Math.round(estimate),
      relativeStandardError,
      standardError,
      confidence95: {
        lower,
        upper,
        lowerRounded: Math.round(lower),
        upperRounded: Math.round(upper),
      },
      precision: this.#precision,
      registers: m,
      zeroRegisters: zeros,
      range,
    };
  }

  /** 无损合并：仅允许同版本、同精度、同命名空间的分区。 */
  merge(other) {
    if (!(other instanceof HyperLogLog)) {
      throw new TypeError('merge 只接受 HyperLogLog 实例');
    }
    if (other.#precision !== this.#precision) {
      throw new RangeError(
        `精度不同无法合并: ${this.#precision} vs ${other.#precision}`,
      );
    }
    if (other.#namespace !== this.#namespace) {
      throw new RangeError(
        `命名空间不同无法合并: ${this.#namespace} vs ${other.#namespace}`,
      );
    }
    const otherRegisters = other.#registers;
    const registers = this.#registers;
    for (let i = 0; i < registers.length; i += 1) {
      if (otherRegisters[i] > registers[i]) {
        registers[i] = otherRegisters[i];
      }
    }
    return this;
  }

  /** 多个分区无损合并，不修改任何输入分区。 */
  static mergeAll(sketches) {
    const list = [...sketches];
    if (list.length === 0) {
      throw new RangeError('mergeAll 至少需要一个分区');
    }
    const merged = new HyperLogLog(list[0].#precision, list[0].#namespace);
    for (const sketch of list) {
      merged.merge(sketch);
    }
    return merged;
  }

  /**
   * 二进制布局（小端）：
   * magic(4)="HLL1" | version(1)=1 | precision(1) | maxRank(1) | reserved(1)
   * | namespaceLength(uint32) | namespace(utf8) | registers(m bytes)
   */
  serialize() {
    const ns = Buffer.from(this.#namespace, 'utf8');
    if (ns.length > 0xffffffff) {
      throw new RangeError('namespace 长度超出 uint32 边界');
    }
    const headerLength = 12 + ns.length;
    const buffer = Buffer.allocUnsafe(headerLength + this.#registers.length);
    FORMAT_MAGIC.copy(buffer, 0);
    buffer.writeUInt8(FORMAT_VERSION, 4);
    buffer.writeUInt8(this.#precision, 5);
    buffer.writeUInt8(64 - this.#precision + 1, 6);
    buffer.writeUInt8(0, 7);
    buffer.writeUInt32LE(ns.length, 8);
    ns.copy(buffer, 12);
    buffer.set(this.#registers, headerLength);
    return buffer;
  }

  static deserialize(buffer) {
    if (!(buffer instanceof Uint8Array)) {
      throw new TypeError('序列化数据必须是 Buffer/Uint8Array');
    }
    const input = Buffer.from(buffer);
    if (input.length < 12) {
      throw new RangeError('数据过短，缺少完整头部');
    }
    if (!input.subarray(0, 4).equals(FORMAT_MAGIC)) {
      throw new RangeError('magic 不匹配，数据已损坏或不是 HLL 序列化格式');
    }
    const version = input.readUInt8(4);
    if (version !== FORMAT_VERSION) {
      throw new RangeError(`不支持的序列化版本: ${version}，当前仅支持 ${FORMAT_VERSION}`);
    }
    const precision = input.readUInt8(5);
    if (precision < MIN_PRECISION || precision > MAX_PRECISION) {
      throw new RangeError(`精度超出允许边界 [${MIN_PRECISION}, ${MAX_PRECISION}]: ${precision}`);
    }
    const maxRank = input.readUInt8(6);
    const expectedMaxRank = 64 - precision + 1;
    if (maxRank !== expectedMaxRank) {
      throw new RangeError(
        `maxRank 与精度不一致（损坏）: 收到 ${maxRank}，期望 ${expectedMaxRank}`,
      );
    }
    const namespaceLength = input.readUInt32LE(8);
    const headerLength = 12 + namespaceLength;
    const m = 1 << precision;
    if (input.length !== headerLength + m) {
      throw new RangeError(
        `寄存器长度与精度不匹配（损坏）: 收到 ${input.length - headerLength} 字节，期望 ${m}`,
      );
    }
    const namespace = input.subarray(12, headerLength).toString('utf8');
    if (namespace.length === 0) {
      throw new RangeError('namespace 为空（损坏）');
    }
    const registers = Uint8Array.from(input.subarray(headerLength));
    for (const register of registers) {
      if (register > expectedMaxRank) {
        throw new RangeError(`寄存器秩 ${register} 超出最大秩 ${expectedMaxRank}（损坏或超出 uint8 边界）`);
      }
    }

    const sketch = new HyperLogLog(precision, namespace);
    sketch.#registers.set(registers);
    return sketch;
  }
}

export { rankFromHash, TWO_POW_64 };

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  HyperLogLog,
  stableHash64,
  FORMAT_VERSION,
  MIN_PRECISION,
  MAX_PRECISION,
} from '../index.js';

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'hash-vector.mjs');

function shuffled(items, seed = 1) {
  const out = [...items];
  let state = seed >>> 0;
  const random = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

test('稳定哈希：重复运行、跨进程结果一致且命名空间隔离', () => {
  const a = stableHash64('ns', 'hello');
  const b = stableHash64('ns', 'hello');
  assert.equal(a, b);
  assert.notEqual(stableHash64('other', 'hello'), a);
  assert.ok(a >= 0n && a < 0x10000000000000000n);

  const child = spawnSync(process.execPath, [fixturePath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const vector = JSON.parse(child.stdout);
  assert.equal(vector.hashHello, a.toString());
  assert.equal(vector.hashNumber, stableHash64('ns', 42).toString());
  assert.equal(
    vector.hashBigInt,
    stableHash64('ns', 18446744073709551615n).toString(),
  );
});

test('类型标签消除歧义：字符串、数字、BigInt、布尔、字节互不碰撞', () => {
  const values = [
    stableHash64('ns', '1'),
    stableHash64('ns', 1),
    stableHash64('ns', 1n),
    stableHash64('ns', true),
    stableHash64('ns', new Uint8Array([1])),
    stableHash64('ns', null),
  ];
  assert.equal(new Set(values.map(String)).size, values.length);
});

test('无符号整数边界与非法输入必须拒绝', () => {
  assert.throws(() => stableHash64('ns', -1n), RangeError);
  assert.throws(() => stableHash64('ns', Number.NaN), RangeError);
  assert.throws(() => stableHash64('ns', Number.POSITIVE_INFINITY), RangeError);
  assert.throws(() => stableHash64('ns', 9007199254740992), RangeError);
  assert.throws(() => stableHash64('ns', { id: 1 }), TypeError);
  assert.throws(() => stableHash64('ns', undefined), TypeError);
  assert.throws(() => stableHash64(123, 'x'), TypeError);

  const boundary = new HyperLogLog(12, 'ns');
  assert.doesNotThrow(() => boundary.add(9007199254740991));
  assert.doesNotThrow(() => boundary.add(18446744073709551615n));
});

test('精度参数边界校验', () => {
  assert.throws(() => new HyperLogLog(MIN_PRECISION - 1, 'ns'), RangeError);
  assert.throws(() => new HyperLogLog(MAX_PRECISION + 1, 'ns'), RangeError);
  assert.throws(() => new HyperLogLog(12.5, 'ns'), TypeError);
  assert.throws(() => new HyperLogLog(12, ''), TypeError);
  for (let p = MIN_PRECISION; p <= MAX_PRECISION; p += 1) {
    const sketch = new HyperLogLog(p, 'ns');
    assert.equal(sketch.registerCount, 1 << p);
    assert.equal(sketch.precision, p);
  }
});

test('空分区：估计为 0，误差模型正确', () => {
  const sketch = new HyperLogLog(12, 'ns');
  const result = sketch.estimate();
  assert.equal(result.estimate, 0);
  assert.equal(result.estimateRounded, 0);
  assert.equal(result.range, 'empty');
  assert.equal(result.zeroRegisters, 1 << 12);
  assert.equal(result.precision, 12);
  assert.ok(Math.abs(result.relativeStandardError - 1.04 / Math.sqrt(1 << 12)) < 1e-15);
});

test('小规模精确计数对照：1/2/5/10/50 个元素', () => {
  for (const n of [1, 2, 5, 10, 50]) {
    const sketch = new HyperLogLog(14, 'small');
    for (let i = 0; i < n; i += 1) sketch.add(`user-${i}`);
    const result = sketch.estimate();
    const tolerance = n <= 2 ? 1 : Math.max(2, n * 0.1);
    assert.ok(
      Math.abs(result.estimateRounded - n) <= tolerance,
      `n=${n} 估计=${result.estimateRounded}`,
    );
    assert.ok(
      result.confidence95.lowerRounded <= n && n <= result.confidence95.upperRounded + 1,
      `n=${n} 不在 95% 区间内`,
    );
    assert.equal(result.range, 'linear-counting');
  }
});

test('插入顺序不影响结果，序列化字节完全一致', () => {
  const items = Array.from({ length: 3000 }, (_, i) => `dev-${i}`);
  const a = new HyperLogLog(12, 'order');
  const b = new HyperLogLog(12, 'order');
  a.addAll(items);
  b.addAll(shuffled(items, 7));
  assert.deepEqual(a.serialize(), b.serialize());
  assert.equal(a.estimate().estimateRounded, b.estimate().estimateRounded);
});

test('大量重复值：单一值重复十万次仍估计为 1', () => {
  const sketch = new HyperLogLog(12, 'dup');
  for (let i = 0; i < 100_000; i += 1) sketch.add('same-device-id');
  const result = sketch.estimate();
  assert.equal(result.estimateRounded, 1);
  assert.equal(sketch.size, 1);
});

test('高偏斜输入：少量真实设备 + 超级热点重复', () => {
  const sketch = new HyperLogLog(14, 'skew');
  for (let i = 0; i < 1000; i += 1) sketch.add(`dev-${i}`);
  for (let i = 0; i < 200_000; i += 1) sketch.add('hot-dev');
  const result = sketch.estimate();
  assert.ok(Math.abs(result.estimateRounded - 1000) / 1000 < 0.05);
});

test('分区增量更新与无损合并：等价于单分区全量计算', () => {
  const items = Array.from({ length: 20_000 }, (_, i) => `uid-${i}`);
  const monolithic = new HyperLogLog(13, 'shards');
  monolithic.addAll(items);

  const ordered = shuffled(items, 99);
  const partitions = [
    new HyperLogLog(13, 'shards'),
    new HyperLogLog(13, 'shards'),
    new HyperLogLog(13, 'shards'),
  ];
  ordered.forEach((item, index) => partitions[index % 3].add(item));

  const merged = HyperLogLog.mergeAll(partitions);
  assert.deepEqual(merged.serialize(), monolithic.serialize());

  const chained = partitions[0].merge(partitions[1]).merge(partitions[2]);
  assert.deepEqual(chained.serialize(), monolithic.serialize());

  const reversed = HyperLogLog.mergeAll([...partitions].reverse());
  assert.deepEqual(reversed.serialize(), monolithic.serialize());
});

test('空分区参与合并不改变结果', () => {
  const full = new HyperLogLog(12, 'empty-merge');
  full.addAll(Array.from({ length: 500 }, (_, i) => `x-${i}`));
  const empty = new HyperLogLog(12, 'empty-merge');
  const merged = HyperLogLog.mergeAll([empty, full, new HyperLogLog(12, 'empty-merge')]);
  assert.deepEqual(merged.serialize(), full.serialize());
});

test('合并拒绝精度不同与命名空间不同的分区', () => {
  const p12 = new HyperLogLog(12, 'ns');
  const p13 = new HyperLogLog(13, 'ns');
  const other = new HyperLogLog(12, 'other');
  assert.throws(() => p12.merge(p13), /精度不同/);
  assert.throws(() => p12.merge(other), /命名空间不同/);
  assert.throws(() => HyperLogLog.mergeAll([]), /至少需要一个/);
  assert.throws(() => p12.merge({}), TypeError);
});

test('序列化往返：字节确定、跨进程一致', () => {
  const sketch = new HyperLogLog(12, 'fixture');
  sketch.addAll(Array.from({ length: 500 }, (_, i) => `item-${i}`));
  const bytes = sketch.serialize();
  assert.ok(Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'HLL1');
  assert.equal(bytes.readUInt8(4), FORMAT_VERSION);

  const restored = HyperLogLog.deserialize(bytes);
  assert.deepEqual(restored.serialize(), bytes);
  assert.equal(restored.precision, 12);
  assert.equal(restored.namespace, 'fixture');
  assert.deepEqual(restored.estimate(), sketch.estimate());

  const child = spawnSync(process.execPath, [fixturePath], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const vector = JSON.parse(child.stdout);
  assert.equal(vector.sketch, Buffer.from(bytes).toString('hex'));
  assert.equal(vector.estimate, sketch.estimate().estimateRounded);
});

function corrupt(mutator) {
  const sketch = new HyperLogLog(10, 'corrupt');
  sketch.addAll(['a', 'b', 'c']);
  const bytes = Buffer.from(sketch.serialize());
  mutator(bytes);
  return () => HyperLogLog.deserialize(bytes);
}

test('反序列化拒绝损坏与越界数据', () => {
  assert.throws(corrupt((b) => b.writeUInt8(0x58, 0)), /magic/);
  assert.throws(corrupt((b) => b.writeUInt8(99, 4)), /版本/);
  assert.throws(corrupt((b) => b.writeUInt8(20, 5)), /精度/);
  assert.throws(corrupt((b) => b.writeUInt8(7, 6)), /maxRank/);
  assert.throws(
    corrupt((b) => {
      const registerOffset = b.length - (1 << 10);
      b.writeUInt8(255, registerOffset);
    }),
    /寄存器秩/,
  );
  assert.throws(corrupt((b) => b.writeUInt32LE(b.readUInt32LE(8) + 1, 8)), /寄存器长度/);
  assert.throws(() => HyperLogLog.deserialize(Buffer.alloc(6)), /过短/);
  assert.throws(() => HyperLogLog.deserialize('not-a-buffer'), TypeError);
});

test('全精度档位序列化往返', () => {
  for (let p = MIN_PRECISION; p <= MAX_PRECISION; p += 1) {
    const sketch = new HyperLogLog(p, `p-${p}`);
    sketch.addAll(['a', 'b', 'c', 'd']);
    const restored = HyperLogLog.deserialize(sketch.serialize());
    assert.equal(restored.precision, p);
    assert.deepEqual(restored.serialize(), sketch.serialize());
  }
});

test('十万级基数估计误差小于 5%，并附带误差范围与当前精度', () => {
  const n = 100_000;
  const sketch = new HyperLogLog(14, 'scale');
  for (let i = 0; i < n; i += 1) sketch.add(`device-${i}`);
  const result = sketch.estimate();
  const relativeError = Math.abs(result.estimateRounded - n) / n;
  assert.ok(relativeError < 0.05, `相对误差 ${relativeError}`);
  assert.equal(result.precision, 14);
  assert.equal(result.range, 'standard');
  assert.ok(
    result.confidence95.lowerRounded <= n && n <= result.confidence95.upperRounded,
    '真实值应落入 95% 置信区间',
  );
  assert.ok(Math.abs(result.relativeStandardError - 1.04 / Math.sqrt(1 << 14)) < 1e-15);
});

test('估计结果确定性：重复构造与重复运行完全一致', () => {
  const build = () => {
    const sketch = new HyperLogLog(12, 'det');
    sketch.addAll(shuffled(Array.from({ length: 2000 }, (_, i) => `k-${i}`), 3));
    return sketch;
  };
  const first = build();
  const second = build();
  assert.deepEqual(first.serialize(), second.serialize());
  assert.deepEqual(first.estimate(), second.estimate());
});

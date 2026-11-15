# hyperloglog-cardinality-index

确定性的 HyperLogLog 基数索引，用于统计每天不同设备（UV）这类场景：不需要精确 `Set`，
各分区可以独立增量更新、二进制落盘，再无损合并出全局基数。结果在任意机器、任意进程、
任意插入/合并顺序下完全一致，并返回理论误差范围与当前精度。

## 快速开始

```js
import { HyperLogLog } from './index.js';

const sketch = new HyperLogLog(14, 'daily-uv:2026-11-15');
for (const deviceId of deviceIds) sketch.add(deviceId);

const r = sketch.estimate();
// r.estimateRounded            估计 UV（整数）
// r.relativeStandardError      理论相对标准误差 1.04/sqrt(m)
// r.confidence95               95% 置信区间 [lower, upper]
// r.precision / r.range        当前精度与使用的修正区间
```

分区合并：

```js
const shardA = new HyperLogLog(14, 'daily-uv');
const shardB = new HyperLogLog(14, 'daily-uv');
shardA.addAll(eventsFromPartitionA);
shardB.addAll(eventsFromPartitionB);

// 方式一：原地合并；方式二：纯函数合并，不修改输入分区
const merged = HyperLogLog.mergeAll([shardA, shardB]);
const bytes = merged.serialize();          // 落盘 / 跨服务传输
const restored = HyperLogLog.deserialize(bytes);
```

## 哈希算法

- 哈希函数为 **SHA-256**（Node 内置 `crypto`），取摘要前 **8 字节（64 位，小端读取）**
  作为 HLL 输入，相比 32 位哈希显著降低碰撞概率并支持大范围修正。
- 登记项先做**带命名空间的稳定哈希**：输入帧为
  `uint32LE(namespaceLength) | namespace(utf8) | uint32LE(itemLength) | canonicalItem`。
  命名空间不同的两个索引即使登记相同值也互不干扰，合并时会强制校验命名空间一致。
- `canonicalItem` 带单字节类型标签，消除类型歧义：
  - `0x01` 字符串（UTF-8）、`0x02` 数字（`String(value)` 规范文本）
  - `0x03` BigInt（十进制文本，仅接受非负值）、`0x04` 布尔、`0x05` null、`0x06` 字节数组
- 长度前缀保证拼接无歧义；哈希只依赖输入字节，因此**跨进程、跨机器、跨运行结果逐位相同**。
  `lib/hash.js` 同时导出 `stableHash64` 与完整 32 字节的 `stableHash256` 便于外部对照。

## 寄存器与精度

- 精度参数 `precision`（记为 `p`）范围 **[4, 18]**，寄存器数 `m = 2^p`（16 ~ 262144 个
  uint8 寄存器）。哈希高 `p` 位选桶，剩余 `64-p` 位计算前导 1 位秩（rank ∈ [1, 65-p]），
  寄存器取各元素秩的最大值。
- 支持的登记类型：字符串、有限 `number`、非负 `bigint`、`boolean`、`null`、`Uint8Array`。
  拒绝 `NaN/Infinity`、超出 `Number.MAX_SAFE_INTEGER` 的 number 整数、负 BigInt 及其他类型；
  反序列化时任何秩超过 `65-p` 的寄存器都按损坏数据拒绝。

## 估计与误差模型

`estimate()` 返回原始估计、取整估计、相对标准误差、绝对标准误差、95% 置信区间和当前精度：

- 标准误差（理论 RSE）：`σ = 1.04 / sqrt(m)`。例如 `p=14`（m=16384）时
  `σ ≈ 0.8125%`，`p=12` 时约 `1.625%`，`p=10` 时约 `3.25%`。
- 95% 置信区间按正态近似 `estimate ± 1.96·σ·estimate` 给出，下界截断到 0。
- 估计分三段并在 `range` 字段标明：
  - `empty`：所有寄存器为 0，估计为 0；
  - `linear-counting`：`E ≤ 2.5m` 且存在空桶时，用 `m·ln(m/zeroRegisters)` 修正，
    小基数（含极小集合）下几乎精确；
  - `standard`：标准 HLL 调和平均 `E = α(m)·m² / Σ2^(-Rⱼ)`，
    `α(16)=0.673`、`α(32)=0.697`、`α(64)=0.709`，其余 `0.7213/(1+1.079/m)`；
  - `large-range`：`E > 2^64/30` 时做 64 位大范围修正 `−2^64·ln(1−E/2^64)`。

## 二进制序列化

布局（小端）：

```
magic(4)="HLL1" | version(1)=1 | precision(1) | maxRank(1) | reserved(1)
| namespaceLength(uint32LE) | namespace(utf8) | registers(m 字节 uint8)
```

`deserialize()` 会逐项校验：magic、版本（不兼容直接拒绝）、精度边界、`maxRank` 与精度
一致性、命名空间长度、寄存器总长度、每个寄存器是否超出最大秩。任何损坏或越界都会抛错，
不会静默产出错误估计。

## 合并语义

- 合并按寄存器逐桶取最大值，是**无损**操作：先分区更新再合并，与单分区全量登记产生
  完全相同的寄存器与序列化字节（测试中做字节级断言）。
- 仅允许**同版本、同精度、同命名空间**的分区合并，否则抛 `RangeError`；空分区参与合并
  不改变结果。合并满足交换律与结合律，合并顺序不影响最终结果。

## API

| 成员 | 说明 |
| --- | --- |
| `new HyperLogLog(precision?, namespace?)` | 精度默认 14，命名空间默认 `default` |
| `add(value)` / `addAll(values)` | 登记元素，支持分区增量更新 |
| `estimate()` | 返回估计值、95% 区间、RSE、精度与修正区间 |
| `merge(other)` / `static mergeAll(sketches)` | 原地 / 纯函数无损合并 |
| `serialize()` / `static deserialize(buf)` | 确定性二进制往返 |
| `precision` / `namespace` / `registerCount` / `size` | 元信息（`size` 为非空寄存器数） |
| `stableHash64(namespace, value)` | 导出的稳定 64 位哈希 |

## 测试

```bash
node --test
```

覆盖：跨进程哈希向量对照、不同插入/合并顺序的字节级确定性、重复值与高偏斜输入、
空分区、小规模精确计数对照、10 万级误差与 95% 区间、精度/命名空间/版本/损坏寄存器/
uint 边界拒绝，以及全精度档位（p=4..18）的序列化往返。

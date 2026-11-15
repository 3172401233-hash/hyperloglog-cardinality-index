import { stableHash64, HyperLogLog } from '../../index.js';

const sketch = new HyperLogLog(12, 'fixture');
for (let i = 0; i < 500; i += 1) {
  sketch.add(`item-${i}`);
}

process.stdout.write(
  JSON.stringify({
    hashHello: stableHash64('ns', 'hello').toString(),
    hashNumber: stableHash64('ns', 42).toString(),
    hashBigInt: stableHash64('ns', 18446744073709551615n).toString(),
    sketch: sketch.serialize().toString('hex'),
    estimate: sketch.estimate().estimateRounded,
  }),
);

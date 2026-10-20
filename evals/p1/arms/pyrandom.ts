/**
 * Python-compatible `random.Random(seed).sample(population, k)` (CPython 3.11).
 *
 * The P1 contract (evals/p1/ARMS.md section 4) draws the F subset with
 * `random.Random(20261013)`. This is a faithful port of CPython's MT19937 seeding
 * (init_by_array over the 32-bit chunks of the integer seed), getrandbits,
 * _randbelow_with_getrandbits and sample, so the draw is the one Python would make.
 * test/similarity.test.ts checks it against values produced by Python.
 */

const N = 624;
const M = 397;
const MATRIX_A = 0x9908b0df;
const UPPER_MASK = 0x80000000;
const LOWER_MASK = 0x7fffffff;

export class PyRandom {
  private readonly mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) throw new RangeError("seed must be a safe integer");
    let n = Math.abs(seed);
    const key: number[] = [];
    while (n > 0) {
      key.push(n % 0x100000000);
      n = Math.floor(n / 0x100000000);
    }
    if (key.length === 0) key.push(0);
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) {
      const prev = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (Math.imul(1812433253, prev) + i) >>> 0;
    }
    this.mti = N;
  }

  private initByArray(key: readonly number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1;
    let j = 0;
    for (let k = Math.max(N, key.length); k > 0; k--) {
      const prev = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (((mt[i] as number) ^ Math.imul(prev, 1664525)) + (key[j] as number) + j) >>> 0;
      i++;
      j++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k > 0; k--) {
      const prev = (mt[i - 1] as number) ^ ((mt[i - 1] as number) >>> 30);
      mt[i] = (((mt[i] as number) ^ Math.imul(prev, 1566083941)) - i) >>> 0;
      i++;
      if (i >= N) {
        mt[0] = mt[N - 1] as number;
        i = 1;
      }
    }
    mt[0] = 0x80000000;
  }

  /** genrand_uint32 */
  nextUint32(): number {
    const mt = this.mt;
    if (this.mti >= N) {
      let kk = 0;
      const mag = (y: number): number => (y & 1 ? MATRIX_A : 0);
      for (; kk < N - M; kk++) {
        const y = ((mt[kk] as number) & UPPER_MASK) | ((mt[kk + 1] as number) & LOWER_MASK);
        mt[kk] = (mt[kk + M] as number) ^ (y >>> 1) ^ mag(y);
      }
      for (; kk < N - 1; kk++) {
        const y = ((mt[kk] as number) & UPPER_MASK) | ((mt[kk + 1] as number) & LOWER_MASK);
        mt[kk] = (mt[kk + (M - N)] as number) ^ (y >>> 1) ^ mag(y);
      }
      const y = ((mt[N - 1] as number) & UPPER_MASK) | ((mt[0] as number) & LOWER_MASK);
      mt[N - 1] = (mt[M - 1] as number) ^ (y >>> 1) ^ mag(y);
      this.mti = 0;
    }
    let y = mt[this.mti++] as number;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** random.getrandbits(k) for 1 <= k <= 32. */
  getrandbits(k: number): number {
    if (!Number.isInteger(k) || k < 1 || k > 32) throw new RangeError("getrandbits supports 1..32 bits here");
    return this.nextUint32() >>> (32 - k);
  }

  /** random._randbelow_with_getrandbits(n), n >= 1. */
  randbelow(n: number): number {
    if (!Number.isInteger(n) || n < 1 || n > 0xffffffff) throw new RangeError("randbelow needs 1 <= n < 2**32");
    const k = n.toString(2).length; // int.bit_length()
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  /** random.sample(population, k), in selection order. */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!Number.isInteger(k) || k < 0 || k > n) throw new RangeError("Sample larger than population or is negative");
    const result: T[] = new Array<T>(k);
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i++) {
        const j = this.randbelow(n - i);
        result[i] = pool[j] as T;
        pool[j] = pool[n - i - 1] as T;
      }
    } else {
      const selected = new Set<number>();
      for (let i = 0; i < k; i++) {
        let j = this.randbelow(n);
        while (selected.has(j)) j = this.randbelow(n);
        selected.add(j);
        result[i] = population[j] as T;
      }
    }
    return result;
  }
}

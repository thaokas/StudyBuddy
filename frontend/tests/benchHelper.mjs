/**
 * Minimal benchmark helper for Node.js test runner.
 */
const results = [];
let currentGroup = 'default';

export function group(name, fn) {
  currentGroup = name;
  fn();
}

export function bench(name, fn, iterations = 1000) {
  // Warmup
  for (let i = 0; i < Math.min(100, iterations / 10); i++) fn();

  const times = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);

  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p99Idx = Math.floor(times.length * 0.99);
  const opsPerSec = (1000 / avg).toFixed(0);

  results.push({
    group: currentGroup,
    name,
    iterations,
    avg_ms: avg.toFixed(4),
    min_ms: times[0].toFixed(4),
    max_ms: times[times.length - 1].toFixed(4),
    p99_ms: times[p99Idx].toFixed(4),
    ops_per_sec: opsPerSec,
  });

  console.log(`  ${name.padEnd(45)} avg=${avg.toFixed(4)}ms  ops/sec=${opsPerSec}  (${iterations} iters)`);
}

export function summary() {
  console.log('\nPERFORMANCE SUMMARY');
  console.log('='.repeat(80));

  let currentGroup = '';
  for (const r of results) {
    if (r.group !== currentGroup) {
      currentGroup = r.group;
      console.log(`\n[${currentGroup}]`);
    }
    const rating = getRating(r.avg_ms);
    console.log(`  ${rating} ${r.name.padEnd(42)} ${r.avg_ms.padEnd(10)}ms  ${r.ops_per_sec.padStart(8)} ops/s  (p99: ${r.p99_ms}ms)`);
  }

  // Summary stats
  const allAvg = results.map(r => parseFloat(r.avg_ms));
  const fastest = results.reduce((a, b) => parseFloat(a.avg_ms) < parseFloat(b.avg_ms) ? a : b);
  const slowest = results.reduce((a, b) => parseFloat(a.avg_ms) > parseFloat(b.avg_ms) ? a : b);

  console.log('\n[OVERALL]');
  console.log(`  Fastest: ${fastest.name} (${fastest.avg_ms}ms, ${fastest.ops_per_sec} ops/s)`);
  console.log(`  Slowest: ${slowest.name} (${slowest.avg_ms}ms, ${slowest.ops_per_sec} ops/s)`);
}

function getRating(avgMs) {
  const ms = parseFloat(avgMs);
  if (ms < 0.001) return '🟢';
  if (ms < 0.01) return '🟢';
  if (ms < 0.1) return '🟡';
  if (ms < 1.0) return '🟠';
  return '🔴';
}

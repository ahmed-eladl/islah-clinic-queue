// tests/e2e_runner.js
// Master E2E Test Suite Runner for Live Clinic Queue Tracker
// Executes all test tiers (Tiers 1-4) and prints a comprehensive summary report.

const { spawn } = require('node:child_process');
const path = require('node:path');

const TIERS = [
  {
    name: 'Tier 1: Feature Coverage (F01 - F24)',
    file: 'tests/tier1_feature_tests.test.js',
    description: '≥5 tests per feature across all 24 inventory features'
  },
  {
    name: 'Tier 2: Boundary & Edge Cases',
    file: 'tests/tier2_boundary_tests.test.js',
    description: 'Bounds, clamping at 0, large tickets, rapid taps, malformed tokens'
  },
  {
    name: 'Tier 3: Multi-Clinic Isolation & Security',
    file: 'tests/tier3_isolation_tests.test.js',
    description: 'Cross-clinic authorization rejection, isolated SSE channels, tamper resistance'
  },
  {
    name: 'Tier 4: Real-World Clinical Workloads',
    file: 'tests/tier4_workload_tests.test.js',
    description: 'Morning rush (100 patients), concurrent cross-traffic, crash recovery, patient journey, adversarial flood'
  }
];

function runTestTier(tier) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const filePath = path.resolve(__dirname, '..', tier.file);
    const child = spawn(process.execPath, ['--test', filePath], {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });

    child.on('close', (code) => {
      const durationMs = Date.now() - startTime;
      let totalTests = 0;
      let passed = 0;
      let failed = 0;

      // Extract TAP or Node test counts
      const testsMatch = stdout.match(/# tests (\d+)/);
      const passMatch = stdout.match(/# pass (\d+)/);
      const failMatch = stdout.match(/# fail (\d+)/);

      if (testsMatch) totalTests = parseInt(testsMatch[1], 10);
      if (passMatch) passed = parseInt(passMatch[1], 10);
      if (failMatch) failed = parseInt(failMatch[1], 10);

      resolve({
        tier: tier.name,
        file: tier.file,
        code,
        durationMs,
        totalTests,
        passed,
        failed: failed || (code !== 0 ? 1 : 0),
        stdout,
        stderr
      });
    });
  });
}

async function main() {
  console.log('='.repeat(80));
  console.log('  LIVE CLINIC QUEUE TRACKER — END-TO-END VERIFICATION HARNESS');
  console.log('='.repeat(80));
  console.log(`Node.js Version: ${process.version}`);
  console.log(`Execution Mode : Native Node.js Test Runner (node --test)`);
  console.log(`Timestamp      : ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  console.log('');

  const results = [];
  let grandTotal = 0;
  let grandPassed = 0;
  let grandFailed = 0;
  const overallStart = Date.now();

  for (const tier of TIERS) {
    process.stdout.write(`Executing ${tier.name}... `);
    const res = await runTestTier(tier);
    results.push(res);
    grandTotal += res.totalTests;
    grandPassed += res.passed;
    grandFailed += res.failed;

    if (res.code === 0 && res.failed === 0) {
      console.log(`PASSED (${res.passed}/${res.totalTests} tests in ${res.durationMs}ms)`);
    } else {
      console.log(`FAILED (${res.failed} failures in ${res.durationMs}ms)`);
      if (res.stderr) console.error(res.stderr);
    }
  }

  const overallDuration = Date.now() - overallStart;

  console.log('');
  console.log('='.repeat(80));
  console.log('  E2E TEST EXECUTION SUMMARY');
  console.log('='.repeat(80));
  console.log(
    'Tier'.padEnd(45) +
    'Tests'.padStart(8) +
    'Pass'.padStart(8) +
    'Fail'.padStart(8) +
    'Time (ms)'.padStart(11)
  );
  console.log('-'.repeat(80));

  for (const r of results) {
    console.log(
      r.tier.padEnd(45) +
      String(r.totalTests).padStart(8) +
      String(r.passed).padStart(8) +
      String(r.failed).padStart(8) +
      String(r.durationMs).padStart(11)
    );
  }

  console.log('-'.repeat(80));
  console.log(
    'TOTAL'.padEnd(45) +
    String(grandTotal).padStart(8) +
    String(grandPassed).padStart(8) +
    String(grandFailed).padStart(8) +
    String(overallDuration).padStart(11)
  );
  console.log('='.repeat(80));

  if (grandFailed === 0) {
    console.log('\n>>> VERDICT: ALL E2E TIERS PASSED SUCCESSFULLY (100% GREEN) <<<\n');
    process.exit(0);
  } else {
    console.error(`\n>>> VERDICT: FAILED (${grandFailed} test failure(s) detected) <<<\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal test runner error:', err);
    process.exit(1);
  });
}

module.exports = { runTestTier, TIERS };

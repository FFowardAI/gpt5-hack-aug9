const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

/**
 * Real-time Maestro test runner
 * Monitors test execution every 1 second and returns complete results
 */
async function runMaestro(yamlFilePath, options = {}) {
  const {
    maestroBin = 'maestro',
    workspace = process.cwd(),
    pollInterval = 1000, // 1 second
    timeout = 60000 // 60 seconds max
  } = options;

  return new Promise((resolve, reject) => {
    console.log(`🚀 Starting Maestro test: ${yamlFilePath}`);
    
    if (!fs.existsSync(yamlFilePath)) {
      return reject(new Error(`Test file not found: ${yamlFilePath}`));
    }

    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    let isComplete = false;
    let lastStatus = { passed: 0, failed: 0, skipped: 0 };

    // Start Maestro process
    const child = spawn(maestroBin, ['test', yamlFilePath], {
      cwd: workspace,
      shell: true,
      env: process.env,
    });

    // Capture output
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Monitor progress every second
    const progressMonitor = setInterval(() => {
      if (isComplete) {
        clearInterval(progressMonitor);
        return;
      }

      const currentStatus = parseRealTimeStatus(stdout, stderr);
      
      // Only log if status changed
      if (JSON.stringify(currentStatus) !== JSON.stringify(lastStatus)) {
        console.log(`📊 Progress: ✅${currentStatus.passed} ❌${currentStatus.failed} 🔲${currentStatus.skipped} | Flow: ${currentStatus.flowName}`);
        lastStatus = currentStatus;
      }

      // Check for timeout
      if (Date.now() - startTime > timeout) {
        console.log('⏰ Test timed out');
        child.kill('SIGTERM');
        clearInterval(progressMonitor);
        resolve({
          success: false,
          error: 'Test timed out',
          duration: Date.now() - startTime,
          stdout,
          stderr,
          ...currentStatus
        });
      }
    }, pollInterval);

    // Handle completion
    child.on('close', (code) => {
      isComplete = true;
      clearInterval(progressMonitor);
      
      const duration = Date.now() - startTime;
      const finalStatus = parseFinalStatus(stdout, stderr, code);
      
      console.log(`🏁 Test completed in ${duration}ms`);
      console.log(`📋 Final result: ${finalStatus.success ? '✅ PASSED' : '❌ FAILED'}`);
      console.log(`📊 Steps: ✅${finalStatus.passed} ❌${finalStatus.failed} 🔲${finalStatus.skipped}`);
      
      if (!finalStatus.success && finalStatus.errorMessage) {
        console.log(`🚨 Error: ${finalStatus.errorMessage}`);
      }

      resolve({
        ...finalStatus,
        duration,
        stdout,
        stderr
      });
    });

    child.on('error', (error) => {
      isComplete = true;
      clearInterval(progressMonitor);
      console.error(`💥 Failed to start Maestro: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Parse real-time status from ongoing output
 */
function parseRealTimeStatus(stdout, stderr) {
  const output = stdout + stderr;
  
  // Parse flow name
  let flowName = 'Unknown';
  const flowMatch = output.match(/> Flow[:\s]+(.+)/i);
  if (flowMatch) {
    flowName = flowMatch[1].trim();
  }

  // Count completed steps from real-time output
  const completedSteps = (output.match(/COMPLETED/g) || []).length;
  const failedSteps = (output.match(/FAILED/g) || []).length;
  
  return {
    flowName,
    passed: completedSteps,
    failed: failedSteps,
    skipped: 0, // Can't determine skipped in real-time
    isRunning: true
  };
}

/**
 * Parse final status when test completes
 */
function parseFinalStatus(stdout, stderr, exitCode) {
  const output = stdout + stderr;
  const success = exitCode === 0;
  
  // Parse flow name
  let flowName = 'Unknown';
  const flowMatch = output.match(/> Flow[:\s]+(.+)/i);
  if (flowMatch) {
    flowName = flowMatch[1].trim();
  }

  let passed = 0, failed = 0, skipped = 0;

  // Try to get counts from formatted summary first (most accurate)
  const flowSectionMatch = output.match(/║[\s\S]*?║/);
  if (flowSectionMatch) {
    const flowSection = flowSectionMatch[0];
    passed = (flowSection.match(/✅/g) || []).length;
    failed = (flowSection.match(/❌/g) || []).length;
    skipped = (flowSection.match(/🔲/g) || []).length;
  } else {
    // Fallback: count from execution logs
    passed = (output.match(/COMPLETED/g) || []).length;
    failed = (output.match(/FAILED/g) || []).length;
  }

  // Extract error message
  let errorMessage = '';
  if (!success) {
    const lines = output.split('\n');
    const errorStartIndex = lines.findIndex(line => 
      line.includes('Element not found') || 
      line.includes('FAILED') ||
      line.includes('not found')
    );
    
    if (errorStartIndex >= 0) {
      const errorLines = lines.slice(errorStartIndex, errorStartIndex + 3)
        .filter(line => line.trim() && !line.includes('===='))
        .map(line => line.trim());
      errorMessage = errorLines.join(' ').trim();
    }
  }

  return {
    success,
    flowName,
    passed,
    failed,
    skipped,
    errorMessage,
    exitCode,
    isRunning: false
  };
}

// Test the function
async function testRunner() {
  console.log('🧪 Testing Maestro Runner\n');
  
  const testFiles = [
    '/Users/windows95/Coding/ai-tester/a.yaml',
    '/Users/windows95/Coding/ai-tester/beff.yaml'
  ];

  for (const testFile of testFiles) {
    if (!fs.existsSync(testFile)) {
      console.log(`⚠️  Skipping ${testFile} (file not found)`);
      continue;
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`🎯 Running: ${path.basename(testFile)}`);
    console.log(`${'='.repeat(60)}`);

    try {
      const result = await runMaestro(testFile, {
        timeout: 30000, // 30 second timeout for demo
        pollInterval: 1000 // Check every second
      });

      console.log('\n📄 Final Result:');
      console.log(JSON.stringify({
        success: result.success,
        flowName: result.flowName,
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
        duration: result.duration,
        errorMessage: result.errorMessage || null
      }, null, 2));

    } catch (error) {
      console.error(`💥 Test failed: ${error.message}`);
    }
  }
}

// Export for use in other modules
module.exports = { runMaestro };

// Run tests if this file is executed directly
if (require.main === module) {
  testRunner().then(() => {
    console.log('\n🎉 Test runner demo completed!');
  }).catch(console.error);
}
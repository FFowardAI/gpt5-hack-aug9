import * as path from 'path';
import * as fs from 'fs';
import { spawn, ChildProcess } from 'child_process';

export interface MaestroRunOptions {
  maestroBin?: string;
  workspace?: string;
  pollInterval?: number;
  timeout?: number;
}

export interface MaestroStatus {
  flowName: string;
  passed: number;
  failed: number;
  skipped: number;
  isRunning: boolean;
}

export interface MaestroResult extends MaestroStatus {
  success: boolean;
  errorMessage: string;
  exitCode: number;
  duration: number;
  stdout: string;
  stderr: string;
}

/**
 * Real-time Maestro test runner with TypeScript support
 * Monitors test execution every 1 second and returns complete results
 */
export async function runMaestro(
  yamlFilePath: string, 
  options: MaestroRunOptions = {}
): Promise<MaestroResult> {
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
    let lastStatus: MaestroStatus = { 
      flowName: 'Unknown', 
      passed: 0, 
      failed: 0, 
      skipped: 0, 
      isRunning: true 
    };

    // Start Maestro process
    const child: ChildProcess = spawn(maestroBin, ['test', yamlFilePath], {
      cwd: workspace,
      shell: true,
      env: process.env,
    });

    // Capture output
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
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
          errorMessage: 'Test timed out',
          exitCode: -1,
          duration: Date.now() - startTime,
          stdout,
          stderr,
          ...currentStatus
        });
      }
    }, pollInterval);

    // Handle completion
    child.on('close', (code: number | null) => {
      isComplete = true;
      clearInterval(progressMonitor);
      
      const duration = Date.now() - startTime;
      const finalStatus = parseFinalStatus(stdout, stderr, code || -1);
      
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

    child.on('error', (error: Error) => {
      isComplete = true;
      clearInterval(progressMonitor);
      console.error(`💥 Failed to start Maestro: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Write an array of Maestro YAML test strings to files in the given directory.
 * Returns absolute file paths. Ensures the directory exists.
 */
export function writeMaestroFlows(
  tests: string[],
  options: { directory: string; jobId?: string; filePrefix?: string } 
): string[] {
  const { directory, jobId, filePrefix } = options;
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  const resolvedDir = path.isAbsolute(directory) ? directory : path.resolve(process.cwd(), directory);
  const idBase = jobId ?? `${Date.now()}`;
  const prefix = filePrefix ?? idBase;

  console.log(`📝 Writing ${tests.length} Maestro flow(s) to: ${resolvedDir}`);
  const filePaths: string[] = [];
  for (let i = 0; i < tests.length; i += 1) {
    const yamlContent = tests[i];
    const fileName = `${prefix}-${i + 1}.yaml`;
    const filePath = path.join(resolvedDir, fileName);
    fs.writeFileSync(filePath, yamlContent, 'utf-8');
    console.log(`  • ${fileName}`);
    filePaths.push(filePath);
  }
  return filePaths;
}

/**
 * Run multiple Maestro YAML tests sequentially and collect results per file.
 */
export async function runMultipleMaestroTests(
  filePaths: string[],
  options: MaestroRunOptions = {}
): Promise<Array<{ filePath: string; result?: MaestroResult; error?: string }>> {
  console.log(`\n🧪 Running ${filePaths.length} Maestro test(s)...`);
  const results: Array<{ filePath: string; result?: MaestroResult; error?: string }> = [];
  for (let idx = 0; idx < filePaths.length; idx += 1) {
    const filePath = filePaths[idx];
    const label = `[${idx + 1}/${filePaths.length}]`;
    console.log(`▶️  ${label} ${path.basename(filePath)}`);
    try {
      const result = await runMaestro(filePath, options);
      const outcome = result.success ? '✅ PASSED' : '❌ FAILED';
      console.log(`   ${outcome} in ${result.duration}ms | steps: ✅${result.passed} ❌${result.failed} 🔲${result.skipped}`);
      results.push({ filePath, result });
    } catch (e: any) {
      console.log(`   💥 ERROR: ${e?.message ?? String(e)}`);
      results.push({ filePath, error: e?.message ?? String(e) });
    }
  }
  const passedCount = results.filter(r => r.result?.success).length;
  const failedCount = results.length - passedCount - results.filter(r => r.result).length + results.filter(r => r.error).length;
  console.log(`🏁 Finished running ${results.length} test(s) → ✅ ${passedCount} passed, ❌ ${results.length - passedCount} failed/errored\n`);
  return results;
}

/**
 * Parse real-time status from ongoing output
 */
function parseRealTimeStatus(stdout: string, stderr: string): MaestroStatus {
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
function parseFinalStatus(stdout: string, stderr: string, exitCode: number): Omit<MaestroResult, 'duration' | 'stdout' | 'stderr'> {
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
async function testRunner(): Promise<void> {
  console.log('🧪 Testing TypeScript Maestro Runner\n');
  
  const testFiles: string[] = [
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
      const result: MaestroResult = await runMaestro(testFile, {
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
      console.error(`💥 Test failed: ${(error as Error).message}`);
    }
  }
}
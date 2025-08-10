import path from 'node:path';
import fs from 'node:fs';
import express, { Request, Response } from 'express';
import morgan from 'morgan';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import { spawn } from 'node:child_process';
import { generateUnitTests } from './maestroGenerator.js';
import { runMultipleMaestroTests, writeMaestroFlows, runMaestro } from './maestroTestRunner.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// In-memory job store (replace with DB if needed)
type JobStatus = 'received' | 'queued' | 'running' | 'generated' | 'passed' | 'failed';

export interface ModifiedFile {
  path: string;
  diff: string;
}

export interface GenerateRequestBody {
  userMessage: string;
  modifiedFiles: ModifiedFile[];
  relatedFiles: string[];
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  flowPath: string | null;
  cursorTask: null; // reserved for future use
  modification: GenerateRequestBody | null;
  flow: null; // reserved for future use
  result: any;
  error: any;
  completedAt?: string;
}

const jobs = new Map<string, JobRecord>();

// Config via env
const PORT = Number(process.env.PORT || 5055);
const MAESTRO_BIN = process.env.MAESTRO_BIN || 'maestro';
const MAESTRO_WORKSPACE = process.env.MAESTRO_WORKSPACE || path.resolve(process.cwd());
const MAESTRO_FLOW_DIR = process.env.MAESTRO_FLOW_DIR || path.join(MAESTRO_WORKSPACE, 'maestro-flows');
const MCP_WEBHOOK_URL = process.env.MCP_WEBHOOK_URL || '';

function ensureDirExists(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirExists(MAESTRO_FLOW_DIR);

interface RetryResult {
  tests: string[];
  files: string[];
  results: Array<{ filePath: string; result?: any; error?: string }>;
  retryCount: number;
}

function collectTextsFromHierarchy(node: any, out: Set<string>) {
  if (!node || typeof node !== 'object') return;
  const text = node?.attributes?.text;
  if (typeof text === 'string' && text.trim().length > 0) {
    out.add(text.trim());
  }
  const children = node?.children;
  if (Array.isArray(children)) {
    for (const child of children) collectTextsFromHierarchy(child, out);
  }
}

function suggestFromFailureCommand(cmd: any): { summary: string; hints: string[] } {
  const hints: string[] = [];
  const parts: string[] = [];
  const commandJson = JSON.stringify(cmd.command, null, 2);
  parts.push(`Failed command: ${commandJson}`);

  const message = cmd.metadata?.error?.message || 'Unknown error';
  parts.push(`Error: ${message}`);

  // Collect UI texts
  const uiTexts = new Set<string>();
  if (cmd.metadata?.error?.hierarchyRoot) {
    collectTextsFromHierarchy(cmd.metadata.error.hierarchyRoot, uiTexts);
  }
  if (uiTexts.size > 0) {
    const list = Array.from(uiTexts).slice(0, 20); // cap for brevity
    parts.push(`Visible UI texts: ${JSON.stringify(list)}`);
  }

  // Heuristic: if selector uses textRegex, suggest closest matching visible text
  const selector = cmd.command?.tapOnElement?.selector
    || cmd.command?.assertConditionCommand?.condition?.visible
    || cmd.command?.assertConditionCommand?.condition?.notVisible
    || cmd.command?.assertConditionCommand?.condition?.visibleWithTimeout;
  const targetText = selector?.textRegex || selector?.text;
  if (typeof targetText === 'string' && uiTexts.size > 0) {
    // Find candidates that contain the target substring (case-insensitive)
    const lcTarget = targetText.toLowerCase();
    const candidates = Array.from(uiTexts).filter(t => t.toLowerCase().includes(lcTarget));
    if (candidates.length > 0) {
      // Prefer the shortest candidate (often the exact button label)
      const best = candidates.sort((a, b) => a.length - b.length)[0];
      hints.push(`Replace text selector "${targetText}" with exact UI text "${best}"`);
    } else {
      // If no direct contains, suggest using one of the visible texts explicitly
      const exemplar = Array.from(uiTexts).sort((a, b) => a.length - b.length)[0];
      if (exemplar) hints.push(`Use exact visible text instead of regex: "${exemplar}"`);
    }
  }

  return { summary: parts.join('\n'), hints };
}

async function extractFailureFeedback(debugDir: string): Promise<string> {
  try {
    // Prefer parsing commands-*.json to build actionable, concise feedback
    const files = fs.existsSync(debugDir) ? fs.readdirSync(debugDir) : [];
    const commandJsons = files.filter(f => f.endsWith('.json') && f.includes('commands-'));
    const feedbackChunks: string[] = [];
    const hintChunks: string[] = [];
    for (const file of commandJsons) {
      try {
        const jsonPath = path.join(debugDir, file);
        const content = fs.readFileSync(jsonPath, 'utf-8');
        const parsed = JSON.parse(content);
        const failedCommands = Array.isArray(parsed)
          ? parsed.filter((c: any) => c?.metadata?.status === 'FAILED')
          : [];
        for (const cmd of failedCommands) {
          const { summary, hints } = suggestFromFailureCommand(cmd);
          feedbackChunks.push(summary);
          hintChunks.push(...hints);
        }
      } catch {
        // ignore individual file parse errors
      }
    }

    if (feedbackChunks.length > 0) {
      const uniqueHints = Array.from(new Set(hintChunks));
      return `${feedbackChunks.join('\n\n')}\n\nSUGGESTED FIXES:\n- ${uniqueHints.join('\n- ')}`;
    }

    // Fallback: read maestro.log for general errors
    const logPath = path.join(debugDir, 'maestro.log');
    if (fs.existsSync(logPath)) {
      return fs.readFileSync(logPath, 'utf-8');
    }

    return 'No detailed error information found in debug files';
  } catch (error) {
    return `Failed to extract debug info: ${error}`;
  }
}

async function regenerateTestsWithFeedback(
  userMessage: string,
  modifiedFiles: ModifiedFile[],
  relatedFiles: string[],
  failureFeedback: string,
  attempt: number
): Promise<{ tests: string[] }> {
  const enhancedUserMessage = `${userMessage}

PREVIOUS ATTEMPT ${attempt} FAILED WITH ERRORS:
${failureFeedback}

Please generate improved tests that address these specific failures. Pay attention to:
1. Exact text content that exists in the UI
2. Proper element selectors and timing
3. Correct command syntax and formatting`;

  const result = await generateUnitTests({
    userMessage: enhancedUserMessage,
    modifiedFiles,
    relatedFiles,
    count: 1,
  });
  return { tests: result.tests };
}

async function runTestsWithRetry(options: {
  userMessage: string;
  modifiedFiles: ModifiedFile[];
  relatedFiles: string[];
  jobId: string;
  initialTests: string[];
  initialFiles: string[];
  maestroBin: string;
  workspace: string;
  maxRetries: number;
}): Promise<RetryResult> {
  const {
    userMessage,
    modifiedFiles,
    relatedFiles,
    jobId,
    initialTests,
    initialFiles,
    maestroBin,
    workspace,
    maxRetries
  } = options;

  let currentTests = initialTests;
  let currentFiles = initialFiles;
  let retryCount = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    console.log(`\n🔄 Test attempt ${attempt + 1}/${maxRetries + 1}`);

    // Run the current tests
    const runResults = await runMultipleMaestroTests(currentFiles, {
      maestroBin,
      workspace,
    });

    // Check if any tests passed
    const hasPassingTests = runResults.some(r => r.result?.success);
    const allTestsPassed = runResults.every(r => r.result?.success);

    if (allTestsPassed) {
      console.log(`✅ All tests passed on attempt ${attempt + 1}`);
      return {
        tests: currentTests,
        files: currentFiles,
        results: runResults,
        retryCount: attempt
      };
    }

    if (hasPassingTests) {
      console.log(`⚠️  Some tests passed on attempt ${attempt + 1}, but continuing to improve failed ones`);
    }

    // If this was the last attempt, return the results
    if (attempt === maxRetries) {
      console.log(`❌ Reached maximum retries (${maxRetries + 1} attempts). Returning final results.`);
      return {
        tests: currentTests,
        files: currentFiles,
        results: runResults,
        retryCount: attempt
      };
    }

    // Extract failure feedback from debug directories
    let combinedFeedback = '';
    for (const result of runResults) {
      if (!result.result?.success && result.result?.debugDir) {
        const feedback = await extractFailureFeedback(result.result.debugDir);
        combinedFeedback += `\nFailure in ${path.basename(result.filePath)}:\n${feedback}\n`;
      }
    }

    if (!combinedFeedback) {
      combinedFeedback = runResults
        .filter(r => !r.result?.success)
        .map(r => `${path.basename(r.filePath)}: ${r.error || r.result?.errorMessage || 'Unknown error'}`)
        .join('\n');
    }

    console.log(`🔍 Failure feedback for retry ${attempt + 1}:\n${combinedFeedback.substring(0, 500)}...`);

    // Regenerate tests with failure feedback
    try {
      const regeneratedTests = await regenerateTestsWithFeedback(
        userMessage,
        modifiedFiles,
        relatedFiles,
        combinedFeedback,
        attempt + 1
      );

      // Write new test files
      const newFiles = writeMaestroFlows(regeneratedTests.tests, {
        directory: path.join(workspace, 'maestro-flows'),
        jobId: `${jobId}-retry${attempt + 1}`,
      });

      currentTests = regeneratedTests.tests;
      currentFiles = newFiles;
      retryCount = attempt + 1;

      console.log(`🔄 Generated ${regeneratedTests.tests.length} new tests for retry ${attempt + 1}`);
    } catch (error) {
      console.error(`❌ Failed to regenerate tests for attempt ${attempt + 1}:`, error);
      // Continue with existing tests if regeneration fails
    }
  }

  // This should never be reached due to the loop structure, but included for completeness
  return {
    tests: currentTests,
    files: currentFiles,
    results: [],
    retryCount
  };
}

async function notifyMcp(payload: unknown) {
  if (!MCP_WEBHOOK_URL) return { skipped: true } as const;
  try {
    const res = await axios.post(MCP_WEBHOOK_URL, payload, { timeout: 10_000 });
    return { ok: true as const, status: res.status };
  } catch (error: any) {
    return { ok: false as const, error: error?.message ?? String(error) };
  }
}

// 1) Receive modification context for test generation
// POST /api/generate
// Body: GenerateRequestBody
app.post('/api/generate-tests', async (req: Request, res: Response) => {
  try {
    const body = req.body as Partial<GenerateRequestBody> | undefined;
    const userMessage = body?.userMessage;
    const modifiedFiles = body?.modifiedFiles;
    const relatedFiles = body?.relatedFiles;
    const isAsync = req.query.async === '1' || (body as any)?.async === true;

    if (typeof userMessage !== 'string' || userMessage.length === 0) {
      return res.status(400).json({ error: 'userMessage must be a non-empty string' });
    }
    if (!Array.isArray(modifiedFiles)) {
      return res.status(400).json({ error: 'modifiedFiles must be an array' });
    }
    for (const mf of modifiedFiles) {
      if (!mf || typeof mf.path !== 'string' || typeof mf.diff !== 'string') {
        return res.status(400).json({ error: 'each modifiedFiles item must be an object with string path and diff' });
      }
    }
    if (!Array.isArray(relatedFiles) || relatedFiles.some((r) => typeof r !== 'string')) {
      return res.status(400).json({ error: 'relatedFiles must be an array of strings' });
    }

    const jobId = uuidv4();

    const record: JobRecord = {
      id: jobId,
      status: isAsync ? 'queued' : 'received',
      createdAt: new Date().toISOString(),
      flowPath: null,
      cursorTask: null,
      modification: { userMessage, modifiedFiles, relatedFiles } as GenerateRequestBody,
      flow: null,
      result: null,
      error: null,
    };
    jobs.set(jobId, record);

    console.log('received modification context', JSON.stringify(record, null, 2));

    const runJob = async () => {
      try {
        jobs.set(jobId, { ...record, status: 'running' });

        // Generate Maestro tests using the new TS generator
        const generatedTests = await generateUnitTests({
          userMessage: userMessage as string,
          modifiedFiles: modifiedFiles as ModifiedFile[],
          relatedFiles: relatedFiles as string[],
          count: 1,
        });

        console.log('generated tests', generatedTests);

        // Persist generated tests to YAML files
        const flowFilePaths = writeMaestroFlows(generatedTests.tests, {
          directory: MAESTRO_FLOW_DIR,
          jobId,
        });

        // Run Maestro tests with retry logic
        const finalResults = await runTestsWithRetry({
          userMessage: userMessage as string,
          modifiedFiles: modifiedFiles as ModifiedFile[],
          relatedFiles: relatedFiles as string[],
          jobId,
          initialTests: generatedTests.tests,
          initialFiles: flowFilePaths,
          maestroBin: MAESTRO_BIN,
          workspace: MAESTRO_WORKSPACE,
          maxRetries: 5
        });

        const responsePayload = {
          jobId,
          tests: finalResults.tests,
          files: finalResults.files,
          results: finalResults.results,
          meta: {
            ...generatedTests.meta,
            generated: finalResults.tests.length,
            retries: finalResults.retryCount,
            finalAttempt: finalResults.retryCount + 1
          },
        };

        jobs.set(jobId, { ...record, status: 'generated', result: responsePayload });
      } catch (err: any) {
        jobs.set(jobId, { ...record, status: 'failed', error: err?.message ?? String(err) });
      }
    };

    if (isAsync) {
      // Kick off in background and respond immediately
      setImmediate(runJob);
      return res.json({ jobId, status: 'queued' });
    }

    await runJob();
    const finished = jobs.get(jobId);
    return res.json(finished?.result ?? { jobId, status: finished?.status || 'failed' });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? String(error) });
  }
});

app.get('/api/health', (_: Request, res: Response) => res.json({ ok: true }));

// Job status endpoint for async polling
app.get('/api/job/:id', (req: Request, res: Response) => {
  const id = String(req.params.id);
  const record = jobs.get(id);
  if (!record) return res.status(404).json({ error: 'job not found', id });
  return res.json({ id, status: record.status, result: record.result, error: record.error });
});

// Simple route to manually run a specific Maestro flow by file name
// Example:
//   curl "http://localhost:${PORT}/api/test-maestrorunner?name=25d35967-7e41-44fa-b2f7-20ef01e9af25-1.yml"
app.get('/api/test-maestrorunner', async (req: Request, res: Response) => {
  try {
    const name = (req.query.name || req.query.file || '25d35967-7e41-44fa-b2f7-20ef01e9af25-1.yml') as string;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Query param "name" (or "file") is required' });
    }

    // Force resolution within the configured flows directory
    let candidatePath = path.join(MAESTRO_FLOW_DIR, name);

    // If not found, try toggling between .yml and .yaml
    if (!fs.existsSync(candidatePath)) {
      if (name.toLowerCase().endsWith('.yml')) {
        const alt = name.replace(/\.yml$/i, '.yaml');
        const altPath = path.join(MAESTRO_FLOW_DIR, alt);
        if (fs.existsSync(altPath)) candidatePath = altPath;
      } else if (name.toLowerCase().endsWith('.yaml')) {
        const alt = name.replace(/\.yaml$/i, '.yml');
        const altPath = path.join(MAESTRO_FLOW_DIR, alt);
        if (fs.existsSync(altPath)) candidatePath = altPath;
      }
    }

    if (!fs.existsSync(candidatePath)) {
      return res.status(404).json({ error: 'Flow file not found', tried: [candidatePath] });
    }

    const result = await runMaestro(candidatePath, {
      maestroBin: MAESTRO_BIN,
      workspace: MAESTRO_WORKSPACE,
    });

    return res.json({ file: candidatePath, result });
  } catch (error: any) {
    return res.status(500).json({ error: error?.message ?? String(error) });
  }
});

app.get('/', (_: Request, res: Response) => {
  res.type('html').send(`
    <html>
      <head><title>AI Tester Server</title></head>
      <body>
        <h1>AI Tester Server</h1>
        <p>Server is running.</p>
        <ul>
          <li>GET <code>/api/health</code></li>
          <li>POST <code>/api/generate</code></li>
          <li>POST <code>/api/run</code></li>
          <li>POST <code>/api/maestro/callback</code></li>
        </ul>
      </body>
    </html>
  `);
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[ai-tester] Server listening on http://localhost:${PORT}`);
});




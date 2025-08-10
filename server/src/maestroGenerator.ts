import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';

export interface ModifiedFile {
  path: string;
  diff?: string;
}

export interface GenerateUnitTestsParams {
  userMessage: string;
  modifiedFiles?: ModifiedFile[];
  relatedFiles?: string[];
  count?: number;
  model?: string;
  verbosity?: 'low' | 'medium' | 'high';
  minimalReasoning?: boolean;
}

export interface GenerateUnitTestsResult {
  tests: string[];
  meta?: Record<string, unknown>;
}

const DEFAULT_MODEL = process.env.GEN_UNIT_TESTS_MODEL || 'gpt-5-mini';

function repoRootDir(): string {
  // Resolve repo root as the parent of the server directory
  const __filename = fileURLToPath(import.meta.url);
  const serverSrcDir = path.dirname(__filename);
  const serverDir = path.resolve(serverSrcDir, '..');
  const root = path.resolve(serverDir, '..');
  return root;
}

function readGrammar(): string {
  const root = repoRootDir();
  const candidates = [
    path.join(root, 'TestGen', 'maestro_grammar.lark'),
    path.join(process.cwd(), 'TestGen', 'maestro_grammar.lark'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch (_) {
      // ignore
    }
  }
  throw new Error('maestro_grammar.lark not found in TestGen directory');
}

function readCommandsPrompt(): string {
  const root = repoRootDir();
  const candidates = [
    path.join(root, 'TestGen', 'COMMANDS.prompt'),
    path.join(process.cwd(), 'TestGen', 'COMMANDS.prompt'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return fs.readFileSync(p, 'utf-8');
    } catch (_) {
      // ignore
    }
  }
  // Return empty string if file not found (backward compatibility)
  return '';
}

// Truncation disabled to provide complete context as requested
// Keeping function in case we need to re-enable it with higher limits
function truncate(text: string, limit = 8000): string {
  // Always return full text - no truncation
  return text;
}

function buildPrompt(
  userMessage: string,
  changedFiles: string[],
  relatedFiles: string[],
  changedDiffs: Record<string, string>,
  relatedFileBodies: Record<string, string>,
  commandsDocumentation: string
): string {
  const changedList = changedFiles.length
    ? changedFiles.map((p) => `- ${p}`).join('\n')
    : '- (none)';
  const relatedList = relatedFiles.length
    ? relatedFiles.map((p) => `- ${p}`).join('\n')
    : '- (none)';

  const examples = [
    'url: "http://localhost:3000"',
    '---',
    '- launchApp',
    '- waitForAnimationToEnd',
    '- tapOn: "Login"',
    '- inputText: "username"',
    '- assertVisible: "Welcome"',
    '- takeScreenshot: login_success',
  ].join('\n');

  const parts: string[] = [];
  parts.push(
    'Call the maestro_yaml_grammar tool to generate ONE Maestro YAML test flow for WEB TESTING. ' +
    'Strictly conform to the grammar. Use DOUBLE QUOTES for strings where needed. ' +
    'Start with url: "http://localhost:3000" and include "- launchApp" and "- waitForAnimationToEnd" after the --- separator.\n' +
    '\nTEXT MATCHING NOTES:\n' +
    '- Maestro supports partial text matching, so "Back" will match "Back to Homepage"\n' +
    '- Use concise, distinctive text that uniquely identifies UI elements\n' +
    '- Prefer shorter text snippets that are likely to remain stable\n'
  );
  
  // Include command documentation if available
  if (commandsDocumentation) {
    parts.push('\n## Available Maestro Commands Reference:\n');
    parts.push(commandsDocumentation);  // No truncation - send complete documentation
    parts.push('\n');
  }
  
  parts.push(`\nUser message:\n${userMessage}\n`);
  parts.push(`\nChanged files (paths):\n${changedList}\n`);

  if (Object.keys(changedDiffs).length) {
    parts.push('\nChanged file diffs (for context only):\n');
    for (const [p, diff] of Object.entries(changedDiffs)) {
      parts.push(`\n# DIFF: ${p}\n` + diff);  // No truncation - send complete diff
    }
  }

  parts.push(`\nRelated files (paths):\n${relatedList}\n`);
  if (Object.keys(relatedFileBodies).length) {
    parts.push('\nRelated file contents (for context only):\n');
    for (const [p, body] of Object.entries(relatedFileBodies)) {
      parts.push(`\n# FILE: ${p}\n` + body);  // No truncation - send complete file content
    }
  }

  parts.push('\nFollow these patterns exactly (indentation and quoting):\n' + examples);
  parts.push(
    '\nCRITICAL FORMATTING RULES:\n' +
    '- Prefer single-line commands.\n' +
    '- tapOn MUST be: "tapOn: "TEXT"" (single line). Do NOT use map form.\n' +
    '- takeScreenshot MUST be single-line: "takeScreenshot: name" (no quotes preferred).\n' +
    '- For mapped commands (pressKey, scroll, swipe, runFlow, runScript), use a newline after the colon and 2-space indentation.\n'
  );

  return parts.join('');
}

function extractToolInputFromResponse(response: any): string | null {
  const out = (response as any)?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      if (typeof item?.input === 'string') return item.input;
    }
    const chunks: string[] = [];
    for (const item of out) {
      const content = (item as any)?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === 'string') chunks.push(c.text);
        }
      }
    }
    if (chunks.length) return chunks.join('');
  }
  // Fallbacks if SDK shape differs
  if (typeof (response as any)?.input === 'string') return (response as any).input;
  const content = (response as any)?.content;
  if (Array.isArray(content)) {
    const chunks: string[] = [];
    for (const c of content) if (typeof c?.text === 'string') chunks.push(c.text);
    if (chunks.length) return chunks.join('');
  }
  return null;
}

async function generateOne(
  client: OpenAI,
  model: string,
  grammarText: string,
  commandsDocumentation: string,
  userMessage: string,
  changedFiles: string[],
  relatedFiles: string[],
  changedDiffs: Record<string, string>,
  relatedBodies: Record<string, string>,
  verbosity: 'low' | 'medium' | 'high',
  minimalReasoning: boolean
): Promise<string> {
  const prompt = buildPrompt(userMessage, changedFiles, relatedFiles, changedDiffs, relatedBodies, commandsDocumentation);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const body: any = {
      model,
      input:
        attempt === 0
          ? prompt
          : `${prompt}\n\nCORRECTION: Grammar violation! For mapping commands like 'tapOn:', 'takeScreenshot:', etc:\n- Simple form: 'tapOn: "text"' (one line)\n- Map form: 'tapOn:' then NEWLINE, then '  id: "..."' (indented 2 spaces)\nNEVER mix forms. After a colon in map form, ALWAYS have a newline before the indented properties.`,
      text: { format: { type: 'text' }, verbosity },
      tools: [
        {
          // Cast to any to allow custom grammar tool format across SDK versions
          type: 'custom',
          name: 'maestro_yaml_grammar',
          description:
            'Generates a Maestro YAML test flow. YOU MUST ONLY EMIT STRINGS VALID UNDER THE PROVIDED LARK GRAMMAR.',
          format: {
            type: 'grammar',
            syntax: 'lark',
            definition: grammarText,
          },
        } as any,
      ],
      parallel_tool_calls: false,
      reasoning: { effort: minimalReasoning ? 'low' : 'medium' },
    };
    const response: any = await (client.responses as any).create(body);

    const toolInput = extractToolInputFromResponse(response);
    if (typeof toolInput === 'string' && toolInput.trim().length > 0) {
      return toolInput;
    }
  }
  throw new Error('Failed to generate valid YAML after retries');
}

export async function generateUnitTests(params: GenerateUnitTestsParams): Promise<GenerateUnitTestsResult> {
  const grammarText = readGrammar();
  const commandsDocumentation = readCommandsPrompt();

  const {
    userMessage,
    modifiedFiles = [],
    relatedFiles = [],
    count = 1,
    model = DEFAULT_MODEL,
    verbosity = 'low',
    minimalReasoning = false,
  } = params;

  const changedFilesPaths = modifiedFiles.map((m) => m.path);
  const changedDiffs: Record<string, string> = {};
  for (const m of modifiedFiles) if (m.path && typeof m.diff === 'string') changedDiffs[m.path] = m.diff;

  // Read related file bodies (best-effort)
  const relatedBodies: Record<string, string> = {};
  for (const p of relatedFiles) {
    try {
      const abs = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
      relatedBodies[p] = fs.readFileSync(abs, 'utf-8');
    } catch (_) {
      // ignore read errors
    }
  }

  // API key (hardcoded fallback as requested)
  const apiKey =
    process.env.OPENAI_API_KEY ||
    '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';
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const client = new OpenAI({ apiKey });

  const tests: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const unit = await generateOne(
      client,
      model,
      grammarText,
      commandsDocumentation,
      userMessage,
      changedFilesPaths,
      relatedFiles,
      changedDiffs,
      relatedBodies,
      verbosity,
      minimalReasoning
    );
    tests.push(unit);
  }

  return { tests, meta: { generated: tests.length } };
}

// Back-compat wrapper used by index.ts
export interface JobRecordLike {
  id: string;
  modification: {
    userMessage: string;
    modifiedFiles: { path: string; diff: string }[];
    relatedFiles: string[];
  } | null;
}

export async function generateMaestroScripts(record: JobRecordLike): Promise<string[]> {
  if (!record.modification) return [];
  const { userMessage, modifiedFiles, relatedFiles } = record.modification;
  const result = await generateUnitTests({ userMessage, modifiedFiles, relatedFiles, count: 1 });
  return result.tests;
}
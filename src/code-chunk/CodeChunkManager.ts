/**
 * CodeChunkManager - Central coordinator for code chunk execution.
 *
 * Parses code chunks from markdown, caches results, orchestrates
 * execution via CodeChunkExecutor or CodeChunkSession, and formats output.
 */

import { getFullConfig } from '../config/ConfigManager';
import type {
  CodeChunk,
  CodeChunkAttributes,
  CodeChunkOutputFormat,
} from '../types';
import { CodeChunkExecutor, type ExecutionResult } from './CodeChunkExecutor';
import { CodeChunkSession } from './CodeChunkSession';

/**
 * Regex to extract fenced code blocks with their info strings and content.
 * Matches opening ```, the info string, content, and closing ```.
 */
const FENCE_REGEX = /^(`{3,})([^\n]*)\n([\s\S]*?)^\1\s*$/gm;

/**
 * Parse a code chunk info string into CodeChunkAttributes.
 * Supports: key=value, key="value", key='value', bare flags, .class shorthand, args=[...].
 */
function parseCodeChunkAttrs(
  _language: string,
  attrStr: string,
): CodeChunkAttributes {
  const attrs: CodeChunkAttributes = {
    cmd: false,
    output: 'text',
    args: [],
    stdin: false,
    hide: false,
    continue: false,
    id: '',
    class: '',
    element: '',
    run_on_save: false,
    modify_source: false,
    matplotlib: false,
    latex_zoom: 1,
    latex_width: '',
    latex_height: '',
    latex_engine: 'pdflatex',
  };

  if (!attrStr) return attrs;

  // Tokenize the attribute string
  let pos = 0;
  const str = attrStr.trim();

  while (pos < str.length) {
    // Skip whitespace
    while (pos < str.length && /\s/.test(str[pos])) pos++;
    if (pos >= str.length) break;

    // CSS class shorthand: .className
    if (str[pos] === '.') {
      pos++;
      let cls = '';
      while (pos < str.length && /[\w-]/.test(str[pos])) {
        cls += str[pos++];
      }
      if (cls) {
        attrs.class = attrs.class ? `${attrs.class} ${cls}` : cls;
      }
      continue;
    }

    // Read key
    let key = '';
    while (pos < str.length && /[\w_]/.test(str[pos])) {
      key += str[pos++];
    }

    if (!key) {
      pos++;
      continue;
    }

    // Skip whitespace
    while (pos < str.length && str[pos] === ' ') pos++;

    // Check for =
    if (pos < str.length && str[pos] === '=') {
      pos++; // skip =
      // Skip whitespace
      while (pos < str.length && str[pos] === ' ') pos++;

      let value = '';

      if (pos < str.length && str[pos] === '[') {
        // Array value: args=["-v", "--flag"]
        const start = pos;
        let depth = 0;
        while (pos < str.length) {
          if (str[pos] === '[') depth++;
          else if (str[pos] === ']') {
            depth--;
            if (depth === 0) {
              pos++;
              break;
            }
          }
          pos++;
        }
        value = str.substring(start, pos);
      } else if (pos < str.length && (str[pos] === '"' || str[pos] === "'")) {
        // Quoted value
        const quote = str[pos++];
        while (pos < str.length && str[pos] !== quote) {
          value += str[pos++];
        }
        if (pos < str.length) pos++; // skip closing quote
      } else {
        // Unquoted value
        while (pos < str.length && !/\s/.test(str[pos])) {
          value += str[pos++];
        }
      }

      setAttr(attrs, key, value);
    } else {
      // Bare flag: key → key=true
      setAttr(attrs, key, 'true');
    }
  }

  return attrs;
}

/**
 * Set a single attribute on the CodeChunkAttributes object.
 */
function setAttr(attrs: CodeChunkAttributes, key: string, value: string): void {
  switch (key) {
    case 'cmd':
      attrs.cmd = value === 'true' ? true : value === 'false' ? false : value;
      break;
    case 'output':
      if (['text', 'html', 'markdown', 'png', 'none'].includes(value)) {
        attrs.output = value as CodeChunkOutputFormat;
      }
      break;
    case 'args':
      try {
        // Parse JSON array
        attrs.args = JSON.parse(value);
      } catch {
        attrs.args = [value];
      }
      break;
    case 'stdin':
      attrs.stdin = value === 'true';
      break;
    case 'hide':
      attrs.hide = value === 'true';
      break;
    case 'continue':
      attrs.continue =
        value === 'true' ? true : value === 'false' ? false : value;
      break;
    case 'id':
      attrs.id = value;
      break;
    case 'class':
      attrs.class = attrs.class ? `${attrs.class} ${value}` : value;
      break;
    case 'element':
      attrs.element = value;
      break;
    case 'run_on_save':
      attrs.run_on_save = value === 'true';
      break;
    case 'modify_source':
      attrs.modify_source = value === 'true';
      break;
    case 'matplotlib':
      attrs.matplotlib = value === 'true';
      break;
    case 'latex_zoom':
      attrs.latex_zoom = parseFloat(value) || 1;
      break;
    case 'latex_width':
      attrs.latex_width = value;
      break;
    case 'latex_height':
      attrs.latex_height = value;
      break;
    case 'latex_engine':
      attrs.latex_engine = value;
      break;
  }
}

/**
 * Per-file CodeChunkManager. Use getCodeChunkManager(uri) to get one.
 */
export class CodeChunkManager {
  private chunks: Map<string, CodeChunk> = new Map();
  private chunkOrder: string[] = [];
  private executor: CodeChunkExecutor = new CodeChunkExecutor();
  private session: CodeChunkSession = new CodeChunkSession();

  /**
   * Parse all code chunks from markdown source text.
   * Returns an ordered list of chunk IDs.
   */
  parseChunks(markdown: string): string[] {
    this.chunks.clear();
    this.chunkOrder = [];
    let chunkIndex = 0;

    FENCE_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = FENCE_REGEX.exec(markdown)) !== null) {
      const infoString = match[2].trim();
      const code = match[3];
      const lineOffset =
        markdown.substring(0, match.index).split('\n').length - 1;

      // Parse the info string
      const langMatch = infoString.match(/^(\S+?)(?:\s+\{(.+)\})?\s*$/);
      if (!langMatch) continue;

      const language = langMatch[1];
      const attrStr = langMatch[2] || '';
      const attrs = parseCodeChunkAttrs(language, attrStr);

      // Only process chunks with cmd attribute
      if (attrs.cmd === false) continue;

      const id = attrs.id || `chunk-${chunkIndex}`;
      chunkIndex++;

      const chunk: CodeChunk = {
        id,
        language,
        code,
        attrs,
        line: lineOffset,
        result: '',
        status: 'idle',
        running: false,
        error: '',
      };

      this.chunks.set(id, chunk);
      this.chunkOrder.push(id);
    }

    return this.chunkOrder;
  }

  /**
   * Run a single code chunk by ID.
   */
  async runChunk(
    chunkId: string,
    workingDir: string,
  ): Promise<CodeChunk | null> {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return null;

    const config = getFullConfig();

    chunk.status = 'running';
    chunk.running = true;
    chunk.error = '';

    try {
      // Build combined code for continue chains
      const combinedCode = this.buildContinuedCode(chunkId);
      let result: ExecutionResult;

      // Use session for continue chunks
      if (chunk.attrs.continue !== false) {
        const sessionId =
          typeof chunk.attrs.continue === 'string' &&
          chunk.attrs.continue !== 'true'
            ? chunk.attrs.continue
            : chunk.language;
        const sessionResult = await this.session.sendCode(
          chunk.language,
          sessionId,
          chunk.code, // Only send this chunk's code to session (previous code already executed)
          workingDir,
          config.codeChunk.executionTimeout,
        );
        result = {
          stdout: sessionResult.stdout,
          stderr: sessionResult.stderr,
          exitCode: sessionResult.stderr ? 1 : 0,
        };
      } else {
        result = await this.executor.execute(
          chunk,
          combinedCode,
          workingDir,
          config.codeChunk.enableScriptExecution,
          config.codeChunk.executionTimeout,
          config.codeChunk.defaultShell || undefined,
          config.codeChunk.latexEngine || undefined,
        );
      }

      chunk.result = this.renderOutput(
        result.stdout,
        result.stderr,
        chunk.attrs.output,
        chunk.attrs.matplotlib,
      );
      chunk.status = result.exitCode === 0 ? 'success' : 'error';
      chunk.error = result.stderr;
    } catch (err) {
      chunk.status = 'error';
      chunk.error = String(err);
      chunk.result = `<pre class="code-chunk-error">${escapeHtml(
        String(err),
      )}</pre>`;
    } finally {
      chunk.running = false;
    }

    return chunk;
  }

  /**
   * Run all code chunks sequentially.
   */
  async runAllChunks(workingDir: string): Promise<CodeChunk[]> {
    const results: CodeChunk[] = [];
    for (const id of this.chunkOrder) {
      const result = await this.runChunk(id, workingDir);
      if (result) results.push(result);
    }
    return results;
  }

  /**
   * Run only chunks that have run_on_save=true.
   */
  async runOnSaveChunks(workingDir: string): Promise<CodeChunk[]> {
    const results: CodeChunk[] = [];
    for (const id of this.chunkOrder) {
      const chunk = this.chunks.get(id);
      if (chunk?.attrs.run_on_save) {
        const result = await this.runChunk(id, workingDir);
        if (result) results.push(result);
      }
    }
    return results;
  }

  /**
   * Find the chunk that contains the given source line number.
   */
  findChunkAtLine(line: number): CodeChunk | null {
    let found: CodeChunk | null = null;
    for (const id of this.chunkOrder) {
      const chunk = this.chunks.get(id);
      if (chunk && chunk.line <= line) {
        found = chunk;
      } else if (chunk && chunk.line > line) {
        break;
      }
    }
    return found;
  }

  /**
   * Build the combined code for a chunk, walking the continue chain.
   */
  buildContinuedCode(chunkId: string): string {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return '';

    if (chunk.attrs.continue === false) {
      return chunk.code;
    }

    // Walk the continue chain
    const codeBlocks: string[] = [];
    const visited = new Set<string>();

    if (
      typeof chunk.attrs.continue === 'string' &&
      chunk.attrs.continue !== 'true'
    ) {
      // continue="specificId" — find that chunk and all between
      this.collectContinueChain(chunk.attrs.continue, codeBlocks, visited);
    } else {
      // continue=true — find last same-language chunk before this one
      for (const id of this.chunkOrder) {
        if (id === chunkId) break;
        const prev = this.chunks.get(id);
        if (prev && prev.language === chunk.language) {
          codeBlocks.push(prev.code);
        }
      }
    }

    codeBlocks.push(chunk.code);
    return codeBlocks.join('\n');
  }

  /**
   * Recursively collect code from a continue chain starting from a given ID.
   */
  private collectContinueChain(
    startId: string,
    codeBlocks: string[],
    visited: Set<string>,
  ): void {
    if (visited.has(startId)) return;
    visited.add(startId);

    const chunk = this.chunks.get(startId);
    if (!chunk) return;

    // If this chunk also continues from another, follow it first
    if (
      chunk.attrs.continue !== false &&
      typeof chunk.attrs.continue === 'string' &&
      chunk.attrs.continue !== 'true'
    ) {
      this.collectContinueChain(chunk.attrs.continue, codeBlocks, visited);
    }

    codeBlocks.push(chunk.code);
  }

  /**
   * Render execution output based on the output format.
   */
  renderOutput(
    stdout: string,
    stderr: string,
    format: CodeChunkOutputFormat,
    isMatplotlib: boolean = false,
  ): string {
    let html = '';

    // Matplotlib produces base64 PNG directly
    if (isMatplotlib && stdout && !stdout.startsWith('<')) {
      html = `<img src="data:image/png;base64,${stdout}" alt="matplotlib output" class="code-chunk-matplotlib">`;
    } else {
      switch (format) {
        case 'text':
          html = stdout
            ? `<pre class="code-chunk-output-text">${escapeHtml(stdout)}</pre>`
            : '';
          break;
        case 'html':
          html = stdout;
          break;
        case 'markdown':
          // The webview will need to process this further
          html = `<div class="code-chunk-output-markdown">${stdout}</div>`;
          break;
        case 'png':
          if (stdout) {
            html = `<img src="data:image/png;base64,${stdout}" alt="output" class="code-chunk-output-png">`;
          }
          break;
        case 'none':
          html = '';
          break;
      }
    }

    // Always show stderr if present
    if (stderr) {
      html += `<pre class="code-chunk-error">${escapeHtml(stderr)}</pre>`;
    }

    return html;
  }

  /**
   * Get a chunk by ID.
   */
  getChunk(chunkId: string): CodeChunk | undefined {
    return this.chunks.get(chunkId);
  }

  /**
   * Get all chunk IDs in order.
   */
  getChunkIds(): string[] {
    return [...this.chunkOrder];
  }

  /**
   * Check if any chunks have run_on_save=true.
   */
  hasRunOnSaveChunks(): boolean {
    for (const id of this.chunkOrder) {
      const chunk = this.chunks.get(id);
      if (chunk?.attrs.run_on_save) return true;
    }
    return false;
  }

  /**
   * Dispose of all sessions.
   */
  dispose(): void {
    this.session.dispose();
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Per-file manager cache.
 */
const managerCache: Map<string, CodeChunkManager> = new Map();

/**
 * Get or create a CodeChunkManager for a source URI.
 */
export function getCodeChunkManager(sourceUri: string): CodeChunkManager {
  let manager = managerCache.get(sourceUri);
  if (!manager) {
    manager = new CodeChunkManager();
    managerCache.set(sourceUri, manager);
  }
  return manager;
}

/**
 * Dispose of a specific manager and remove from cache.
 */
export function disposeCodeChunkManager(sourceUri: string): void {
  const manager = managerCache.get(sourceUri);
  if (manager) {
    manager.dispose();
    managerCache.delete(sourceUri);
  }
}

/**
 * Dispose of all managers.
 */
export function disposeAllCodeChunkManagers(): void {
  for (const [, manager] of managerCache) {
    manager.dispose();
  }
  managerCache.clear();
}

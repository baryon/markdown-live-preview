/**
 * CodeChunkExecutor - Executes code via child_process.
 *
 * Handles temp file creation, stdin piping, matplotlib, LaTeX,
 * and configurable timeout.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CodeChunk } from '../types';

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Map of language identifiers to temp file extensions.
 */
const TEMP_EXT_MAP: Record<string, string> = {
  'javascript': '.js',
  'js': '.js',
  'typescript': '.ts',
  'ts': '.ts',
  'python': '.py',
  'python3': '.py',
  'ruby': '.rb',
  'bash': '.sh',
  'sh': '.sh',
  'zsh': '.zsh',
  'go': '.go',
  'rust': '.rs',
  'c': '.c',
  'cpp': '.cpp',
  'c++': '.cpp',
  'java': '.java',
  'php': '.php',
  'perl': '.pl',
  'r': '.r',
  'R': '.r',
  'lua': '.lua',
  'swift': '.swift',
  'kotlin': '.kt',
  'scala': '.scala',
  'haskell': '.hs',
  'elixir': '.exs',
  'erlang': '.erl',
};

export class CodeChunkExecutor {
  /**
   * Execute a code chunk. Resolves the command, determines execution mode
   * (stdin vs temp file), and handles special languages.
   */
  async execute(
    chunk: CodeChunk,
    combinedCode: string,
    workingDir: string,
    enableScriptExecution: boolean,
    timeout: number,
  ): Promise<ExecutionResult> {
    if (!enableScriptExecution) {
      return {
        stdout: '',
        stderr: 'Script execution is disabled.',
        exitCode: 1,
      };
    }

    const cmd = this.resolveCommand(chunk);
    if (!cmd) {
      return {
        stdout: '',
        stderr: 'No command specified for code chunk.',
        exitCode: 1,
      };
    }

    // Special handling for matplotlib
    if (
      chunk.attrs.matplotlib &&
      (chunk.language === 'python' || chunk.language === 'python3')
    ) {
      return this.executePythonMatplotlib(
        cmd,
        combinedCode,
        workingDir,
        timeout,
      );
    }

    // Special handling for LaTeX
    if (chunk.language === 'latex' || chunk.language === 'tex') {
      return this.executeLatex(combinedCode, workingDir, chunk.attrs, timeout);
    }

    // Standard execution
    if (chunk.attrs.stdin) {
      return this.executeViaStdin(
        cmd,
        chunk.attrs.args,
        combinedCode,
        workingDir,
        timeout,
      );
    } else {
      return this.executeViaTempFile(
        cmd,
        chunk.attrs.args,
        combinedCode,
        chunk.language,
        workingDir,
        timeout,
      );
    }
  }

  /**
   * Resolve the command to execute from chunk attributes.
   */
  private resolveCommand(chunk: CodeChunk): string {
    const { cmd } = chunk.attrs;
    if (typeof cmd === 'string' && cmd !== 'true') {
      return cmd;
    }
    // cmd=true means use the language name as the command
    return chunk.language;
  }

  /**
   * Execute code by writing to a temp file and spawning the command.
   */
  private async executeViaTempFile(
    cmd: string,
    args: string[],
    code: string,
    language: string,
    workingDir: string,
    timeout: number,
  ): Promise<ExecutionResult> {
    const ext = TEMP_EXT_MAP[language] || '.tmp';
    const tmpFile = path.join(
      os.tmpdir(),
      `mpe_code_chunk_${Date.now()}${ext}`,
    );

    try {
      fs.writeFileSync(tmpFile, code, 'utf-8');

      // Replace $input_file macro in args
      const resolvedArgs = args.map((a) => a.replace(/\$input_file/g, tmpFile));

      // If no args contain $input_file, append the temp file as last argument
      if (!args.some((a) => a.includes('$input_file'))) {
        resolvedArgs.push(tmpFile);
      }

      return await this.spawnCommand(
        cmd,
        resolvedArgs,
        '',
        workingDir,
        timeout,
      );
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  /**
   * Execute code by piping it to stdin of the command.
   */
  private async executeViaStdin(
    cmd: string,
    args: string[],
    code: string,
    workingDir: string,
    timeout: number,
  ): Promise<ExecutionResult> {
    return this.spawnCommand(cmd, args, code, workingDir, timeout);
  }

  /**
   * Execute Python code with matplotlib support.
   * Injects a preamble that forces Agg backend and wraps plt.savefig()
   * to capture the figure as base64 PNG.
   */
  private async executePythonMatplotlib(
    cmd: string,
    code: string,
    workingDir: string,
    timeout: number,
  ): Promise<ExecutionResult> {
    const tmpPng = path.join(os.tmpdir(), `mpe_matplotlib_${Date.now()}.png`);
    const preamble = `
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
`;
    const postamble = `
import base64 as __mpe_b64
plt.savefig('${tmpPng.replace(/\\/g, '\\\\')}', bbox_inches='tight', dpi=150)
with open('${tmpPng.replace(/\\/g, '\\\\')}', 'rb') as __mpe_f:
    __mpe_data = __mpe_b64.b64encode(__mpe_f.read()).decode('ascii')
    print('__MPE_PNG_BASE64__' + __mpe_data + '__MPE_PNG_BASE64_END__')
plt.close('all')
`;

    const fullCode = preamble + code + postamble;
    const tmpFile = path.join(os.tmpdir(), `mpe_matplotlib_${Date.now()}.py`);

    try {
      fs.writeFileSync(tmpFile, fullCode, 'utf-8');
      const result = await this.spawnCommand(
        cmd,
        [tmpFile],
        '',
        workingDir,
        timeout,
      );

      // Extract base64 PNG from stdout
      const pngMatch = result.stdout.match(
        /__MPE_PNG_BASE64__(.+?)__MPE_PNG_BASE64_END__/,
      );
      if (pngMatch) {
        // Replace the marker with the actual base64 data; the manager will handle rendering
        result.stdout = pngMatch[1];
      }

      return result;
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(tmpPng);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Execute LaTeX code. Writes to temp .tex, runs latex engine,
   * attempts to produce SVG or PNG output.
   */
  private async executeLatex(
    code: string,
    workingDir: string,
    attrs: CodeChunk['attrs'],
    timeout: number,
  ): Promise<ExecutionResult> {
    const engine = attrs.latex_engine || 'pdflatex';
    const tmpDir = path.join(os.tmpdir(), `mpe_latex_${Date.now()}`);
    const tmpTex = path.join(tmpDir, 'input.tex');
    const tmpPdf = path.join(tmpDir, 'input.pdf');

    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(tmpTex, code, 'utf-8');

      // Run LaTeX engine
      const latexResult = await this.spawnCommand(
        engine,
        ['-interaction=nonstopmode', `-output-directory=${tmpDir}`, tmpTex],
        '',
        workingDir,
        timeout,
      );

      if (latexResult.exitCode !== 0) {
        return latexResult;
      }

      // Try to convert PDF to SVG using pdf2svg
      const tmpSvg = path.join(tmpDir, 'output.svg');
      const svgResult = await this.spawnCommand(
        'pdf2svg',
        [tmpPdf, tmpSvg],
        '',
        workingDir,
        10000,
      );

      if (svgResult.exitCode === 0 && fs.existsSync(tmpSvg)) {
        let svgContent = fs.readFileSync(tmpSvg, 'utf-8');
        const zoom = attrs.latex_zoom || 1;
        const width = attrs.latex_width || '';
        const height = attrs.latex_height || '';

        if (zoom !== 1) {
          svgContent = svgContent.replace(
            /<svg /,
            `<svg style="transform: scale(${zoom});" `,
          );
        }
        if (width) {
          svgContent = svgContent.replace(/<svg /, `<svg width="${width}" `);
        }
        if (height) {
          svgContent = svgContent.replace(/<svg /, `<svg height="${height}" `);
        }

        return { stdout: svgContent, stderr: '', exitCode: 0 };
      }

      // Fallback: if pdf2svg not available, convert PDF to base64 for embedding
      if (fs.existsSync(tmpPdf)) {
        const pdfData = fs.readFileSync(tmpPdf);
        const base64 = pdfData.toString('base64');
        return {
          stdout: `__MPE_PDF_BASE64__${base64}`,
          stderr:
            svgResult.stderr || 'pdf2svg not found, falling back to PDF embed',
          exitCode: 0,
        };
      }

      return {
        stdout: '',
        stderr: 'LaTeX compilation produced no output.',
        exitCode: 1,
      };
    } finally {
      // Cleanup temp directory
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  /**
   * Spawn a command and collect stdout/stderr with timeout.
   */
  private spawnCommand(
    cmd: string,
    args: string[],
    stdinData: string,
    cwd: string,
    timeout: number,
  ): Promise<ExecutionResult> {
    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';

      const proc = spawn(cmd, args, {
        cwd,
        shell: true,
        timeout,
        env: { ...process.env },
      });

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => {
        resolve({ stdout, stderr: `${stderr}\n${err.message}`, exitCode: 1 });
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code });
      });

      if (stdinData) {
        proc.stdin?.write(stdinData);
        proc.stdin?.end();
      }
    });
  }
}

/**
 * CodeChunkSession - Persistent process sessions for `continue` chains.
 *
 * When a code chunk uses `continue=true` or `continue="id"`, it shares
 * a persistent REPL process so that variables/state carry across chunks.
 */

import { type ChildProcess, spawn } from 'node:child_process';

interface Session {
  process: ChildProcess;
  language: string;
  cwd: string;
}

/**
 * Builds a language-specific echo command that prints a delimiter string.
 * Used to detect when a code chunk's output ends in the persistent session.
 */
function buildDelimiterEcho(language: string, delimiter: string): string {
  switch (language) {
    case 'python':
    case 'python3':
      return `\nprint("${delimiter}")\n`;
    case 'javascript':
    case 'node':
      return `\nconsole.log("${delimiter}");\n`;
    case 'ruby':
      return `\nputs "${delimiter}"\n`;
    case 'bash':
    case 'sh':
    case 'zsh':
      return `\necho "${delimiter}"\n`;
    case 'php':
      return `\necho "${delimiter}\\n";\n`;
    case 'perl':
      return `\nprint "${delimiter}\\n";\n`;
    case 'r':
    case 'R':
      return `\ncat("${delimiter}\\n")\n`;
    default:
      return `\necho "${delimiter}"\n`;
  }
}

export class CodeChunkSession {
  private sessions: Map<string, Session> = new Map();

  /**
   * Get or create a persistent session for a given language and session ID.
   */
  getOrCreateSession(
    language: string,
    sessionId: string,
    cwd: string,
  ): Session {
    const key = `${language}:${sessionId}`;
    let session = this.sessions.get(key);
    if (session && !session.process.killed) {
      return session;
    }

    // Determine the command for the REPL process
    const cmd = this.getInterpreterCommand(language);
    const proc = spawn(cmd, [], {
      cwd,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    session = { process: proc, language, cwd };
    this.sessions.set(key, session);

    proc.on('exit', () => {
      this.sessions.delete(key);
    });

    return session;
  }

  /**
   * Send code to a persistent session and wait for output.
   * Returns stdout collected up to a delimiter marker.
   */
  sendCode(
    language: string,
    sessionId: string,
    code: string,
    cwd: string,
    timeout: number,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, _reject) => {
      const session = this.getOrCreateSession(language, sessionId, cwd);
      const proc = session.process;
      const delimiter = `__MPE_SESSION_END__${Date.now()}_${Math.random()
        .toString(36)
        .slice(2)}`;

      let stdout = '';
      let stderr = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve({ stdout, stderr: `${stderr}\n[Timeout]` });
        }
      }, timeout);

      const onStdout = (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        const delimIdx = stdout.indexOf(delimiter);
        if (delimIdx !== -1) {
          clearTimeout(timer);
          if (!settled) {
            settled = true;
            proc.stdout?.off('data', onStdout);
            proc.stderr?.off('data', onStderr);
            resolve({ stdout: stdout.substring(0, delimIdx), stderr });
          }
        }
      };

      const onStderr = (data: Buffer) => {
        stderr += data.toString();
      };

      proc.stdout?.on('data', onStdout);
      proc.stderr?.on('data', onStderr);

      // Write code followed by delimiter echo
      const codeWithDelimiter = code + buildDelimiterEcho(language, delimiter);
      proc.stdin?.write(codeWithDelimiter);
    });
  }

  /**
   * Determine the interpreter command for a language.
   */
  private getInterpreterCommand(language: string): string {
    const map: Record<string, string> = {
      python: 'python3',
      python3: 'python3',
      javascript: 'node',
      node: 'node',
      ruby: 'irb --noecho',
      bash: 'bash',
      sh: 'sh',
      zsh: 'zsh',
      php: 'php -a',
      perl: 'perl',
      r: 'R --no-save --quiet',
      R: 'R --no-save --quiet',
    };
    return map[language] || language;
  }

  /**
   * Kill all persistent sessions and clean up.
   */
  dispose(): void {
    for (const [, session] of this.sessions) {
      try {
        session.process.kill();
      } catch {
        // ignore
      }
    }
    this.sessions.clear();
  }
}

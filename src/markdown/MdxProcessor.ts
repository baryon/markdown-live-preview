/**
 * MDX Processor - Evaluates JSX expressions and renders JSX to HTML
 * before markdown-it processes the content.
 *
 * Pipeline: protectCodeBlocks → extractExports → processJsxHtmlBlocks
 *           → processBlockExpressions → processInlineExpressions → restoreCodeBlocks
 */

import { transform } from 'sucrase';

// Virtual DOM node produced by mock createElement
interface VNode {
  type: string;
  props: Record<string, unknown> | null;
  children: unknown[];
}

// HTML void elements that cannot have children
const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Mock createElement that builds a virtual DOM tree
 */
function mdxCreateElement(
  type: string | ((...args: unknown[]) => unknown),
  props: Record<string, unknown> | null,
  ...children: unknown[]
): VNode | string {
  // If type is a function component, call it
  if (typeof type === 'function') {
    try {
      const result = type({
        ...props,
        children: children.length === 1 ? children[0] : children,
      });
      return result as VNode | string;
    } catch {
      return '';
    }
  }
  return { type: type as string, props, children: children.flat() };
}

/**
 * Convert camelCase CSS property to kebab-case
 */
function camelToKebab(str: string): string {
  return str.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Convert a style object to a CSS string
 */
function styleObjectToString(style: Record<string, string | number>): string {
  return Object.entries(style)
    .map(([key, value]) => `${camelToKebab(key)}: ${value}`)
    .join('; ');
}

/**
 * Convert props to HTML attribute string
 */
function propsToAttributes(props: Record<string, unknown> | null): string {
  if (!props) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(props)) {
    // Skip React-specific props
    if (key === 'key' || key === 'ref' || key === 'children') continue;

    if (key === 'className') {
      parts.push(`class="${escapeAttr(String(value))}"`);
    } else if (key === 'htmlFor') {
      parts.push(`for="${escapeAttr(String(value))}"`);
    } else if (key === 'style' && typeof value === 'object' && value !== null) {
      parts.push(
        `style="${escapeAttr(styleObjectToString(value as Record<string, string | number>))}"`,
      );
    } else if (key === 'dangerouslySetInnerHTML') {
    } else if (typeof value === 'boolean') {
      if (value) parts.push(key);
    } else if (value != null) {
      parts.push(`${key}="${escapeAttr(String(value))}"`);
    }
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert a virtual DOM node to an HTML string
 */
function elementToHtml(node: unknown): string {
  // Falsy values render as empty
  if (node == null || node === false || node === true) return '';

  // Primitives render as text
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);

  // Arrays render as concatenated children
  if (Array.isArray(node)) return node.map(elementToHtml).join('');

  // VNode
  if (typeof node === 'object' && 'type' in node) {
    const vnode = node as VNode;
    const attrs = propsToAttributes(vnode.props);

    // Handle dangerouslySetInnerHTML
    if (vnode.props?.dangerouslySetInnerHTML) {
      const inner =
        (vnode.props.dangerouslySetInnerHTML as { __html: string }).__html ||
        '';
      return `<${vnode.type}${attrs}>${inner}</${vnode.type}>`;
    }

    if (VOID_ELEMENTS.has(vnode.type)) {
      return `<${vnode.type}${attrs} />`;
    }

    const childHtml = vnode.children.map(elementToHtml).join('');
    return `<${vnode.type}${attrs}>${childHtml}</${vnode.type}>`;
  }

  return String(node);
}

/**
 * Evaluate a JS expression with the given scope variables
 */
function evaluateExpression(
  expr: string,
  scope: Record<string, unknown>,
): unknown {
  const scopeKeys = Object.keys(scope);
  const scopeValues = scopeKeys.map((k) => scope[k]);

  try {
    const fn = new Function(
      ...scopeKeys,
      '__mdx_createElement',
      `return (${expr})`,
    );
    return fn(...scopeValues, mdxCreateElement);
  } catch {
    return undefined;
  }
}

/**
 * Transpile JSX code to createElement calls using sucrase
 */
function transpileJsx(code: string): string | null {
  try {
    const result = transform(code, {
      transforms: ['jsx'],
      jsxPragma: '__mdx_createElement',
      jsxFragmentPragma: '__mdx_Fragment',
      production: true,
    });
    return result.code;
  } catch {
    return null;
  }
}

/**
 * Check if braces are balanced in a string
 */
function areBracesBalanced(str: string): boolean {
  let depth = 0;
  let inString: string | null = null;
  let isEscaped = false;

  for (const ch of str) {
    if (isEscaped) {
      isEscaped = false;
      continue;
    }
    if (ch === '\\') {
      isEscaped = true;
      continue;
    }
    if (inString) {
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
  }
  return depth === 0;
}

export interface MdxResult {
  content: string;
}

export class MdxProcessor {
  private codeBlockPlaceholders: Map<string, string> = new Map();
  private placeholderCounter = 0;

  /**
   * Process MDX content: evaluate exports, JSX blocks, and expressions
   */
  process(content: string): MdxResult {
    let result = content;

    // Phase 0: Protect code blocks and inline code from processing
    result = this.protectCodeBlocks(result);

    // Phase 1: Extract and evaluate exports, build scope
    const { content: afterExports, scope } = this.extractExports(result);
    result = afterExports;

    // Phase 2: Process JSX/HTML blocks with style={{...}} and className
    result = this.processJsxHtmlBlocks(result, scope);

    // Phase 3: Process block-level expressions (multi-line {expr} on own lines)
    result = this.processBlockExpressions(result, scope);

    // Phase 4: Process inline expressions ({expr} within text)
    result = this.processInlineExpressions(result, scope);

    // Phase 5: Restore code blocks
    result = this.restoreCodeBlocks(result);

    return { content: result };
  }

  /**
   * Phase 0: Replace fenced code blocks and inline code with placeholders
   */
  private protectCodeBlocks(content: string): string {
    // Protect fenced code blocks (``` ... ```)
    content = content.replace(/^(`{3,})[^\n]*\n[\s\S]*?\n\1\s*$/gm, (match) => {
      return this.addPlaceholder(match);
    });

    // Protect inline code (` ... `)
    content = content.replace(/`[^`\n]+`/g, (match) => {
      return this.addPlaceholder(match);
    });

    return content;
  }

  private addPlaceholder(original: string): string {
    const id = `__MDX_PLACEHOLDER_${this.placeholderCounter++}__`;
    this.codeBlockPlaceholders.set(id, original);
    return id;
  }

  /**
   * Phase 5: Restore all placeholders with original content
   */
  private restoreCodeBlocks(content: string): string {
    for (const [id, original] of this.codeBlockPlaceholders) {
      content = content.replace(id, original);
    }
    return content;
  }

  /**
   * Phase 1: Extract `export const/let/var` declarations, evaluate them into scope
   */
  private extractExports(content: string): {
    content: string;
    scope: Record<string, unknown>;
  } {
    const scope: Record<string, unknown> = {};
    const lines = content.split('\n');
    const outputLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const exportMatch = line.match(
        /^export\s+(const|let|var)\s+(\w+)\s*=\s*(.*)/,
      );

      if (exportMatch) {
        const varName = exportMatch[2];
        let valueStr = exportMatch[3];

        // Handle multi-line values by brace-balancing
        if (!areBracesBalanced(valueStr)) {
          i++;
          while (i < lines.length && !areBracesBalanced(valueStr)) {
            valueStr += `\n${lines[i]}`;
            i++;
          }
        }

        // Evaluate the value with current scope
        const value = evaluateExpression(valueStr, scope);
        if (value !== undefined) {
          scope[varName] = value;
        }

        // Remove the export line(s) from output
        i++;
        continue;
      }

      outputLines.push(line);
      i++;
    }

    return { content: outputLines.join('\n'), scope };
  }

  /**
   * Phase 2: Process JSX-style HTML blocks that have style={{}} or className=
   * Convert them to valid HTML that markdown-it can handle
   */
  private processJsxHtmlBlocks(
    content: string,
    scope: Record<string, unknown>,
  ): string {
    // Match HTML blocks that contain JSX-style attributes (style={{...}}, className=)
    // These are multi-line HTML blocks starting with < on their own line
    const lines = content.split('\n');
    const outputLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Detect start of a JSX-style HTML block
      // Must start with < and contain JSX indicators like style={{ or className
      if (this.isJsxHtmlBlockStart(line)) {
        // Collect the full block
        let block = line;
        let openTags = this.countOpenAngleBrackets(line);
        const startI = i;
        i++;

        while (i < lines.length && openTags > 0) {
          block += `\n${lines[i]}`;
          openTags += this.countOpenAngleBrackets(lines[i]);
          i++;
        }

        // Check if the block actually contains JSX syntax
        if (this.hasJsxSyntax(block)) {
          const html = this.transpileJsxBlock(block, scope);
          if (html !== null) {
            outputLines.push(html);
            continue;
          }
        }

        // Fallback: push original lines
        for (let j = startI; j < i; j++) {
          outputLines.push(lines[j]);
        }
        continue;
      }

      outputLines.push(line);
      i++;
    }

    return outputLines.join('\n');
  }

  /**
   * Check if a line starts a JSX-style HTML block
   */
  private isJsxHtmlBlockStart(line: string): boolean {
    const trimmed = line.trim();
    // Must start with < and a tag name
    return /^<[a-zA-Z]/.test(trimmed);
  }

  /**
   * Count net open angle brackets for tag balancing
   * Returns +1 for opening tags, -1 for closing tags, 0 for self-closing
   */
  private countOpenAngleBrackets(line: string): number {
    let count = 0;
    // Count opening tags (not self-closing, not closing)
    const openTags = line.match(/<[a-zA-Z][^>]*(?<!\/)>/g);
    if (openTags) count += openTags.length;
    // Count closing tags
    const closeTags = line.match(/<\/[a-zA-Z][^>]*>/g);
    if (closeTags) count -= closeTags.length;
    // Count self-closing tags (subtract since they also matched opening)
    const selfClose = line.match(/<[a-zA-Z][^>]*\/>/g);
    if (selfClose) count -= selfClose.length;
    return count;
  }

  /**
   * Check if a block contains JSX-specific syntax
   */
  private hasJsxSyntax(block: string): boolean {
    return (
      /style\s*=\s*\{\{/.test(block) ||
      /className\s*=/.test(block) ||
      /htmlFor\s*=/.test(block) ||
      /\{[^}]*\.map\s*\(/.test(block) ||
      /\{[^}]*\?\s*/.test(block) ||
      /\{[^}]*&&/.test(block)
    );
  }

  /**
   * Transpile a JSX block to HTML via sucrase + mock createElement
   */
  private transpileJsxBlock(
    block: string,
    scope: Record<string, unknown>,
  ): string | null {
    // Wrap in a fragment for sucrase to parse
    const wrappedCode = `(${block})`;

    const transpiled = transpileJsx(wrappedCode);
    if (!transpiled) return null;

    const result = evaluateExpression(transpiled, scope);
    if (result === undefined) return null;

    return elementToHtml(result);
  }

  /**
   * Phase 3: Process block-level expressions — {expr} that appear on their own lines
   * These often span multiple lines (e.g., .map() calls, conditionals)
   */
  private processBlockExpressions(
    content: string,
    scope: Record<string, unknown>,
  ): string {
    const lines = content.split('\n');
    const outputLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check for block expression starting with { on its own line
      if (
        trimmed.startsWith('{') &&
        !this.isHeadingAttr(trimmed) &&
        !this.isPlaceholder(trimmed)
      ) {
        // Collect lines until braces balance
        let expr = trimmed;
        const startI = i;
        i++;

        while (i < lines.length && !areBracesBalanced(expr)) {
          expr += `\n${lines[i].trim()}`;
          i++;
        }

        // Only process if it's a full block expression (starts with { and ends with })
        if (expr.startsWith('{') && expr.endsWith('}')) {
          // Extract the inner expression (remove outer braces)
          const innerExpr = expr.slice(1, -1).trim();

          // Transpile JSX in the expression if present
          const transpiled = transpileJsx(`(${innerExpr})`);
          const exprToEval = transpiled
            ? transpiled
                .replace(/^[\s\S]*?return\s*\(/, '(')
                .replace(/\);\s*$/, ')')
            : innerExpr;

          // Clean up sucrase output: remove trailing semicolons
          const cleanExpr = exprToEval.replace(/;\s*$/, '');

          const result = evaluateExpression(cleanExpr, scope);
          if (result !== undefined) {
            const html = elementToHtml(result);
            if (html) {
              outputLines.push(html);
              continue;
            }
          }

          // Fallback: output original lines
          for (let j = startI; j < i; j++) {
            outputLines.push(lines[j]);
          }
          continue;
        }

        // Not a complete block expression, restore lines
        for (let j = startI; j < i; j++) {
          outputLines.push(lines[j]);
        }
        continue;
      }

      outputLines.push(line);
      i++;
    }

    return outputLines.join('\n');
  }

  /**
   * Phase 4: Process inline expressions — {expr} within text lines
   */
  private processInlineExpressions(
    content: string,
    scope: Record<string, unknown>,
  ): string {
    // Match {expr} patterns that are not heading attributes and not inside placeholders
    return content.replace(/\{([^{}]+)\}/g, (match, expr) => {
      // Skip heading attributes like {#id} or {.class}
      if (/^[#.]\w/.test(expr.trim())) return match;

      // Skip if this looks like a placeholder
      if (match.includes('__MDX_PLACEHOLDER_')) return match;

      // Try to evaluate
      const result = evaluateExpression(expr.trim(), scope);
      if (result === undefined) return match;

      return elementToHtml(result);
    });
  }

  /**
   * Check if a {expr} is a heading attribute like {#id} or {.class}
   */
  private isHeadingAttr(text: string): boolean {
    return /^\{[#.]\w/.test(text);
  }

  /**
   * Check if text is a placeholder we inserted
   */
  private isPlaceholder(text: string): boolean {
    return text.includes('__MDX_PLACEHOLDER_');
  }
}

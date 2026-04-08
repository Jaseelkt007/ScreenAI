'use strict';

/**
 * markdown.js — Lightweight Markdown → safe HTML renderer.
 *
 * Supports:
 *   Block  — headings (#/##/###), fenced code blocks, bullet lists,
 *            ordered lists, blockquotes, horizontal rules, paragraphs,
 *            display math via $$...$$ or \[...\].
 *   Inline — bold (**), italic (*), inline code (`), links, and
 *            inline math via $...$ or \(...\).
 *
 * Security: all non-code text is HTML-escaped before inline processing.
 *           URLs are protocol-checked before link rendering.
 */

(function () {
  const MATH_COMMANDS = {
    alpha: 'α',
    beta: 'β',
    gamma: 'γ',
    delta: 'δ',
    epsilon: 'ϵ',
    theta: 'θ',
    lambda: 'λ',
    mu: 'μ',
    pi: 'π',
    sigma: 'σ',
    phi: 'φ',
    omega: 'ω',
    Gamma: 'Γ',
    Delta: 'Δ',
    Theta: 'Θ',
    Lambda: 'Λ',
    Pi: 'Π',
    Sigma: 'Σ',
    Phi: 'Φ',
    Omega: 'Ω',
    cdot: '·',
    times: '×',
    pm: '±',
    neq: '≠',
    leq: '≤',
    geq: '≥',
    approx: '≈',
    to: '→',
    rightarrow: '→',
    leftarrow: '←',
    infty: '∞',
    sum: '∑',
    prod: '∏',
    int: '∫',
    partial: '∂',
    forall: '∀',
    exists: '∃',
    in: '∈',
    notin: '∉',
    subset: '⊂',
    subseteq: '⊆',
    supset: '⊃',
    supseteq: '⊇',
    cup: '∪',
    cap: '∩',
    land: '∧',
    lor: '∨',
    degree: '°',
  };

  function renderMarkdown(raw) {
    if (!raw || !raw.trim()) return '';

    const codeBlocks = [];
    let text = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push({ lang: lang || '', code });
      return `\x00B${codeBlocks.length - 1}\x00`;
    });

    const mathBlocks = [];
    text = text
      .replace(/\$\$([\s\S]*?)\$\$/g, (_, expr) => {
        mathBlocks.push(expr);
        return `\x00M${mathBlocks.length - 1}\x00`;
      })
      .replace(/\\\[([\s\S]*?)\\\]/g, (_, expr) => {
        mathBlocks.push(expr);
        return `\x00M${mathBlocks.length - 1}\x00`;
      });

    const lines = text.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      const blockMath = line.match(/^\x00M(\d+)\x00$/);
      if (blockMath) {
        html += renderMath(mathBlocks[+blockMath[1]], true);
        i++;
        continue;
      }

      const blockCode = line.match(/^\x00B(\d+)\x00$/);
      if (blockCode) {
        const { lang, code } = codeBlocks[+blockCode[1]];
        const escapedCode = esc(code.trimEnd());
        const badge = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
        html += `<pre class="code-block">${badge}<code>${escapedCode}</code></pre>`;
        i++;
        continue;
      }

      const heading = line.match(/^(#{1,3})\s+(.+)/);
      if (heading) {
        const level = heading[1].length;
        html += `<h${level}>${inline(heading[2])}</h${level}>`;
        i++;
        continue;
      }

      if (/^[-*_]{3,}\s*$/.test(line.trim())) {
        html += '<hr>';
        i++;
        continue;
      }

      if (/^>\s?/.test(line)) {
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          quoteLines.push(inline(lines[i].replace(/^>\s?/, '')));
          i++;
        }
        html += `<blockquote>${quoteLines.join('<br>')}</blockquote>`;
        continue;
      }

      if (/^[-*+]\s/.test(line)) {
        html += '<ul>';
        while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^[-*+]\s/, ''))}</li>`;
          i++;
        }
        html += '</ul>';
        continue;
      }

      if (/^\d+\.\s/.test(line)) {
        html += '<ol>';
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^\d+\.\s/, ''))}</li>`;
          i++;
        }
        html += '</ol>';
        continue;
      }

      if (line.trim() === '') {
        i++;
        continue;
      }

      const paragraphLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(#{1,3}\s|[-*+]\s|\d+\.\s|>\s?|[-*_]{3,}\s*$|\x00[BM])/.test(lines[i])
      ) {
        paragraphLines.push(lines[i]);
        i++;
      }

      if (paragraphLines.length) {
        html += `<p>${paragraphLines.map(inline).join('<br>')}</p>`;
      }
    }

    return html;
  }

  function inline(text) {
    const codeSpans = [];
    const links = [];
    const mathSpans = [];

    text = text.replace(/`([^`]+)`/g, (_, code) => {
      codeSpans.push(`<code>${esc(code)}</code>`);
      return `\x01C${codeSpans.length - 1}\x01`;
    });

    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => {
      const safeUrl = sanitizeUrl(url);
      if (!safeUrl) return label;
      links.push(`<a href="${escAttr(safeUrl)}" target="_blank" rel="noreferrer noopener">${esc(label)}</a>`);
      return `\x01L${links.length - 1}\x01`;
    });

    text = extractInlineMath(text, mathSpans);
    text = esc(text);

    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*\s][^*]*?[^*\s]|\S)\*/g, '<em>$1</em>');

    text = text.replace(/\x01L(\d+)\x01/g, (_, n) => links[+n]);
    text = text.replace(/\x01M(\d+)\x01/g, (_, n) => mathSpans[+n]);
    text = text.replace(/\x01C(\d+)\x01/g, (_, n) => codeSpans[+n]);

    return text;
  }

  function extractInlineMath(text, sink) {
    let out = '';
    let i = 0;

    while (i < text.length) {
      if (text.startsWith('\\(', i)) {
        const end = text.indexOf('\\)', i + 2);
        if (end !== -1) {
          sink.push(renderMath(text.slice(i + 2, end), false));
          out += `\x01M${sink.length - 1}\x01`;
          i = end + 2;
          continue;
        }
      }

      if (text[i] === '$' && text[i + 1] !== '$') {
        let end = i + 1;
        while (end < text.length) {
          if (text[end] === '$' && text[end - 1] !== '\\') break;
          if (text[end] === '\n') { end = -1; break; }
          end++;
        }
        if (end > i + 1) {
          sink.push(renderMath(text.slice(i + 1, end), false));
          out += `\x01M${sink.length - 1}\x01`;
          i = end + 1;
          continue;
        }
      }

      out += text[i];
      i++;
    }

    return out;
  }

  function renderMath(expr, displayMode) {
    const inner = renderMathMarkup(String(expr || '').trim());
    if (displayMode) {
      return `<div class="math-block"><span class="math-render">${inner}</span></div>`;
    }
    return `<span class="math-inline"><span class="math-render">${inner}</span></span>`;
  }

  function renderMathMarkup(raw) {
    const tokens = [];
    const stash = (html) => {
      tokens.push(html);
      return `\x02T${tokens.length - 1}\x02`;
    };

    let text = String(raw || '').trim();
    text = text.replace(/\\left/g, '').replace(/\\right/g, '');

    text = replaceCommandWithArgs(text, 'frac', 2, (num, den) =>
      stash(
        `<span class="math-frac"><span class="math-frac-num">${renderMathMarkup(num)}</span><span class="math-frac-den">${renderMathMarkup(den)}</span></span>`
      )
    );

    text = replaceCommandWithArgs(text, 'sqrt', 1, (value) =>
      stash(
        `<span class="math-sqrt"><span class="math-radical">√</span><span class="math-radicand">${renderMathMarkup(value)}</span></span>`
      )
    );

    text = replaceCommandWithArgs(text, 'text', 1, (value) =>
      stash(`<span class="math-text">${esc(value)}</span>`)
    );

    text = replaceCommandWithArgs(text, 'mathrm', 1, (value) =>
      stash(`<span class="math-text">${esc(value)}</span>`)
    );

    text = text.replace(/\^\{([^{}]+)\}/g, (_, exp) => stash(`<sup>${renderMathMarkup(exp)}</sup>`));
    text = text.replace(/_\{([^{}]+)\}/g, (_, sub) => stash(`<sub>${renderMathMarkup(sub)}</sub>`));
    text = text.replace(/\^([A-Za-z0-9+\-=/()])/g, (_, exp) => stash(`<sup>${renderMathMarkup(exp)}</sup>`));
    text = text.replace(/_([A-Za-z0-9+\-=/()])/g, (_, sub) => stash(`<sub>${renderMathMarkup(sub)}</sub>`));

    text = text.replace(/\\([A-Za-z]+)/g, (match, name) => MATH_COMMANDS[name] || match);
    text = text.replace(/\\([{}])/g, '$1');
    text = text.replace(/\\,/g, ' ').replace(/\\;/g, ' ').replace(/\\:/g, ' ').replace(/\\!/g, '');

    text = esc(text);
    text = text.replace(/\x02T(\d+)\x02/g, (_, n) => tokens[+n]);
    return text;
  }

  function replaceCommandWithArgs(input, command, argCount, render) {
    const marker = `\\${command}`;
    let text = input;
    let changed = true;

    while (changed) {
      changed = false;
      let out = '';
      let i = 0;

      while (i < text.length) {
        const idx = text.indexOf(marker, i);
        if (idx === -1) {
          out += text.slice(i);
          break;
        }

        out += text.slice(i, idx);
        let cursor = idx + marker.length;
        const args = [];
        let ok = true;

        for (let n = 0; n < argCount; n++) {
          while (cursor < text.length && /\s/.test(text[cursor])) cursor++;
          const group = readBracedGroup(text, cursor);
          if (!group) {
            ok = false;
            break;
          }
          args.push(group.content);
          cursor = group.end;
        }

        if (!ok) {
          out += marker;
          i = idx + marker.length;
          continue;
        }

        out += render(...args);
        i = cursor;
        changed = true;
      }

      text = out;
    }

    return text;
  }

  function readBracedGroup(text, start) {
    if (text[start] !== '{') return null;

    let depth = 0;
    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (char === '{') depth++;
      if (char === '}') {
        depth--;
        if (depth === 0) {
          return {
            content: text.slice(start + 1, i),
            end: i + 1,
          };
        }
      }
    }

    return null;
  }

  function sanitizeUrl(url) {
    const value = String(url || '').trim();
    if (!value) return null;
    if (/^(https?:|mailto:)/i.test(value)) return value;
    return null;
  }

  function esc(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function escAttr(value) {
    return esc(value).replace(/'/g, '&#39;');
  }

  window.renderMarkdown = renderMarkdown;
})();

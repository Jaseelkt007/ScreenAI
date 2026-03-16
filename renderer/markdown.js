'use strict';

/**
 * markdown.js — Lightweight Markdown → safe HTML renderer.
 *
 * Supports:
 *   Block  — headings (#/##/###), fenced code blocks (```), bullet lists,
 *            ordered lists, blockquotes, horizontal rules, paragraphs.
 *   Inline — bold (**), italic (*), inline code (`), bold+italic (***).
 *
 * Security: all non-code text is HTML-escaped before inline processing.
 *           Code content is always escaped.
 */

(function () {

  function renderMarkdown(raw) {
    if (!raw || !raw.trim()) return '';

    // ── 1. Extract fenced code blocks ────────────────────────────────────
    // Replace them with sentinel tokens so block content is never processed
    // by heading / list / inline rules.
    const codeBlocks = [];
    const text = raw.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      codeBlocks.push({ lang: lang || '', code });
      return `\x00B${codeBlocks.length - 1}\x00`;
    });

    // ── 2. Block-level parsing ────────────────────────────────────────────
    const lines = text.split('\n');
    let html = '';
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // ── Code block sentinel ─────────────────────────────────────────────
      const bm = line.match(/^\x00B(\d+)\x00$/);
      if (bm) {
        const { lang, code } = codeBlocks[+bm[1]];
        const escapedCode = esc(code.trimEnd());
        const badge = lang ? `<span class="code-lang">${esc(lang)}</span>` : '';
        html += `<pre class="code-block">${badge}<code>${escapedCode}</code></pre>`;
        i++; continue;
      }

      // ── Headings ────────────────────────────────────────────────────────
      const hm = line.match(/^(#{1,3})\s+(.+)/);
      if (hm) {
        const lvl = hm[1].length;
        html += `<h${lvl}>${inline(hm[2])}</h${lvl}>`;
        i++; continue;
      }

      // ── Horizontal rule ─────────────────────────────────────────────────
      if (/^[-*_]{3,}\s*$/.test(line.trim())) {
        html += '<hr>';
        i++; continue;
      }

      // ── Blockquote ──────────────────────────────────────────────────────
      if (/^>\s?/.test(line)) {
        const bqLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) {
          bqLines.push(inline(lines[i].replace(/^>\s?/, '')));
          i++;
        }
        html += `<blockquote>${bqLines.join('<br>')}</blockquote>`;
        continue;
      }

      // ── Unordered list ──────────────────────────────────────────────────
      if (/^[-*+]\s/.test(line)) {
        html += '<ul>';
        while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^[-*+]\s/, ''))}</li>`;
          i++;
        }
        html += '</ul>';
        continue;
      }

      // ── Ordered list ────────────────────────────────────────────────────
      if (/^\d+\.\s/.test(line)) {
        html += '<ol>';
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          html += `<li>${inline(lines[i].replace(/^\d+\.\s/, ''))}</li>`;
          i++;
        }
        html += '</ol>';
        continue;
      }

      // ── Blank line ──────────────────────────────────────────────────────
      if (line.trim() === '') { i++; continue; }

      // ── Paragraph ───────────────────────────────────────────────────────
      // Collect consecutive "normal" lines until a blank line or a block element.
      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== '' &&
        !/^(#{1,3}\s|[-*+]\s|\d+\.\s|>\s?|[-*_]{3,}\s*$|\x00B)/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length) {
        html += `<p>${paraLines.map(inline).join('<br>')}</p>`;
      }
    }

    return html;
  }

  // ── Inline formatting ────────────────────────────────────────────────────

  function inline(text) {
    // Protect inline code spans before escaping.
    const spans = [];
    text = text.replace(/`([^`]+)`/g, (_, code) => {
      spans.push(`<code>${esc(code)}</code>`);
      return `\x01S${spans.length - 1}\x01`;
    });

    // Escape HTML in all non-code text.
    text = esc(text);

    // Bold + italic (***text***)
    text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    // Bold (**text** or __text__)
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__(.+?)__/g,       '<strong>$1</strong>');
    // Italic — only * to avoid false-positives on snake_case identifiers
    text = text.replace(/\*([^*\s][^*]*?[^*\s]|\S)\*/g, '<em>$1</em>');

    // Restore inline code spans.
    text = text.replace(/\x01S(\d+)\x01/g, (_, n) => spans[+n]);

    return text;
  }

  // ── HTML escape ──────────────────────────────────────────────────────────

  function esc(s) {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  window.renderMarkdown = renderMarkdown;

})();

'use strict';

const removeMarkdown = require('remove-markdown');

const HTML_ENTITIES = new Map([
  ['amp', '&'],
  ['apos', "'"],
  ['gt', '>'],
  ['lt', '<'],
  ['nbsp', ' '],
  ['quot', '"'],
]);

function decodeHtmlEntity(match, entity) {
  if (entity.startsWith('#x') || entity.startsWith('#X')) {
    const value = Number.parseInt(entity.slice(2), 16);
    return Number.isFinite(value) ? String.fromCodePoint(value) : match;
  }
  if (entity.startsWith('#')) {
    const value = Number.parseInt(entity.slice(1), 10);
    return Number.isFinite(value) ? String.fromCodePoint(value) : match;
  }
  return HTML_ENTITIES.get(entity.toLowerCase()) ?? match;
}

function markdownToPlainText(markdown) {
  return removeMarkdown(String(markdown || ''), {
    gfm: true,
    replaceLinksWithURL: false,
    stripListLeaders: true,
    useImgAltText: true,
  })
    .replace(/\r\n?/gu, '\n')
    .replace(/^[ \t]*\|?(?:[ \t]*:?-{3,}:?[ \t]*\|)+[ \t]*$/gmu, '')
    .replace(/\|/gu, ', ')
    .replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu, decodeHtmlEntity)
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

module.exports = {
  markdownToPlainText,
};

"use strict";

const COMPLETION_TRIGGER_KIND = {
  INVOKED: 1,
  TRIGGER_CHARACTER: 2,
  INCOMPLETE: 3,
};

const DEFAULT_TS_TRIGGER_CHARACTERS = new Set([".", "'", "\"", "`"]);

function getCompletionTriggerCharacter(context) {
  return context && typeof context.triggerCharacter === "string"
    ? context.triggerCharacter
    : "";
}

function isTypeScriptCompletionTriggerAllowed(context, options = {}) {
  if (!context || context.triggerKind !== COMPLETION_TRIGGER_KIND.TRIGGER_CHARACTER) {
    return true;
  }

  const triggerCharacter = getCompletionTriggerCharacter(context);
  if (DEFAULT_TS_TRIGGER_CHARACTERS.has(triggerCharacter)) {
    return true;
  }

  return triggerCharacter === "/" && !!options.allowPathLikeTrigger;
}

function clampOffset(value, textLength) {
  const normalizedValue = Number(value);
  if (!Number.isFinite(normalizedValue)) {
    return 0;
  }

  return Math.max(0, Math.min(textLength, normalizedValue));
}

function getJsWordRangeAtOffset(documentText, offset) {
  const text = String(documentText || "");
  const clampedOffset = clampOffset(offset, text.length);
  let start = clampedOffset;
  while (start > 0 && /[A-Za-z0-9_$]/.test(text[start - 1])) {
    start -= 1;
  }

  let end = clampedOffset;
  while (end < text.length && /[A-Za-z0-9_$]/.test(text[end])) {
    end += 1;
  }

  return { start, end };
}

function toDocumentRange(document, start, end) {
  return {
    start: document.positionAt(start),
    end: document.positionAt(end),
  };
}

function createStableCompletionTextEdit(document, documentText, offset, replacementSpan, newText) {
  if (!replacementSpan || typeof document.positionAt !== "function") {
    return null;
  }

  const text = String(documentText || "");
  const textLength = text.length;
  const spanStart = clampOffset(replacementSpan.start, textLength);
  const spanEnd = clampOffset(replacementSpan.end, textLength);
  if (spanEnd < spanStart) {
    return null;
  }

  const normalizedNewText = String(newText || "");
  const wordRange = getJsWordRangeAtOffset(text, offset);
  const textEdit = {
    range: toDocumentRange(document, spanStart, spanEnd),
    newText: normalizedNewText,
  };

  if (spanStart >= wordRange.start || wordRange.start > spanEnd) {
    return { textEdit, additionalTextEdits: undefined };
  }

  const prefixText = text.slice(spanStart, wordRange.start);
  if (!prefixText || !normalizedNewText.startsWith(prefixText)) {
    return { textEdit, additionalTextEdits: undefined };
  }

  return {
    textEdit: {
      range: toDocumentRange(document, wordRange.start, spanEnd),
      newText: normalizedNewText.slice(prefixText.length),
    },
    additionalTextEdits: [
      {
        range: toDocumentRange(document, spanStart, wordRange.start),
        newText: prefixText,
      },
    ],
  };
}

function shouldReuseLastCompletion(lastCompletion, request) {
  if (!lastCompletion || !lastCompletion.result || !request) {
    return false;
  }
  if (lastCompletion.uri !== request.uri || lastCompletion.version !== request.version) {
    return false;
  }
  if (request.triggerKind !== COMPLETION_TRIGGER_KIND.INCOMPLETE) {
    return false;
  }
  if (lastCompletion.result.isIncomplete === false) {
    return false;
  }
  if (lastCompletion.line !== request.line) {
    return false;
  }

  return Math.abs(lastCompletion.character - request.character) <= 2;
}

module.exports = {
  COMPLETION_TRIGGER_KIND,
  createStableCompletionTextEdit,
  getCompletionTriggerCharacter,
  getJsWordRangeAtOffset,
  isTypeScriptCompletionTriggerAllowed,
  shouldReuseLastCompletion,
};

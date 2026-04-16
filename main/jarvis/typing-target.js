'use strict';

/**
 * typing-target.js — one-shot storage for the external window that was active
 * before the Jarvis HUD was shown.
 *
 * Used only by input.type so we can restore focus immediately before SendKeys.
 */

let _pendingTypeTargetWindowHandle = null;

function normalizeWindowHandle(handle) {
  if (typeof handle !== 'string') return null;
  const value = handle.trim();
  if (!/^-?\d+$/.test(value) || value === '0') return null;
  return value;
}

function setPendingTypeTargetWindowHandle(handle) {
  _pendingTypeTargetWindowHandle = normalizeWindowHandle(handle);
}

function consumePendingTypeTargetWindowHandle() {
  const handle = _pendingTypeTargetWindowHandle;
  _pendingTypeTargetWindowHandle = null;
  return handle;
}

function clearPendingTypeTargetWindowHandle() {
  _pendingTypeTargetWindowHandle = null;
}

module.exports = {
  setPendingTypeTargetWindowHandle,
  consumePendingTypeTargetWindowHandle,
  clearPendingTypeTargetWindowHandle,
};

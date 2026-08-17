'use strict';

/**
 * Coordinates the renderer durability boundary before a downloaded update is
 * allowed to close application windows. Electron main supplies native-window
 * adapters; this module owns the all-or-nothing approval and rollback rule.
 */
function createUpdateWindowBarrier(options) {
  const {
    getWindows,
    isLiveWindow,
    shouldRequestFlush,
    requestFlush,
    approveClose,
    revokeCloseApproval,
    onBlocked = async () => {},
  } = options;
  const updateApprovedWindows = new Set();

  async function flushWindow(win) {
    if (!shouldRequestFlush(win)) return true;
    try {
      return await requestFlush(win) === true;
    } catch {
      return false;
    }
  }

  async function prepare() {
    const liveWindows = [...getWindows()].filter((win) => isLiveWindow(win));
    const results = await Promise.all(liveWindows.map((win) => flushWindow(win)));
    if (!results.every(Boolean)) {
      try {
        await onBlocked();
      } catch {
        // Failure presentation must not turn a recoverable save refusal into
        // an updater error. The downloaded update remains ready for retry.
      }
      return false;
    }

    for (const win of liveWindows) {
      approveClose(win);
      updateApprovedWindows.add(win);
    }
    return true;
  }

  function revoke() {
    for (const win of updateApprovedWindows) revokeCloseApproval(win);
    updateApprovedWindows.clear();
  }

  return { prepare, revoke };
}

module.exports = { createUpdateWindowBarrier };

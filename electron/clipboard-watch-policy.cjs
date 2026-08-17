'use strict';

function shouldOfferClipboardImage({ enabled, focused, composerFocused }) {
  return enabled === true && focused === true && composerFocused !== true;
}

module.exports = { shouldOfferClipboardImage };

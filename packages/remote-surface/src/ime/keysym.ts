// X11 keysym type. The canonical mapping table (browser KeyboardEvent →
// X11 keysym, with full handling of modifiers, lock keys, IME dead keys,
// and the OSK quirks across iOS/Android) lives in guacamole-common-js'
// Keyboard module:
//
//   https://github.com/apache/guacamole-client/blob/master/guacamole-common-js/src/main/webapp/modules/Keyboard.js
//
// When MobileTextInputController and the adapters are filled in, we will
// either:
//   (a) depend on guacamole-common-js and reuse its Keyboard.keysym table, or
//   (b) hand-port the subset of mappings PDPP needs (likely just printable
//       ASCII + Enter/Tab/Backspace/arrows/Escape), keeping the package
//       dependency-free.
//
// Decision deferred to the integration step.

export type Keysym = number;

/* ============================================================
 * namepolicy.js  the single public username rule.
 *
 * 20 characters max, ASCII letters/numbers, one space, one underscore.
 * Anything else is removed. Leading/trailing separators are trimmed.
 * The private relay applies the same rule; the client also enforces it
 * live on the start page.
 * ============================================================ */
(function () {
  "use strict";

  var MAX = 20;

  function sanitize(value, fallback) {
    var s = String(value == null ? '' : value)
      .replace(/[^A-Za-z0-9 _]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    /* keep at most one space */
    var i = s.indexOf(' ');
    if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/ /g, '');

    /* keep at most one underscore */
    i = s.indexOf('_');
    if (i >= 0) s = s.slice(0, i + 1) + s.slice(i + 1).replace(/_/g, '');

    s = s.replace(/^[ _]+|[ _]+$/g, '').slice(0, MAX);
    s = s.replace(/^[ _]+|[ _]+$/g, '');
    return s || (fallback === undefined ? 'Player1' : fallback);
  }

  window.RBLXnamepolicy = { sanitize: sanitize, MAX: MAX };
})();

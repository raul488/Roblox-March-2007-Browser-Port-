/* ============================================================
 * namepolicy.js  the single public username rule.
 *
 * 20 characters max, ASCII letters/numbers, one space, one underscore.
 * Anything else is removed. Leading/trailing separators are trimmed.
 * The private relay applies the same rule; the client also enforces it
 * live on the start page.  At commit time `clean()` also runs the name
 * through chatfilter.js, so names containing masked words fall back to
 * the default instead of rendering.
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

  /* Commit-time rule: the charset-sanitized name must also survive the chat
   * filter. A name containing a masked word is replaced outright, because
   * "#" is not a legal username character (and live masking would stop a
   * player from ever typing a legitimate prefix like "assassin"). */
  function clean(value, fallback) {
    var fb = fallback === undefined ? 'Player1' : fallback;
    var s = sanitize(value, fb);
    if (!s) return s;
    var filter = window.RBLXchatfilter;
    if (filter && filter.clean) {
      var result = filter.clean(s);
      if (!result.ok || result.text !== s) return fb;
    }
    return s;
  }

  window.RBLXnamepolicy = { sanitize: sanitize, clean: clean, MAX: MAX };
})();

/* ============================================================
 * chatfilter.js  player-chat policy.
 *
 * - printable ASCII only (no Unicode/emoji/control characters)
 * - 100 characters max
 * - repeated-character flood guard
 * - common profanity/slur mask, including simple leetspeak
 *
 * This is a starter list, not a complete moderation system. The host
 * applies it to every joiner message; the client applies it locally too.
 * ============================================================ */
(function () {
  "use strict";

  var MAX = 100;
  var MAX_REPEAT = 12;
  var LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's' };

  var WORDS = new Set([
    'fuck', 'fucks', 'fucked', 'fucker', 'fuckers', 'fucking',
    'shit', 'shits', 'shitty', 'shitting',
    'bitch', 'bitches', 'bitching',
    'cunt', 'cunts',
    'asshole', 'assholes',
    'bastard', 'bastards',
    'dick', 'dicks', 'dickhead',
    'pussy',
    'whore', 'whores',
    'slut', 'sluts',
    'nigger', 'niggers', 'nigga', 'niggas',
    'faggot', 'faggots', 'fag', 'fags',
    'retard', 'retards', 'retarded',
    'rape', 'raped', 'raping',
    'pedo', 'pedophile'
  ]);

  function normalizeToken(token) {
    return token.toLowerCase().replace(/[01345789@$]/g, function (c) {
      return LEET[c] || c;
    });
  }

  function maskWords(text) {
    return text.replace(/[A-Za-z0-9]+/g, function (token) {
      return WORDS.has(normalizeToken(token))
        ? '#'.repeat(token.length)
        : token;
    });
  }

  function clean(value) {
    var raw = String(value == null ? '' : value);
    if (!raw) return { ok: false, error: 'Message is empty.' };
    if (/[^\x20-\x7E]/.test(raw)) {
      return { ok: false, error: 'Chat is ASCII only: no Unicode or emoji.' };
    }
    var text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return { ok: false, error: 'Message is empty.' };
    if (text.length > MAX) {
      return { ok: false, error: 'Chat is limited to ' + MAX + ' characters.' };
    }
    if (new RegExp('(.)\\1{' + MAX_REPEAT + ',}').test(text)) {
      return { ok: false, error: 'Too many repeated characters.' };
    }
    return { ok: true, text: maskWords(text) };
  }

  window.RBLXchatfilter = {
    clean: clean,
    mask: maskWords,
    MAX: MAX
  };
})();

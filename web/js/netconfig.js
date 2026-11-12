/* Public multiplayer endpoint.
 *
 * Set the public relay origin before deploying, for example:
 *   window.RBLX_RELAY_URL = 'https://relay.example.com';
 *
 * Also add the same origin to connect-src in index.html:
 *   https://relay.example.com wss://relay.example.com
 *
 * When this page is served from localhost, the empty default points at a
 * local relay on 127.0.0.1:8788. Anywhere else an empty value disables Play;
 * Play Solo always works.
 */
(function () {
  "use strict";
  var local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname || '');
  var configured = String(window.RBLX_RELAY_URL || '').trim();
  var relay = configured || (local ? 'http://127.0.0.1:8788' : '');
  window.RBLX_NET_CONFIG = {
    relay: relay.replace(/\/+$/, '')
  };
})();

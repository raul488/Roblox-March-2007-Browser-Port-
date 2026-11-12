/* Public multiplayer endpoint.
 *
 * This page is configured for the Tailscale Funnel relay.  If the relay
 * moves, change this URL and the matching connect-src entry in index.html:
 *   https://<host> wss://<host>
 *
 * When this page is served from localhost, it still points at a local relay
 * on 127.0.0.1:8788; the public Funnel URL is used everywhere else.  An
 * empty value on a public origin disables Play; Play Solo always works.
 */
(function () {
  "use strict";
  window.RBLX_RELAY_URL = 'https://desktop-33lh8ah.tail4210dd.ts.net';
  var local = /^(localhost|127\.0\.0\.1)$/i.test(location.hostname || '');
  var configured = String(window.RBLX_RELAY_URL || '').trim();
  var relay = local ? 'http://127.0.0.1:8788' : configured;
  window.RBLX_NET_CONFIG = {
    relay: relay.replace(/\/+$/, '')
  };
})();

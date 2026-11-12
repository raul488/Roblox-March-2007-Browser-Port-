/* Root redirect. Kept out of index.html so the root page can use a
 * script-src 'self' CSP without an inline hash/nonce. */
(function () {
  "use strict";
  location.replace('web/' + location.search + location.hash);
})();

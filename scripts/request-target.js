'use strict';

// The pathname a request to one of the local servers asks for: the site
// preview (serve-site.js), the popup preview (popup-preview.js) and the
// browser tests' fixtures. The request target comes from the client as
// written, and some, such as //[ (an empty IPv6 host), are targets URL can't
// parse. An exception there would leave the request listener and stop the
// server, so they get an empty 400 instead.
//
// Returns null once it has answered 400, and the caller returns at once.
// Any target URL parses is unchanged, decoding included: each server does
// what it did with it before.
function requestPathname(request, response, base) {
  let url;
  try {
    url = new URL(request.url, base);
  } catch {
    response.writeHead(400).end();
    return null;
  }
  return url.pathname;
}

module.exports = { requestPathname };

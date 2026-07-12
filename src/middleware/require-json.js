// Content-type gate: this API speaks JSON and nothing else. The only body parser
// mounted is express.json(), so a non-JSON body is never parsed today — but that
// safety is implicit. This makes it explicit and fails CLOSED: any request that
// carries a body must declare `application/json` (or an `application/…+json`
// variant); everything else — notably XML, the XXE vector, but also form,
// multipart, and text/* — is refused with 415 BEFORE it reaches a parser.
//
// Why keep this even though we ship no XML parser: defense in depth. If a future
// change adds an XML/multipart parser, or express.json's `type` default is ever
// loosened, a hostile non-JSON body (an XXE DOCTYPE, a zip-bomb multipart, …)
// still cannot slip through this gate.
//
// Requests with no body are untouched: all GET/HEAD, and bodyless POSTs like
// /api/me/earn-code, carry no payload to police.

const JSON_TYPE = /^application\/(?:json|.+\+json)$/;

export function requireJson(req, res, next) {
  // "Does this request carry a body?" — mirror body-parser's own hasBody test:
  // a transfer-encoding (e.g. chunked) or a declared non-zero content-length.
  const hasBody =
    req.headers['transfer-encoding'] !== undefined ||
    Number(req.headers['content-length']) > 0;
  if (!hasBody) return next();

  // Strip any parameters (`; charset=utf-8`) and compare the bare media type.
  const type = (req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!JSON_TYPE.test(type)) {
    return res.status(415).json({
      error: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'This API accepts only application/json.',
    });
  }
  next();
}

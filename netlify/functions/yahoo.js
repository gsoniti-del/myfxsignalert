// netlify/functions/yahoo.js
// Tiny CORS proxy for Yahoo Finance's chart API, so Signal Desk can use Yahoo
// as a keyless data source in the browser (Yahoo sends no CORS headers).
//
// Deploy: drop this file at  netlify/functions/yahoo.js  in your site repo,
// then in Signal Desk → Settings set the CORS proxy field to:
//   https://YOUR-SITE.netlify.app/.netlify/functions/yahoo?u=
//
// The client calls:  <that URL> + encodeURIComponent(<yahoo chart url>)
// so the full request looks like  ...functions/yahoo?u=https%3A%2F%2Fquery1...

const ALLOWED = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  try {
    const raw = (event.queryStringParameters && event.queryStringParameters.u) || '';
    if (!raw) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'missing u param' }) };

    // SSRF guard: only allow Yahoo's chart hosts
    const target = new URL(raw);
    if (!ALLOWED.includes(target.hostname)) {
      return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'host not allowed' }) };
    }

    const res = await fetch(target.toString(), {
      headers: { 'User-Agent': 'Mozilla/5.0 (SignalDesk proxy)' },
    });
    const text = await res.text();
    return { statusCode: res.status, headers: cors, body: text };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e.message || e) }) };
  }
};

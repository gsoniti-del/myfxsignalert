// netlify/functions/yahoo.js
// Small allowlisted CORS proxy so Signal Desk can fetch data sources that don't
// send CORS headers (Yahoo Finance, TraderMade). Keeps the filename "yahoo" so
// existing proxy URLs keep working.
//
// Deploy: keep at  netlify/functions/yahoo.js  in your site repo. In Signal Desk
// → Settings set the CORS proxy field to:
//   https://YOUR-SITE.netlify.app/.netlify/functions/yahoo?u=
//
// The client calls:  <that URL> + encodeURIComponent(<source url>)

const ALLOWED = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'marketdata.tradermade.com',
];

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

'use strict';

// Cliente HTTP hacia el backend de Google Apps Script (mismo patron que
// callGAS en DASHBOARD_PC/main.js, pero reutilizable desde el servidor
// Express local en vez de desde el proceso Electron directamente).

const https = require('https');

const GAS_URL = 'https://script.google.com/macros/s/AKfycby9HoehNWF4TbKT8ApRpZdPqtcVQ7I-mjRrWutiSKhfAUxHvI12Fzwpz7W4YnA71ivN/exec';

function callGAS(action, payload = {}, timeoutMs = 25000) {
  const body = JSON.stringify({ action, ...payload });

  function doRequest(url, method, reqBody) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const headers = method === 'POST'
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(reqBody) }
        : {};
      const opts = { hostname: u.hostname, path: u.pathname + u.search, method, headers };

      let raw = '';
      const req = https.request(opts, res => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          resolve(doRequest(res.headers.location, 'GET', null));
          return;
        }
        res.setEncoding('utf8');
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error('Respuesta no valida del servidor')); }
        });
      });
      req.on('error', reject);
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Tiempo de espera agotado')); });
      if (reqBody) req.write(reqBody);
      req.end();
    });
  }

  return doRequest(GAS_URL, 'POST', body);
}

module.exports = { callGAS };

'use strict';

// Servidor local que sirve la interfaz web (public/) y expone rutas
// para que esa web hable con el proceso Electron (auto-update) y, más
// adelante, con el backend de Google Apps Script (registro de personal).

const express = require('express');
const path = require('path');
const { callGAS } = require('./gas');
const cola = require('./queue');

// Acciones de ESCRITURA que, si falla la conexion, se encolan en vez de
// fallar: son las unicas que la pantalla de Registro necesita para poder
// seguir trabajando sin internet (ver decision en la conversacion con el
// encargado). get_catalogos/get_personal_estado/get_registros, en cambio,
// siguen fallando normal si no hay conexion (se usa el ultimo dato que ya
// tenia cargado el navegador).
const ACCIONES_ENCOLABLES = new Set(['registrar_movimiento', 'registrar_lote']);
const TIMEOUT_ESCRITURA_MS = 10000; // mas corto que el default: para no tener
// al encargado esperando 25-30s antes de saber que se va a encolar.

function startServer(port) {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Relay hacia Google Apps Script ───────────────────────────────────
  // La web pega aca con {action, ...payload} y este endpoint reenvia tal
  // cual al backend de Apps Script (mismo patron que doPost alla). Para
  // registrar_movimiento/registrar_lote, si la llamada falla (sin
  // internet, o Google no responde), en vez de devolver error se guarda
  // el movimiento en una cola local y se le dice al cliente "quedo
  // pendiente", para que la pantalla de Registro pueda seguir usandose.
  app.post('/api/gas/:action', async (req, res) => {
    const action = req.params.action;
    const encolable = ACCIONES_ENCOLABLES.has(action);
    try {
      const result = await callGAS(action, req.body || {}, encolable ? TIMEOUT_ESCRITURA_MS : 25000);
      res.json(result);
    } catch (err) {
      if (encolable) {
        const id_local = cola.agregarACola(action, req.body || {});
        return res.json({ ok: true, offline: true, id_local, pendientes: cola.contarCola() });
      }
      res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  });

  // ── Cola de pendientes (sin conexion) ────────────────────────────────
  app.get('/api/cola/estado', (req, res) => {
    res.json({ pendientes: cola.contarCola() });
  });

  // Reintenta mandar lo que haya quedado pendiente, en orden, uno por uno.
  // Si el primero falla (sigue sin internet), corta ahi y reintenta todo
  // de nuevo en el proximo tick, para no perder el orden de los registros.
  let sincronizando = false;
  async function intentarSincronizar() {
    if (sincronizando) return;
    sincronizando = true;
    try {
      const pendientes = cola.obtenerCola();
      for (const item of pendientes) {
        try {
          await callGAS(item.action, item.payload, TIMEOUT_ESCRITURA_MS);
          cola.quitarDeCola(item.id_local);
        } catch {
          break; // sigue sin conexion (o fallo este): no sigo con el resto
        }
      }
    } finally {
      sincronizando = false;
    }
  }
  setInterval(intentarSincronizar, 20000);
  setTimeout(intentarSincronizar, 5000);

  // ── Estado de actualización ──────────────────────────────────────────
  // main.js escribe acá el último estado que reportó electron-updater;
  // la web lo consulta por polling simple para mostrar un aviso.
  let updateStatus = 'idle';
  let onCheckCb = () => {};
  let onDownloadCb = () => {};
  let onInstallCb = () => {};

  app.get('/api/update/status', (req, res) => {
    res.json({ status: updateStatus });
  });

  app.post('/api/update/check', (req, res) => {
    onCheckCb();
    res.json({ ok: true });
  });

  app.post('/api/update/download', (req, res) => {
    onDownloadCb();
    res.json({ ok: true });
  });

  app.post('/api/update/install', (req, res) => {
    onInstallCb();
    res.json({ ok: true });
  });

  const server = app.listen(port, '127.0.0.1');

  return {
    setUpdateStatus: s => { updateStatus = s; },
    onCheckForUpdates: cb => { onCheckCb = cb; },
    onDownloadUpdate: cb => { onDownloadCb = cb; },
    onInstallUpdate: cb => { onInstallCb = cb; },
    close: () => server.close()
  };
}

module.exports = { startServer };

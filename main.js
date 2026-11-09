'use strict';

// ── Alcos Asistencia PC ──────────────────────────────────────────────────
// A diferencia de DASHBOARD_PC (que abría su propia ventana Electron),
// este programa NO tiene ventana propia: levanta un servidor local y abre
// la interfaz en el navegador por defecto del sistema. Sigue corriendo en
// segundo plano (ícono de bandeja) aunque se cierre la pestaña del navegador.

const { app, Tray, Menu, shell, nativeImage } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

const { startServer } = require('./server/app');

const PORT = 4200;
const APP_URL = `http://localhost:${PORT}`;

let tray = null;
let server = null;

// ── Evitar instancias duplicadas ─────────────────────────────────────────
// Si el encargado hace doble clic dos veces, no queremos dos servidores
// peleando por el mismo puerto: la segunda instancia simplemente reabre
// el navegador en la que ya está corriendo.

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    shell.openExternal(APP_URL);
  });

  app.whenReady().then(() => {
    // Esta app vive en la bandeja, sin ventanas ni dock: que no se cierre
    // sola cuando no hay ventanas abiertas (comportamiento por defecto de
    // Electron en Windows/Linux sería cerrarse; acá lo forzamos a seguir).
    app.on('window-all-closed', () => {});

    server = startServer(PORT);

    createTray();

    // Abre el navegador automáticamente la primera vez que se ejecuta.
    shell.openExternal(APP_URL);

    setupAutoUpdater();
  });
}

// ── Bandeja del sistema ───────────────────────────────────────────────────

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Alcos Asistencia PC');

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Abrir',
      click: () => shell.openExternal(APP_URL)
    },
    {
      label: 'Buscar actualizaciones',
      click: () => {
        autoUpdater.checkForUpdates().catch(() => {});
      }
    },
    { type: 'separator' },
    {
      label: 'Salir',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.on('click', () => shell.openExternal(APP_URL));
}

// ── Auto-update (GitHub releases, igual patrón que DASHBOARD_PC) ─────────
// Como ya no hay ventana Electron para mostrar modales de "nueva versión
// disponible", el estado de la actualización se expone vía el servidor
// local (ver server/app.js) para que la página web en el navegador lo
// muestre con un toast o notificación propia.

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on('checking-for-update', () => server.setUpdateStatus('checking'));
  autoUpdater.on('update-available', info => server.setUpdateStatus('available:' + info.version));
  autoUpdater.on('update-not-available', () => server.setUpdateStatus('not-available'));
  autoUpdater.on('download-progress', info => server.setUpdateStatus('downloading:' + Math.round(info.percent)));
  autoUpdater.on('update-downloaded', () => server.setUpdateStatus('downloaded'));
  autoUpdater.on('error', err => server.setUpdateStatus('error:' + (err.message || 'desconocido')));

  // El servidor expone rutas que la web llama para disparar estas acciones.
  server.onCheckForUpdates(() => autoUpdater.checkForUpdates().catch(() => {}));
  server.onDownloadUpdate(() => autoUpdater.downloadUpdate().catch(() => {}));
  server.onInstallUpdate(() => autoUpdater.quitAndInstall());

  // Chequeo automático al iniciar, igual que antes.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 3000);
}

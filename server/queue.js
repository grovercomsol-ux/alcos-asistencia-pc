'use strict';

// Cola de registros pendientes de enviar, para cuando se corta el internet.
// Se guarda en un archivo en la carpeta de datos del usuario (NO en la
// carpeta del programa, para que sobreviva actualizaciones), asi que si
// el encargado cierra el programa con la cola pendiente, no se pierde:
// al volver a abrir, sigue ahi y se intenta mandar de nuevo.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

let FILE = null;
function archivoCola() {
  if (!FILE) FILE = path.join(app.getPath('userData'), 'cola_pendientes.json');
  return FILE;
}

function cargarCola() {
  try {
    const raw = fs.readFileSync(archivoCola(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function guardarCola(cola) {
  try {
    fs.writeFileSync(archivoCola(), JSON.stringify(cola, null, 2), 'utf8');
  } catch (err) {
    console.error('No se pudo guardar la cola de pendientes:', err);
  }
}

// ID local temporal, solo para que la interfaz pueda identificar la fila
// mientras no se confirmo con el servidor (el id_registro real lo asigna
// Apps Script recién cuando se sincroniza).
function nuevoIdLocal() {
  return 'local-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
}

function agregarACola(action, payload) {
  const cola = cargarCola();
  const id_local = nuevoIdLocal();
  cola.push({ id_local, action, payload, creado: new Date().toISOString() });
  guardarCola(cola);
  return id_local;
}

function obtenerCola() {
  return cargarCola();
}

function contarCola() {
  return cargarCola().length;
}

function quitarDeCola(id_local) {
  const cola = cargarCola().filter(item => item.id_local !== id_local);
  guardarCola(cola);
}

module.exports = { agregarACola, obtenerCola, contarCola, quitarDeCola };

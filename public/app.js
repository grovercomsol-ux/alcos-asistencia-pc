'use strict';

// ── Estado global ──────────────────────────────────────────────────────

const CONFIG_KEY = 'alcos_config';
const CATALOGOS_CACHE_KEY = 'alcos_catalogos_cache';

let catalogos = null;      // { secciones, tipos_salida, encargados }
let personal = [];         // ultimo resultado de get_personal_estado (secciones a cargo + agregados a mano)
let selected = new Set();  // ids de persona tildados
let filtro = '';
let config = null;         // { id_encargado, secciones: [ids] }
let horas = {};            // id_persona -> 'HH:MM' elegida para el proximo registro
let comentarios = {};      // id_persona -> comentario elegido para el proximo registro
let personalTodos = null;  // cache de get_personal_estado sin filtro, para busquedas en toda la planta

// ── Hora/fecha (America/La_Paz) ──────────────────────────────────────

const TZ = 'America/La_Paz';

function fechaHoyLaPaz() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const obj = {}; partes.forEach(p => obj[p.type] = p.value);
  return `${obj.year}-${obj.month}-${obj.day}`;
}

function horaActualLaPaz() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const obj = {}; partes.forEach(p => obj[p.type] = p.value);
  let h = Number(obj.hour === '24' ? '0' : obj.hour), m = Number(obj.minute);
  return { h, m };
}

// Hora (HH:MM, 24h) de un timestamp ISO guardado, tal como cae en La Paz —
// para precargar el campo "hora" al editar un registro existente.
function horaDeTimestampLaPaz(timestampIso) {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date(timestampIso));
  const obj = {}; partes.forEach(p => obj[p.type] = p.value);
  const h = obj.hour === '24' ? '00' : obj.hour;
  return `${h}:${obj.minute}`;
}

function horaRedondeada15() {
  let { h, m } = horaActualLaPaz();
  m = Math.round(m / 15) * 15;
  if (m === 60) { m = 0; h = (h + 1) % 24; }
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function horaDePersona(id_persona) {
  return horas[id_persona] || horaRedondeada15();
}

function setHoraPersona(id_persona, val) {
  if (val) horas[id_persona] = val;
}

function comentarioDePersona(id_persona) {
  return comentarios[id_persona] || '';
}

function setComentarioPersona(id_persona, val) {
  comentarios[id_persona] = val;
}

function aplicarHoraAGrupo() {
  const val = document.getElementById('hora-grupo').value;
  if (!val) { toast('Elegí una hora primero.'); return; }
  if (!selected.size) { toast('No hay nadie seleccionado.'); return; }
  selected.forEach(id => { horas[id] = val; });
  render();
  toast(`✓ Hora ${val} aplicada a ${selected.size} seleccionado(s).`);
}

// ── API helper ────────────────────────────────────────────────────────

async function apiGas(action, payload = {}) {
  const res = await fetch(`/api/gas/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Error desconocido del servidor');
  return data;
}

function seccionNombre(id) {
  const s = catalogos.secciones.find(s => String(s.id_seccion) === String(id));
  return s ? s.nombre : ('Sección ' + id);
}

function motivoNombre(id) {
  const m = catalogos.tipos_salida.find(m => String(m.id_motivo) === String(id));
  return m ? m.nombre : id;
}

function encargadoNombre(id) {
  const e = catalogos.encargados.find(e => String(e.id_encargado) === String(id));
  return e ? e.nombre : '—';
}

// ── Toast ─────────────────────────────────────────────────────────────

let toastTimer = null;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── Config (encargado + secciones a cargo) ───────────────────────────

function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY)); }
  catch { return null; }
}

function saveConfig(c) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(c));
  config = c;
}

function abrirSetup() {
  const sel = document.getElementById('setup-encargado');
  sel.innerHTML = catalogos.encargados
    .map(e => `<option value="${e.id_encargado}">${e.nombre}</option>`).join('');
  if (config) sel.value = config.id_encargado;

  const wrap = document.getElementById('setup-secciones');
  wrap.innerHTML = catalogos.secciones.map(s => {
    const checked = config && config.secciones.includes(String(s.id_seccion)) ? 'checked' : '';
    return `<label><input type="checkbox" value="${s.id_seccion}" ${checked}/> ${s.nombre}</label>`;
  }).join('');

  document.getElementById('setup-error').style.display = 'none';
  document.getElementById('setup-overlay').style.display = 'flex';
}

function guardarSetup() {
  const id_encargado = document.getElementById('setup-encargado').value;
  const secciones = [...document.querySelectorAll('#setup-secciones input:checked')].map(i => i.value);

  if (!secciones.length) {
    const err = document.getElementById('setup-error');
    err.textContent = 'Elegí al menos una sección a cargo.';
    err.style.display = 'block';
    return;
  }

  saveConfig({ id_encargado, secciones });
  document.getElementById('setup-overlay').style.display = 'none';
  loadPersonal();
}

// ── Carga de personal ────────────────────────────────────────────────

async function loadPersonal() {
  const teniaDatos = personal.length > 0;
  if (!teniaDatos) document.getElementById('lista').innerHTML = '<div id="empty">Cargando…</div>';
  try {
    const res = await apiGas('get_personal_estado', { secciones: config.secciones });
    personal = res.personal;
    selected = new Set(personal.map(p => p.id_persona)); // todos preseleccionados
    horas = {};
    comentarios = {};
    personal.forEach(p => { horas[p.id_persona] = horaRedondeada15(); });
    render();
    actualizarEncabezado();
  } catch (err) {
    if (teniaDatos) {
      // Sin conexion: seguimos mostrando lo que ya teniamos cargado en
      // vez de dejar la pantalla en "Cargando…" para siempre.
      render();
      actualizarEncabezado();
      toast('📶 Sin conexión: se muestran los últimos datos cargados.');
    } else {
      document.getElementById('lista').innerHTML =
        '<div id="empty">Sin conexión y sin datos previos. Conectate a internet al menos una vez para cargar el personal.</div>';
      toast('📶 Sin conexión: no se pudo cargar el personal.');
    }
  }
}

// ── Seleccionar todo ──────────────────────────────────────────────────

function seleccionarTodo() {
  selected = new Set(personal.map(p => p.id_persona));
  render();
}

function desmarcarTodo() {
  selected.clear();
  render();
}

function actualizarEncabezado() {
  const label = config.secciones.map(seccionNombre).join(', ');
  document.getElementById('header-sub').textContent =
    `${encargadoNombre(config.id_encargado)} · a cargo de: ${label}`;
}

// ── Render de la lista ───────────────────────────────────────────────
// La lista principal SIEMPRE muestra mi preseleccion actual (personal),
// sin filtrar por el buscador. El buscador de arriba es solo para
// AGREGAR gente nueva (ver seccion "Agregar personal" mas abajo): se
// despliega un dropdown con el resto del personal de la planta.

function render() {
  const lista = document.getElementById('lista');
  if (!personal.length) {
    lista.innerHTML = '<div id="empty">Sin resultados.</div>';
  } else {
    lista.innerHTML = personal.map(filaHtml).join('');
  }
  actualizarContador();
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function actualizarContador() {
  const total = personal.length;
  const marcados = personal.filter(p => selected.has(p.id_persona)).length;
  document.getElementById('contador').textContent = `${marcados}/${total} seleccionados`;
}

function fechaCorta(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('es-BO', { day: '2-digit', month: '2-digit' }) +
    ' ' + d.toLocaleTimeString('es-BO', { hour: '2-digit', minute: '2-digit' });
}

// Es "externo" si su ubicacion actual no es ninguna de las secciones que este encargado controla
function esExterno(p) {
  return !config.secciones.includes(String(p.seccion_actual));
}

function destinoDePersona(p) {
  return config.secciones[0];
}

function fechaCortaDDMM(iso) {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

// Un solo select con TODAS las opciones juntas: salida con motivo (permiso,
// matrimonio, etc.) y "Mover a <sección>" para cada sección, una opción por
// sección. Una sola eleccion = queda todo definido de una vez, sin un
// segundo campo. El valor trae un prefijo para distinguir el tipo:
//   ""          -> sin eleccion manual, usa la sugerencia por defecto
//   "motivo:ID" -> salida con ese motivo
//   "mover:ID"  -> cambio de sección a esa sección
function onCambioAccionSalida(id_persona, value) {
  const p = personal.find(x => x.id_persona === id_persona);
  if (!p) return;
  delete p._motivoOverride;
  delete p._destinoOverride;
  if (value.startsWith('motivo:')) {
    p._motivoOverride = value.slice(7);
  } else if (value.startsWith('mover:')) {
    p._destinoOverride = value.slice(6);
  }
  render();
}

// ── Aplicar un movimiento SIN servidor (modo sin conexion) ────────────
// Cuando se encola un registro porque no hay internet, no podemos pedirle
// al servidor el estado actualizado (get_personal_estado tambien
// necesita conexion). En vez de eso, actualizamos a mano "personal" y
// "personalTodos" con el mismo resultado que hubiera calculado el
// backend, para que la fila se vea correcta al toque. Cuando se
// sincronice de verdad mas tarde, el proximo "↻ Actualizar" (o el
// refresco despues de un registro online) termina de alinear todo.
function aplicarMovimientoLocal(mov) {
  const actualizar = (arr) => {
    if (!arr) return;
    const p = arr.find(x => x.id_persona === mov.id_persona);
    if (!p) return;
    const esEntrada = String(mov.id_tipo).toUpperCase() === 'ENTRADA';
    p.seccion_actual = String(mov.id_seccion);
    p.estado = esEntrada ? 'EN_SECCION' : 'AFUERA';
    p.motivo = esEntrada ? null : (mov.id_motivo || null);
    p.motivo_nombre = esEntrada ? null : (mov.id_motivo ? motivoNombre(mov.id_motivo) : null);
    p.desde = esEntrada ? null : new Date().toISOString();
    p.tiene_historial = true;
    p.ultimo_tipo = esEntrada ? 'ENTRADA' : 'SALIDA';
    p.ultimo_motivo_nombre = esEntrada ? null : p.motivo_nombre;
    p.ultimo_fecha = new Date().toISOString();
    p.accion_sugerida = esEntrada ? 'SALIDA' : 'ENTRADA';
    delete p._motivoOverride;
    delete p._destinoOverride;
  };
  actualizar(personal);
  actualizar(personalTodos);
}

function aplicarMovimientosLocal(movimientos) {
  movimientos.forEach(aplicarMovimientoLocal);
}

// Vuelve una fila a su accion sugerida por defecto (descarta motivo o destino elegidos a mano)
function limpiarOverride(id_persona) {
  const p = personal.find(x => x.id_persona === id_persona);
  if (!p) return;
  delete p._motivoOverride;
  delete p._destinoOverride;
  render();
}

// Que se va a registrar para esta fila SI se confirma con "Registrar".
// Esto es solo una previsualizacion: no escribe nada en la base.
function accionPrevista(p) {
  // 1) Si eligieron a mano un motivo de salida (vacacion, permiso, matrimonio, etc.)
  if (p._motivoOverride) {
    const m = catalogos.tipos_salida.find(t => String(t.id_motivo) === String(p._motivoOverride));
    return {
      tipo: 'SALIDA', seccion: p.seccion_actual, id_motivo: p._motivoOverride,
      etiqueta: m ? m.nombre : 'Salida'
    };
  }
  // 2) Si eligieron a mano una seccion destino (boton "Mover")
  if (p._destinoOverride) {
    const destino = p._destinoOverride;
    return {
      tipo: 'CAMBIO_SECCION', seccion_origen: p.seccion_actual, seccion_destino: destino, id_motivo: '1',
      etiqueta: `Cambio de sección → Entrada a ${seccionNombre(destino)}`
    };
  }
  // 3) Externo (esta vigente en una seccion que este encargado no controla): por defecto, traerlo a la suya
  if (esExterno(p)) {
    const destino = destinoDePersona(p);
    if (p.estado === 'AFUERA') {
      return { tipo: 'ENTRADA', seccion: destino, id_motivo: '', etiqueta: `Entrada a ${seccionNombre(destino)}` };
    }
    return {
      tipo: 'CAMBIO_SECCION', seccion_origen: p.seccion_actual, seccion_destino: destino, id_motivo: '1',
      etiqueta: `Cambio de sección → Entrada a ${seccionNombre(destino)}`
    };
  }
  // 4) Nativo de mis secciones: sugerencia automatica segun su ultimo registro
  if (p.accion_sugerida === 'ENTRADA') {
    return { tipo: 'ENTRADA', seccion: p.seccion_actual, id_motivo: '', etiqueta: `Entrada a ${seccionNombre(p.seccion_actual)}` };
  }
  return { tipo: 'SALIDA', seccion: p.seccion_actual, id_motivo: '4', etiqueta: 'Salida regular' };
}

// Antes: su ultimo registro real (fecha, hora, tipo) o "vigente" si nunca se registro
function antesLabel(p) {
  if (!p.tiene_historial) return `Vigente en ${seccionNombre(p.id_seccion_titular)} (sin registros previos)`;
  if (p.ultimo_tipo === 'ENTRADA') return `Vigente en ${seccionNombre(p.seccion_actual)} desde ${fechaCorta(p.ultimo_fecha)}`;
  return `${p.ultimo_motivo_nombre || 'Salida'} desde ${fechaCorta(p.ultimo_fecha)}`;
}

// Despues: el registro nuevo que se va a crear si confirma ahora (con la hora que elegio)
function despuesLabel(p) {
  const prevista = accionPrevista(p);
  const hora = horaDePersona(p.id_persona);
  return `${prevista.etiqueta} · ${fechaCortaDDMM(fechaHoyLaPaz())} ${hora}`;
}

function filaHtml(p) {
  const checked = selected.has(p.id_persona) ? 'checked' : '';
  const externo = esExterno(p);
  const tieneEleccionManual = !!(p._motivoOverride || p._destinoOverride);
  const prevista = accionPrevista(p);
  const pillClass = prevista.tipo === 'CAMBIO_SECCION' ? 'accion-cambio'
    : prevista.tipo === 'ENTRADA' ? 'accion-entrada' : 'accion-salida';

  // Un solo select con todo junto: motivos de salida + "Mover a <sección>"
  // (una opcion por sección) — una sola eleccion define todo de una vez.
  const motivosOptions = catalogos.tipos_salida
    .filter(m => m.clasificacion !== 'Interna')
    .map(m => `<option value="motivo:${m.id_motivo}" ${String(p._motivoOverride) === String(m.id_motivo) ? 'selected' : ''}>${m.nombre}</option>`).join('');

  const moverOptions = catalogos.secciones
    .filter(s => String(s.id_seccion) !== String(p.seccion_actual))
    .map(s => `<option value="mover:${s.id_seccion}" ${String(p._destinoOverride) === String(s.id_seccion) ? 'selected' : ''}>↪ Mover a ${s.nombre}</option>`).join('');

  const selectAccionValue = p._destinoOverride ? `mover:${p._destinoOverride}`
    : p._motivoOverride ? `motivo:${p._motivoOverride}` : '';

  const comentarioActual = comentarioDePersona(p.id_persona);
  const comentarioBtnClass = comentarioActual ? 'btn-sm btn-comentario btn-comentario-activo' : 'btn-sm btn-comentario';
  const comentarioTitle = comentarioActual ? `Comentario: ${comentarioActual}` : 'Agregar comentario';

  return `
    <div class="row" data-id="${p.id_persona}">
      <input type="checkbox" ${checked} onchange="toggleSeleccion('${p.id_persona}', this.checked)"/>

      <div class="row-nombre-block">
        <span class="row-nombre">${p.nombre}</span><span class="row-id">#${p.id_persona}</span>
        ${externo ? '<div class="badge badge-externo">Externo</div>' : ''}
      </div>

      <div class="row-compare">
        <div class="row-col row-col-antes">
          <div class="col-valor">${antesLabel(p)}</div>
        </div>
        <div class="row-col row-col-despues">
          <div class="col-controls">
            <span class="accion-pill ${pillClass}">${despuesLabel(p)}</span>
            <input type="time" class="row-hora" step="60" value="${horaDePersona(p.id_persona)}"
                   onchange="setHoraPersona('${p.id_persona}', this.value)" title="Hora del registro"/>
            <select class="row-select" onchange="onCambioAccionSalida('${p.id_persona}', this.value)" title="Elegir salida con motivo o mover de sección">
              <option value="" ${selectAccionValue === '' ? 'selected' : ''}>Salida regular…</option>
              ${motivosOptions}
              ${moverOptions}
            </select>
            <button class="${comentarioBtnClass}" onclick="abrirComentario(event, '${p.id_persona}')" title="${escapeHtml(comentarioTitle)}">💬</button>
          </div>
          ${tieneEleccionManual ? `<button class="btn-link" onclick="limpiarOverride('${p.id_persona}')">✕ Quitar selección, volver a lo sugerido</button>` : ''}
        </div>
      </div>

      <button class="btn-sm btn-sm-entrada btn-registrar-fila" onclick="registrarIndividual('${p.id_persona}')">✓ Registrar</button>
      <button class="btn-sm" onclick="abrirGanttDesdeRegistro('${p.id_persona}')" title="Ver diagrama de Gantt de esta persona">📊</button>
      <button class="btn-sm" onclick="abrirHistorialDesdeRegistro('${p.id_persona}')" title="Ver y editar el historial de esta persona">🗂</button>
      <button class="btn-quitar-fila" onclick="quitarDeLista('${p.id_persona}')" title="Quitar de mi preselección">✕</button>
    </div>`;
}

// ── Comentario (mini popup, no ocupa espacio fijo en la fila) ────────
// Se abre con el boton 💬, se guarda con "Guardar" o presionando Enter.

function abrirComentario(evt, id_persona) {
  evt.stopPropagation();
  cerrarComentario();
  cerrarMover();
  const actual = comentarioDePersona(id_persona);

  const pop = document.createElement('div');
  pop.className = 'comentario-pop';
  pop.id = 'comentario-pop';
  pop.innerHTML = `
    <div class="comentario-pop-label">Comentario para este registro</div>
    <input type="text" id="comentario-input" value="${escapeHtml(actual)}" placeholder="Escribí un comentario…"/>
    <div class="comentario-pop-btns">
      <button class="ok" onclick="guardarComentario('${id_persona}')">Guardar</button>
      <button class="cancel" onclick="cerrarComentario()">Cancelar</button>
    </div>`;
  document.body.appendChild(pop);

  const rect = evt.currentTarget.getBoundingClientRect();
  pop.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  const left = Math.min(rect.left + window.scrollX - 150, window.scrollX + window.innerWidth - pop.offsetWidth - 12);
  pop.style.left = Math.max(window.scrollX + 8, left) + 'px';

  const input = document.getElementById('comentario-input');
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); guardarComentario(id_persona); }
    else if (e.key === 'Escape') { cerrarComentario(); }
  });

  setTimeout(() => document.addEventListener('click', onClickFueraComentario), 0);
}

function onClickFueraComentario(e) {
  const pop = document.getElementById('comentario-pop');
  if (pop && !pop.contains(e.target)) cerrarComentario();
}

function cerrarComentario() {
  const pop = document.getElementById('comentario-pop');
  if (pop) pop.remove();
  document.removeEventListener('click', onClickFueraComentario);
}

function guardarComentario(id_persona) {
  const input = document.getElementById('comentario-input');
  setComentarioPersona(id_persona, input ? input.value : '');
  cerrarComentario();
  render();
}

// Saca a alguien de mi preseleccion de trabajo (no toca la base de datos).
// Si lo vuelvo a necesitar, lo agrego otra vez desde el buscador de arriba.
function quitarDeLista(id_persona) {
  const p = personal.find(p => p.id_persona === id_persona);
  personal = personal.filter(p => p.id_persona !== id_persona);
  selected.delete(id_persona);
  render();
  if (p) toast(`Se quitó a ${p.nombre} de tu preselección.`);
}

function toggleSeleccion(id, checked) {
  if (checked) selected.add(id);
  else selected.delete(id);
  actualizarContador();
}

// ── Agregar personal (dropdown del buscador de arriba) ───────────────
// Al hacer click/foco en el buscador se despliega la lista del resto del
// personal de la planta (el que todavia no esta en mi preseleccion). Se
// puede filtrar escribiendo, y cada click en un resultado lo agrega a mi
// preseleccion sin cerrar el dropdown (para poder agregar varios de una).

function candidatosAgregar() {
  if (!personalTodos) return null; // todavia cargando
  let candidatos = personalTodos.filter(p => !personal.some(x => x.id_persona === p.id_persona));
  if (filtro) {
    const f = filtro.toLowerCase();
    candidatos = candidatos.filter(p => p.nombre.toLowerCase().includes(f) || String(p.id_persona).includes(f));
  }
  return candidatos;
}

function renderDropdownAgregar() {
  const cont = document.getElementById('agregar-dropdown');
  const candidatos = candidatosAgregar();

  if (candidatos === null) {
    cont.innerHTML = '<div class="dropdown-vacio">Cargando personal de toda la planta…</div>';
    return;
  }
  if (!candidatos.length) {
    cont.innerHTML = `<div class="dropdown-vacio">${filtro ? `Sin coincidencias para "${escapeHtml(filtro)}".` : 'Ya agregaste a todos.'}</div>`;
    return;
  }

  const limite = 60;
  const mostrar = candidatos.slice(0, limite);
  cont.innerHTML = mostrar.map(p => {
    const estadoTxt = p.estado === 'AFUERA'
      ? `Afuera · ${p.motivo_nombre || 'sin motivo'} (${seccionNombre(p.seccion_actual)})`
      : `En ${seccionNombre(p.seccion_actual)}`;
    return `
      <div class="dropdown-item" onclick="agregarDesdeDropdown('${p.id_persona}')">
        <div class="dropdown-item-info">
          <span class="row-nombre">${p.nombre}</span><span class="row-id">#${p.id_persona}</span>
          <div class="dropdown-item-estado">${estadoTxt}</div>
        </div>
        <span class="dropdown-item-add">➕</span>
      </div>`;
  }).join('') + (candidatos.length > limite ? `<div class="dropdown-vacio">… y ${candidatos.length - limite} más. Escribí para filtrar.</div>` : '');
}

function mostrarDropdownAgregar() {
  document.getElementById('agregar-dropdown').classList.remove('agregar-dropdown-hidden');
  renderDropdownAgregar();
  setTimeout(() => document.addEventListener('click', onClickFueraDropdown), 0);
}

function ocultarDropdownAgregar() {
  document.getElementById('agregar-dropdown').classList.add('agregar-dropdown-hidden');
  document.removeEventListener('click', onClickFueraDropdown);
}

function onClickFueraDropdown(e) {
  // Uso composedPath (la ruta del click en el momento del evento) en vez de
  // .contains(e.target): al agregar una persona se vuelve a armar el HTML
  // del dropdown, y el elemento clickeado queda desconectado del DOM antes
  // de que este handler corra, haciendo que .contains() de un falso "afuera".
  const wrap = document.getElementById('search-wrap');
  if (!e.composedPath().includes(wrap)) ocultarDropdownAgregar();
}

function agregarDesdeDropdown(id_persona) {
  if (personal.some(p => p.id_persona === id_persona)) return;
  const p = personalTodos.find(p => p.id_persona === id_persona);
  if (!p) return;
  personal.push(p);
  selected.add(id_persona);
  horas[id_persona] = horaRedondeada15();
  render();
  renderDropdownAgregar();
  toast(`✓ ${p.nombre} agregado a tu preselección.`);
}

function onFiltro(v) {
  filtro = v;
  renderDropdownAgregar();
}

// ── Accion masiva (un solo boton, accion por fila segun accion_sugerida) ─

async function registrarSeleccionados() {
  const elegidos = personal.filter(p => selected.has(p.id_persona));
  if (!elegidos.length) { toast('No hay nadie seleccionado.'); return; }

  const previstas = elegidos.map(p => accionPrevista(p));
  const entradas = previstas.filter(a => a.tipo === 'ENTRADA').length;
  const salidas = previstas.filter(a => a.tipo === 'SALIDA').length;
  const cambios = previstas.filter(a => a.tipo === 'CAMBIO_SECCION').length;

  const partes = [];
  if (entradas) partes.push(`${entradas} entrada(s)`);
  if (salidas) partes.push(`${salidas} salida(s)`);
  if (cambios) partes.push(`${cambios} cambio(s) de sección`);
  if (!confirm(`¿Registrar: ${partes.join(', ')}?`)) return;

  const fecha = fechaHoyLaPaz();
  const movimientos = [];
  elegidos.forEach(p => {
    const hora = horaDePersona(p.id_persona);
    const comentarios_ = comentarioDePersona(p.id_persona);
    const prevista = accionPrevista(p);
    if (prevista.tipo === 'CAMBIO_SECCION') {
      movimientos.push({ id_persona: p.id_persona, id_tipo: 'SALIDA', id_seccion: prevista.seccion_origen, id_motivo: prevista.id_motivo, id_encargado: config.id_encargado, fecha, hora, comentarios: comentarios_ });
      movimientos.push({ id_persona: p.id_persona, id_tipo: 'ENTRADA', id_seccion: prevista.seccion_destino, id_motivo: prevista.id_motivo, id_encargado: config.id_encargado, fecha, hora, comentarios: comentarios_ });
    } else {
      movimientos.push({ id_persona: p.id_persona, id_tipo: prevista.tipo, id_seccion: prevista.seccion, id_motivo: prevista.id_motivo, id_encargado: config.id_encargado, fecha, hora, comentarios: comentarios_ });
    }
  });

  try {
    const res = await apiGas('registrar_lote', { movimientos });
    if (res.offline) {
      aplicarMovimientosLocal(movimientos);
      selected.clear();
      render();
      toast(`📶 Sin conexión: ${movimientos.length} registro(s) guardado(s) localmente, se enviarán solos cuando vuelva la señal.`);
      actualizarBannerOffline();
    } else {
      toast(`✓ ${res.cantidad} registro(s) guardado(s).`);
      await loadPersonal();
      invalidarCacheCompartida();
    }
  } catch (err) {
    toast('⚠ ' + err.message);
  }
}

// ── Acciones individuales ────────────────────────────────────────────

async function registrarIndividual(id_persona) {
  const p = personal.find(p => p.id_persona === id_persona);
  const prevista = accionPrevista(p);
  const fecha = fechaHoyLaPaz();
  const hora = horaDePersona(id_persona);
  const comentario = comentarioDePersona(id_persona);
  try {
    let res;
    let movimientos;
    if (prevista.tipo === 'CAMBIO_SECCION') {
      movimientos = [
        { id_persona, id_tipo: 'SALIDA', id_seccion: prevista.seccion_origen, id_motivo: prevista.id_motivo, id_encargado: config.id_encargado, fecha, hora, comentarios: comentario },
        { id_persona, id_tipo: 'ENTRADA', id_seccion: prevista.seccion_destino, id_motivo: prevista.id_motivo, id_encargado: config.id_encargado, fecha, hora, comentarios: comentario }
      ];
      res = await apiGas('registrar_lote', { movimientos });
    } else {
      movimientos = [{
        id_persona, id_tipo: prevista.tipo, id_seccion: prevista.seccion,
        id_motivo: prevista.id_motivo, id_encargado: config.id_encargado,
        fecha, hora, comentarios: comentario
      }];
      res = await apiGas('registrar_movimiento', movimientos[0]);
    }

    if (res.offline) {
      aplicarMovimientosLocal(movimientos);
      render();
      toast(`📶 Sin conexión: se guardó localmente lo de ${p.nombre}, se enviará solo cuando vuelva la señal.`);
      actualizarBannerOffline();
    } else {
      toast(prevista.tipo === 'CAMBIO_SECCION'
        ? `✓ ${p.nombre} cambiado de sección a ${seccionNombre(prevista.seccion_destino)}.`
        : `✓ ${prevista.etiqueta} registrada para ${p.nombre}.`);
      await loadPersonal();
      invalidarCacheCompartida();
    }
  } catch (err) { toast('⚠ ' + err.message); }
}

// ── Actualizaciones (electron-updater via servidor local) ────────────
// Flujo: el encargado aprieta "Buscar actualizaciones" (menú ⚙) -> si hay
// una version nueva, aparece el banner azul arriba con el boton
// "Actualizar software" -> al apretarlo se descarga e instala sola, sin
// pasos intermedios: la app se cierra, el instalador NSIS corre en
// silencio, y electron-updater vuelve a abrir el programa solo (que a su
// vez abre una pestaña nueva del navegador, ya actualizada). Esta pestaña
// vieja se queda sin conexión en el momento en que el servidor local se
// apaga para instalar — es esperable, no es un error.

let updatePollTimer = null;
let updateDescargando = false;

function mostrarBannerUpdate(texto, mostrarBoton) {
  document.getElementById('banner-update-text').textContent = texto;
  document.getElementById('banner-update-btn').style.display = mostrarBoton ? 'inline-block' : 'none';
  document.getElementById('banner-update').classList.remove('banner-update-hidden');
}

function ocultarBannerUpdate() {
  document.getElementById('banner-update').classList.add('banner-update-hidden');
}

function detenerPollingUpdate() {
  if (updatePollTimer) { clearInterval(updatePollTimer); updatePollTimer = null; }
}

async function buscarActualizaciones() {
  updateDescargando = false;
  mostrarBannerUpdate('🔄 Buscando actualizaciones…', false);
  try { await fetch('/api/update/check', { method: 'POST' }); } catch {}
  detenerPollingUpdate();
  updatePollTimer = setInterval(pollUpdateStatus, 1500);
  pollUpdateStatus();
}

async function pollUpdateStatus() {
  let data;
  try {
    const res = await fetch('/api/update/status');
    data = await res.json();
  } catch {
    return; // servidor local caido (justo instalando): no tocamos el banner
  }

  const status = data.status || 'idle';

  if (status === 'checking') {
    mostrarBannerUpdate('🔄 Buscando actualizaciones…', false);
  } else if (status.startsWith('available:')) {
    detenerPollingUpdate();
    const version = status.split(':')[1];
    mostrarBannerUpdate(`🆕 Hay una actualización disponible (v${version})`, true);
  } else if (status === 'not-available') {
    detenerPollingUpdate();
    mostrarBannerUpdate('✓ Ya tenés la última versión.', false);
    setTimeout(ocultarBannerUpdate, 4000);
  } else if (status.startsWith('downloading:')) {
    const pct = status.split(':')[1];
    mostrarBannerUpdate(`⬇️ Descargando actualización… ${pct}%`, false);
  } else if (status === 'downloaded') {
    detenerPollingUpdate();
    mostrarBannerUpdate('✅ Actualización descargada. Instalando y reiniciando…', false);
    fetch('/api/update/install', { method: 'POST' }).catch(() => {});
  } else if (status.startsWith('error:')) {
    detenerPollingUpdate();
    updateDescargando = false;
    toast('⚠ Error con la actualización: ' + status.slice(6));
    ocultarBannerUpdate();
  }
}

async function instalarActualizacion() {
  if (updateDescargando) return;
  updateDescargando = true;
  mostrarBannerUpdate('⬇️ Descargando actualización… 0%', false);
  try { await fetch('/api/update/download', { method: 'POST' }); } catch {}
  detenerPollingUpdate();
  updatePollTimer = setInterval(pollUpdateStatus, 1200);
}

// ── Menu del engranaje (actualizar / cambiar encargado) ──────────────

function toggleHeaderMenu(e) {
  if (e) e.stopPropagation();
  document.getElementById('header-menu').classList.toggle('header-menu-hidden');
}

function cerrarHeaderMenu() {
  document.getElementById('header-menu').classList.add('header-menu-hidden');
}

// ── Tabs (Registro / Gantt / Ocupación / Horas-Persona) ──────────────

function switchTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.add('tab-panel-hidden'));
  document.getElementById('panel-' + tab).classList.remove('tab-panel-hidden');

  if (tab === 'gantt') {
    actualizarGanttPersonaActual();
    ensureGanttRegistros().then(() => { renderGanttCalendar(); renderGanttDias(); });
  } else if (tab === 'ocupacion') {
    ensureGanttRegistros().then(renderOcupacion);
  } else if (tab === 'horas') {
    ensureGanttRegistros().then(renderHorasPersona);
  } else if (tab === 'historial') {
    ensureGanttRegistros().then(renderHistorial);
  }
}

// ── Gantt: estado y carga de datos ────────────────────────────────────

let ganttRegistros = null;       // cache completa de Registros (se carga una sola vez)
let histPersonaId = null;        // si hay alguien fijado (via boton 🗂 de Registro), Historial solo muestra sus registros
let ganttPersonaId = null;
let ganttFiltro = '';
let ganttFechas = new Set();     // fechas 'YYYY-MM-DD' seleccionadas
let ganttCalYear = null, ganttCalMonth = null; // mes mostrado en el calendario

const SECTION_PALETTE = ['#1565C0','#2E7D32','#AD1457','#6A1B9A','#00838F','#EF6C00','#5D4037','#455A64','#827717','#C62828'];
const COLOR_EXTERIOR = '#757575';

// ganttRegistrosPromise evita pedidos duplicados: si el encargado cambia
// de pestaña (Gantt/Ocupación/Horas-Persona) varias veces antes de que la
// primera consulta termine de llegar, todas esas llamadas esperan el MISMO
// pedido en curso en vez de disparar uno nuevo cada vez.
let ganttRegistrosPromise = null;

async function ensureGanttRegistros() {
  if (ganttRegistros) return;
  if (!ganttRegistrosPromise) {
    ganttRegistrosPromise = apiGas('get_registros', {})
      .then(res => { ganttRegistros = res.registros || []; })
      .finally(() => { ganttRegistrosPromise = null; });
  }
  return ganttRegistrosPromise;
}

// Los datos de Gantt/Ocupación/Horas-Persona (ganttRegistros) y el padron
// completo de personal (personalTodos) se traen UNA sola vez y se guardan
// en memoria: cambiar de pestaña, elegir fechas o hacer click en un bloque
// NO vuelve a consultar el servidor, todo se recalcula aca en la compu.
// Solo se vuelve a pedir cuando:
//  1) este mismo encargado acaba de registrar algo (se invalida sola, ver
//     invalidarCacheCompartida), o
//  2) el encargado presiona a mano el boton "↻ Actualizar" (por si otro
//     encargado registro algo mientras tanto).
function invalidarCacheCompartida() {
  ganttRegistros = null;
  personalTodos = null;
  recargarPersonalTodos();
}

function recargarPersonalTodos() {
  return apiGas('get_personal_estado', {}).then(res => {
    personalTodos = res.personal;
    if (!document.getElementById('agregar-dropdown').classList.contains('agregar-dropdown-hidden')) {
      renderDropdownAgregar();
    }
    if (!document.getElementById('gantt-dropdown').classList.contains('agregar-dropdown-hidden')) {
      renderGanttDropdown();
    }
  }).catch(() => {});
}

// Boton global "↻" (siempre visible, al lado de las pestañas): unico
// punto donde se le vuelve a pedir TODO al servidor a pedido explicito
// del encargado, sea cual sea la pestaña en la que este parado.
async function actualizarTodo() {
  toast('Actualizando datos…');
  try {
    const tareas = [apiGas('get_registros', {}), recargarPersonalTodos()];
    if (!document.getElementById('panel-registro').classList.contains('tab-panel-hidden') && config) {
      tareas.push(loadPersonal());
    }
    const [regs] = await Promise.all(tareas);
    ganttRegistros = regs.registros || [];

    if (!document.getElementById('panel-gantt').classList.contains('tab-panel-hidden')) {
      renderGanttCalendar();
      renderGanttDias();
    }
    if (!document.getElementById('panel-ocupacion').classList.contains('tab-panel-hidden')) {
      await renderOcupacion();
    }
    if (!document.getElementById('panel-horas').classList.contains('tab-panel-hidden')) {
      await renderHorasPersona();
    }
    if (!document.getElementById('panel-historial').classList.contains('tab-panel-hidden')) {
      renderHistorial();
    }
    toast('✓ Datos actualizados.');
  } catch (err) {
    toast('⚠ ' + err.message);
  }
}

function colorSeccion(id_seccion) {
  const idx = catalogos.secciones.findIndex(s => String(s.id_seccion) === String(id_seccion));
  return SECTION_PALETTE[(idx >= 0 ? idx : 0) % SECTION_PALETTE.length];
}

function motivoEsInterno(id_motivo) {
  const m = catalogos.tipos_salida.find(t => String(t.id_motivo) === String(id_motivo));
  return !!(m && m.clasificacion === 'Interna');
}

// Reconstruye, para una persona y una fecha, los bloques ENTRADA→SALIDA por sección
// y los bloques "exterior" (cuando la salida no es un cambio de sección interno).
function buildGanttBloques(id_persona, fecha) {
  const recs = (ganttRegistros || [])
    .filter(r => r.id_persona === id_persona && r.fecha === fecha && !r.anulado)
    .sort((a, b) => a.timestamp < b.timestamp ? -1 : (a.timestamp > b.timestamp ? 1 : 0));

  const bloques = [];
  let cur = null;

  recs.forEach(r => {
    const t = new Date(r.timestamp).getTime();
    if (r.id_tipo === 'ENTRADA') {
      if (cur) bloques.push({ ...cur, end: t, comentarioCierre: r.comentarios || '' });
      cur = { fila: 'seccion', id_seccion: r.id_seccion, start: t, comentario: r.comentarios || '' };
    } else {
      if (cur) bloques.push({ ...cur, end: t, comentarioCierre: r.comentarios || '' });
      if (motivoEsInterno(r.id_motivo)) {
        cur = null;
      } else {
        cur = { fila: 'exterior', id_motivo: r.id_motivo, start: t, comentario: r.comentarios || '' };
      }
    }
  });

  return { bloques, abierto: cur };
}

// Rango de horario "normal" a mostrar por defecto en el Gantt, segun el dia:
// lunes a viernes: primer turno 07:00-15:00 + segundo turno 14:30-22:00 -> 07:00-22:00.
// sabado: solo primer turno -> 07:00-15:00.
// domingo: no se trabaja -> rango minimo (si hubiera registros ese dia, un caso
// extremo, el dibujo se extiende solo igual por los bloques reales, ver mas abajo).
function rangoHorarioDia(fecha) {
  const dow = new Date(fecha + 'T12:00:00').getDay(); // 0=domingo … 6=sabado
  if (dow === 0) return { desde: 7 * 60, hasta: 9 * 60 };
  if (dow === 6) return { desde: 7 * 60, hasta: 15 * 60 };
  return { desde: 7 * 60, hasta: 22 * 60 };
}

// Descuento de almuerzo: dinámico por horario (igual al proyecto anterior).
// Ventana 12:00–14:30; si alguna sección acumula ≥30 min de solape, se descuenta
// un bloque FIJO de 30 min de la sección con mayor solape.
function calcAlmuerzoDia(id_persona, fecha) {
  const LUNCH_START = 12 * 60, LUNCH_END = 14 * 60 + 30, MIN_THRESH = 30;
  const { bloques, abierto } = buildGanttBloques(id_persona, fecha);
  const medianoche = new Date(fecha + 'T00:00:00').getTime();
  const ahora = Date.now();
  const todos = abierto ? [...bloques, { ...abierto, end: Math.min(abierto.start + 16 * 3600000, medianoche + 24 * 3600000, ahora) }] : bloques;

  const secMin = new Map();
  todos.filter(b => b.fila === 'seccion').forEach(b => {
    const bStart = (b.start - medianoche) / 60000;
    const bEnd = (b.end - medianoche) / 60000;
    const ovStart = Math.max(bStart, LUNCH_START), ovEnd = Math.min(bEnd, LUNCH_END);
    if (ovEnd > ovStart) secMin.set(b.id_seccion, (secMin.get(b.id_seccion) || 0) + (ovEnd - ovStart));
  });

  let bestSec = null, bestMin = 0;
  secMin.forEach((min, sec) => { if (min >= MIN_THRESH && min > bestMin) { bestSec = sec; bestMin = min; } });
  if (bestSec === null) return null;
  return { id_seccion: bestSec, startMs: medianoche + LUNCH_START * 60000, endMs: medianoche + (LUNCH_START + 30) * 60000 };
}

function resumenHorasDia(id_persona, fecha) {
  const { bloques, abierto } = buildGanttBloques(id_persona, fecha);
  const medianoche = new Date(fecha + 'T00:00:00').getTime();
  const ahora = Date.now();
  const todos = abierto ? [...bloques, { ...abierto, end: Math.min(abierto.start + 16 * 3600000, medianoche + 24 * 3600000, ahora) }] : bloques;
  let totalMs = 0;
  todos.filter(b => b.fila === 'seccion').forEach(b => { totalMs += Math.max(0, b.end - b.start); });
  const almuerzo = calcAlmuerzoDia(id_persona, fecha);
  if (almuerzo) totalMs -= 30 * 60000;
  totalMs = Math.max(0, totalMs);
  const h = Math.floor(totalMs / 3600000), m = Math.floor((totalMs % 3600000) / 60000);
  return almuerzo ? `Total: ${h}h ${m}m (−30m almuerzo)` : `Total: ${h}h ${m}m`;
}

function horaCorta(ms) {
  return new Intl.DateTimeFormat('es-BO', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).format(new Date(ms));
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// ── Gantt: detalle de un bloque al hacer click ────────────────────────
// ganttBloquesRender guarda, por fecha, el array de bloques efectivamente
// dibujados en ese panel (con su comentario de apertura/cierre), para que
// el click en un <rect> (que solo puede llevar datos simples en el
// onclick) pueda ir a buscar el detalle completo por indice.
let ganttBloquesRender = {};

function mostrarDetalleBloque(evt, fecha, idx) {
  evt.stopPropagation();
  const b = (ganttBloquesRender[fecha] || [])[idx];
  if (!b) return;
  cerrarDetalleBloque();

  const esExterior = b.fila === 'exterior';
  const horaIni = horaCorta(b.start);
  const horaFin = b.enCurso ? 'en curso' : horaCorta(b.end);
  const fechaLegible = new Date(fecha + 'T12:00:00').toLocaleDateString('es-BO', { day: '2-digit', month: '2-digit', year: 'numeric' });

  let filas = '';
  filas += `<div class="gantt-detalle-fila"><strong>${esExterior ? 'Salida por' : 'Sección'}:</strong> ${escapeHtml(esExterior ? motivoNombre(b.id_motivo) : seccionNombre(b.id_seccion))}</div>`;
  filas += `<div class="gantt-detalle-fila"><strong>Fecha:</strong> ${escapeHtml(fechaLegible)}</div>`;
  filas += `<div class="gantt-detalle-fila"><strong>Desde:</strong> ${escapeHtml(horaIni)}</div>`;
  filas += `<div class="gantt-detalle-fila"><strong>Hasta:</strong> ${escapeHtml(horaFin)}</div>`;
  if (b.comentario) {
    filas += `<div class="gantt-detalle-fila"><strong>Comentario al ${esExterior ? 'salir' : 'entrar'}:</strong> ${escapeHtml(b.comentario)}</div>`;
  }
  if (b.comentarioCierre) {
    filas += `<div class="gantt-detalle-fila"><strong>Comentario al ${esExterior ? 'volver' : 'salir'}:</strong> ${escapeHtml(b.comentarioCierre)}</div>`;
  }

  const pop = document.createElement('div');
  pop.className = 'gantt-detalle-pop';
  pop.id = 'gantt-detalle-pop';
  pop.innerHTML = `<button class="gantt-detalle-cerrar" onclick="cerrarDetalleBloque()">✕</button>${filas}`;
  document.body.appendChild(pop);

  const maxLeft = window.innerWidth - pop.offsetWidth - 12;
  const left = Math.max(8, Math.min(evt.clientX + 10, maxLeft));
  const maxTop = window.innerHeight - 12;
  pop.style.left = left + 'px';
  pop.style.top = Math.min(evt.clientY + 10, maxTop - 20) + 'px';

  setTimeout(() => document.addEventListener('click', onClickFueraDetalleBloque), 0);
}

function onClickFueraDetalleBloque(e) {
  const pop = document.getElementById('gantt-detalle-pop');
  if (pop && !pop.contains(e.target)) cerrarDetalleBloque();
}

function cerrarDetalleBloque() {
  const pop = document.getElementById('gantt-detalle-pop');
  if (pop) pop.remove();
  document.removeEventListener('click', onClickFueraDetalleBloque);
}

// ── Gantt: selector de persona (dropdown reutilizando el patrón de "agregar") ──

function renderGanttDropdown() {
  const cont = document.getElementById('gantt-dropdown');
  if (!personalTodos) { cont.innerHTML = '<div class="dropdown-vacio">Cargando personal de toda la planta…</div>'; return; }
  let candidatos = personalTodos;
  if (ganttFiltro) {
    const f = ganttFiltro.toLowerCase();
    candidatos = candidatos.filter(p => p.nombre.toLowerCase().includes(f) || String(p.id_persona).includes(f));
  }
  const limite = 40;
  const mostrar = candidatos.slice(0, limite);
  cont.innerHTML = mostrar.length
    ? mostrar.map(p => `
        <div class="dropdown-item" onclick="elegirPersonaGantt('${p.id_persona}')">
          <div class="dropdown-item-info"><span class="row-nombre">${p.nombre}</span><span class="row-id">#${p.id_persona}</span></div>
        </div>`).join('') + (candidatos.length > limite ? `<div class="dropdown-vacio">… y ${candidatos.length - limite} más. Escribí para filtrar.</div>` : '')
    : '<div class="dropdown-vacio">Sin coincidencias.</div>';
}

function mostrarGanttDropdown() {
  document.getElementById('gantt-dropdown').classList.remove('agregar-dropdown-hidden');
  renderGanttDropdown();
  setTimeout(() => document.addEventListener('click', onClickFueraGanttDropdown), 0);
}

function ocultarGanttDropdown() {
  document.getElementById('gantt-dropdown').classList.add('agregar-dropdown-hidden');
  document.removeEventListener('click', onClickFueraGanttDropdown);
}

function onClickFueraGanttDropdown(e) {
  const wrap = document.getElementById('gantt-persona-wrap');
  if (!e.composedPath().includes(wrap)) ocultarGanttDropdown();
}

function elegirPersonaGantt(id_persona) {
  const p = personalTodos && personalTodos.find(p => p.id_persona === id_persona);
  if (!p) return;
  ganttPersonaId = id_persona;
  document.getElementById('gantt-search').value = '';
  ganttFiltro = '';
  ocultarGanttDropdown();
  actualizarGanttPersonaActual();
  renderGanttCalendar();
  renderGanttDias();
}

function actualizarGanttPersonaActual() {
  const el = document.getElementById('gantt-persona-actual');
  if (!ganttPersonaId) { el.textContent = 'Elegí una persona para ver su Gantt.'; return; }
  const p = (personalTodos && personalTodos.find(p => p.id_persona === ganttPersonaId))
    || personal.find(p => p.id_persona === ganttPersonaId);
  el.innerHTML = p ? `<strong>${p.nombre}</strong> <span class="row-id">#${p.id_persona}</span>` : `#${ganttPersonaId}`;
}

// Abrir el Gantt de una persona desde el botón 📊 de la lista de Registro.
function abrirGanttDesdeRegistro(id_persona) {
  ganttPersonaId = id_persona;
  ganttFechas = new Set([fechaHoyLaPaz()]);
  const hoy = new Date();
  ganttCalYear = hoy.getFullYear();
  ganttCalMonth = hoy.getMonth();
  switchTab('gantt');
}

// Abrir el Historial de una persona desde el botón 🗂 de la lista de
// Registro: en vez de tener que escribir su nombre en el buscador del
// Historial, un solo click ya te deja viendo (y lista para editar/anular)
// TODA su lista de registros.
function abrirHistorialDesdeRegistro(id_persona) {
  histPersonaId = id_persona;
  switchTab('historial');
}

function limpiarPersonaHistorial() {
  histPersonaId = null;
  renderHistorial();
}

// ── Gantt: calendario dinámico (resalta días con registros de la persona elegida) ──

function fechasConDatos(id_persona) {
  const set = new Set();
  (ganttRegistros || []).forEach(r => { if (r.id_persona === id_persona && !r.anulado) set.add(r.fecha); });
  return set;
}

function renderGanttCalendar() {
  const cal = document.getElementById('gantt-calendar');
  const label = document.getElementById('gantt-cal-label');
  if (ganttCalYear == null) {
    const hoy = new Date();
    ganttCalYear = hoy.getFullYear();
    ganttCalMonth = hoy.getMonth();
  }
  const meses = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  label.textContent = `${meses[ganttCalMonth]} ${ganttCalYear}`;

  const primerDia = new Date(ganttCalYear, ganttCalMonth, 1);
  const offset = (primerDia.getDay() + 6) % 7; // semana empieza en lunes
  const diasEnMes = new Date(ganttCalYear, ganttCalMonth + 1, 0).getDate();
  const conDatos = ganttPersonaId ? fechasConDatos(ganttPersonaId) : new Set();
  const hoyStr = fechaHoyLaPaz();

  let celdas = [];
  for (let i = 0; i < offset; i++) celdas.push('<span class="gantt-cal-vacio"></span>');
  for (let d = 1; d <= diasEnMes; d++) {
    const fechaStr = `${ganttCalYear}-${String(ganttCalMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const clases = ['gantt-cal-dia'];
    if (conDatos.has(fechaStr)) clases.push('gantt-cal-con-datos');
    if (ganttFechas.has(fechaStr)) clases.push('gantt-cal-sel');
    if (fechaStr === hoyStr) clases.push('gantt-cal-hoy');
    celdas.push(`<span class="${clases.join(' ')}" onclick="toggleFechaGantt('${fechaStr}')">${d}</span>`);
  }
  cal.innerHTML = celdas.join('');
}

function ganttCalMes(delta) {
  if (ganttCalMonth == null) { renderGanttCalendar(); }
  ganttCalMonth += delta;
  if (ganttCalMonth < 0) { ganttCalMonth = 11; ganttCalYear--; }
  if (ganttCalMonth > 11) { ganttCalMonth = 0; ganttCalYear++; }
  renderGanttCalendar();
}

function toggleFechaGantt(fechaStr) {
  if (ganttFechas.has(fechaStr)) ganttFechas.delete(fechaStr);
  else ganttFechas.add(fechaStr);
  renderGanttCalendar();
  renderGanttDias();
}

// ── Gantt: dibujo del diagrama (SVG a mano, filas por sección + fila Exterior) ──

function renderGanttDias() {
  const cont = document.getElementById('gantt-dias');
  const leyenda = document.getElementById('gantt-legend');

  leyenda.innerHTML = catalogos.secciones.map(s =>
    `<span class="gantt-leyenda-item"><span class="gantt-leyenda-dot" style="background:${colorSeccion(s.id_seccion)}"></span>${s.nombre}</span>`
  ).join('') + `<span class="gantt-leyenda-item"><span class="gantt-leyenda-dot" style="background:${COLOR_EXTERIOR}"></span>Exterior (permiso / caja / RRHH / etc.)</span>`;

  if (!ganttPersonaId) {
    cont.innerHTML = '<div class="dropdown-vacio">Elegí una persona arriba para ver su diagrama.</div>';
    return;
  }
  if (!ganttFechas.size) {
    cont.innerHTML = '<div class="dropdown-vacio">Elegí al menos un día en el calendario.</div>';
    return;
  }

  const fechasOrdenadas = [...ganttFechas].sort();
  cont.innerHTML = fechasOrdenadas.map(f => renderGanttDiaSvg(f)).join('');
}

function renderGanttDiaSvg(fecha) {
  const { bloques, abierto } = buildGanttBloques(ganttPersonaId, fecha);
  const medianoche = new Date(fecha + 'T00:00:00').getTime();
  const ahora = Date.now();
  let { desde, hasta } = rangoHorarioDia(fecha);

  const todos = abierto
    ? [...bloques, { ...abierto, end: Math.min(abierto.start + 16 * 3600000, medianoche + 24 * 3600000, ahora), enCurso: true }]
    : bloques;

  todos.forEach(b => {
    const sMin = (b.start - medianoche) / 60000;
    const eMin = (b.end - medianoche) / 60000;
    if (sMin < desde) desde = Math.max(0, Math.floor(sMin / 60) * 60);
    if (eMin > hasta) hasta = Math.min(24 * 60, Math.ceil(eMin / 60) * 60);
  });

  const filas = [
    ...catalogos.secciones.map(s => ({ tipo: 'seccion', id: String(s.id_seccion), nombre: s.nombre })),
    { tipo: 'exterior', id: null, nombre: 'Exterior' }
  ];

  const rowH = 24, rowGap = 4, leftLabel = 110, topAxis = 22, width = 760;
  const totalMin = Math.max(1, hasta - desde);
  const px = min => leftLabel + ((min - desde) / totalMin) * (width - leftLabel);
  const svgH = topAxis + filas.length * (rowH + rowGap);

  let ejeMarks = '';
  for (let m = Math.ceil(desde / 60) * 60; m <= hasta; m += 120) {
    const x = px(m);
    const hh = Math.floor(m / 60);
    ejeMarks += `<line x1="${x}" y1="${topAxis}" x2="${x}" y2="${svgH}" stroke="#E0E0E0" stroke-width="1"/>`;
    ejeMarks += `<text x="${x}" y="14" font-size="10" fill="#757575" text-anchor="middle">${String(hh).padStart(2, '0')}:00</text>`;
  }

  let filasHtml = '';
  filas.forEach((f, i) => {
    const y = topAxis + i * (rowH + rowGap);
    filasHtml += `<rect x="${leftLabel}" y="${y}" width="${width - leftLabel}" height="${rowH}" fill="#FAFAFA"/>`;
    filasHtml += `<text x="${leftLabel - 6}" y="${y + rowH / 2 + 4}" font-size="11" fill="#424242" text-anchor="end">${escapeHtml(f.nombre)}</text>`;
  });

  ganttBloquesRender[fecha] = todos;

  let bloquesHtml = '';
  todos.forEach((b, i) => {
    const filaIdx = b.fila === 'exterior' ? filas.length - 1 : filas.findIndex(f => f.tipo === 'seccion' && f.id === String(b.id_seccion));
    if (filaIdx < 0) return;
    const y = topAxis + filaIdx * (rowH + rowGap);
    const x1 = px(Math.max(desde, (b.start - medianoche) / 60000));
    const x2 = px(Math.min(hasta, (b.end - medianoche) / 60000));
    const color = b.fila === 'exterior' ? COLOR_EXTERIOR : colorSeccion(b.id_seccion);
    const etiqueta = b.fila === 'exterior' ? motivoNombre(b.id_motivo) : '';
    const w = Math.max(2, x2 - x1);
    bloquesHtml += `<rect x="${x1}" y="${y}" width="${w}" height="${rowH}" rx="4" fill="${color}" opacity="${b.enCurso ? 0.75 : 1}" style="cursor:pointer" onclick="mostrarDetalleBloque(event, '${fecha}', ${i})"><title>${escapeHtml(horaCorta(b.start))}–${b.enCurso ? 'en curso' : escapeHtml(horaCorta(b.end))}${etiqueta ? ' · ' + escapeHtml(etiqueta) : ''} (clic para más detalle)</title></rect>`;
    if (etiqueta && w > 40) {
      bloquesHtml += `<text x="${x1 + 6}" y="${y + rowH / 2 + 4}" font-size="10" fill="#fff" style="pointer-events:none">${escapeHtml(etiqueta)}</text>`;
    }
  });

  const almuerzo = calcAlmuerzoDia(ganttPersonaId, fecha);
  let almuerzoHtml = '';
  if (almuerzo) {
    const filaIdx = filas.findIndex(f => f.tipo === 'seccion' && f.id === String(almuerzo.id_seccion));
    if (filaIdx >= 0) {
      const y = topAxis + filaIdx * (rowH + rowGap);
      const x1 = px((almuerzo.startMs - medianoche) / 60000);
      const x2 = px((almuerzo.endMs - medianoche) / 60000);
      const w = Math.max(2, x2 - x1);
      almuerzoHtml = `<rect x="${x1}" y="${y}" width="${w}" height="${rowH}" rx="4" fill="#D32F2F" opacity="0.55"/><text x="${x1 + w / 2}" y="${y + rowH / 2 + 4}" font-size="10" fill="#fff" text-anchor="middle">−30m</text>`;
    }
  }

  const fechaLegible = new Date(fecha + 'T12:00:00').toLocaleDateString('es-BO', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  const totalTxt = resumenHorasDia(ganttPersonaId, fecha);

  return `
    <div class="gantt-dia-panel">
      <div class="gantt-dia-header">
        <span class="gantt-dia-fecha">${capitalize(fechaLegible)}</span>
        <span class="gantt-dia-total">${totalTxt}</span>
      </div>
      <svg width="${width}" height="${svgH}" viewBox="0 0 ${width} ${svgH}">
        ${ejeMarks}
        ${filasHtml}
        ${bloquesHtml}
        ${almuerzoHtml}
      </svg>
    </div>`;
}

// ── Ocupación: quién estuvo en cada sección en una fecha dada ────────

async function renderOcupacion() {
  const fechaInput = document.getElementById('ocup-fecha');
  if (!fechaInput.value) fechaInput.value = fechaHoyLaPaz();
  const fecha = fechaInput.value;

  if (!personalTodos) { document.getElementById('ocup-tablas').innerHTML = '<div class="dropdown-vacio">Cargando personal…</div>'; return; }

  const porSeccion = new Map();
  catalogos.secciones.forEach(s => porSeccion.set(String(s.id_seccion), []));

  personalTodos.forEach(p => {
    const { bloques, abierto } = buildGanttBloques(p.id_persona, fecha);
    if (!bloques.length && !abierto) return;
    const medianoche = new Date(fecha + 'T00:00:00').getTime();
    const ahora = Date.now();
    const todos = abierto ? [...bloques, { ...abierto, end: Math.min(abierto.start + 16 * 3600000, medianoche + 24 * 3600000, ahora), enCurso: true }] : bloques;
    todos.filter(b => b.fila === 'seccion').forEach(b => {
      const lista = porSeccion.get(String(b.id_seccion));
      if (!lista) return;
      lista.push({ nombre: p.nombre, id_persona: p.id_persona, start: b.start, end: b.end, enCurso: !!b.enCurso });
    });
  });

  const cont = document.getElementById('ocup-tablas');
  cont.innerHTML = catalogos.secciones.map(s => {
    const filas = (porSeccion.get(String(s.id_seccion)) || []).slice().sort((a, b) => a.start - b.start);
    if (!filas.length) {
      return `<div class="ocup-seccion"><h3>${s.nombre}</h3><div class="dropdown-vacio">Sin movimientos ese día.</div></div>`;
    }
    const filasHtml = filas.map(f => {
      const ms = f.end - f.start;
      const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000);
      return `<tr><td>${f.nombre}</td><td>${horaCorta(f.start)}</td><td>${f.enCurso ? 'en curso' : horaCorta(f.end)}</td><td>${h}h ${m}m</td></tr>`;
    }).join('');
    return `<div class="ocup-seccion">
      <h3>${s.nombre} <span class="ocup-count">(${filas.length})</span></h3>
      <table class="ocup-table"><thead><tr><th>Persona</th><th>Entrada</th><th>Salida</th><th>Horas</th></tr></thead>
      <tbody>${filasHtml}</tbody></table>
    </div>`;
  }).join('');
}

// ── Horas-Persona: total de horas netas (ya con descuento de almuerzo) por rango de fechas ──

async function renderHorasPersona() {
  const desdeInput = document.getElementById('horas-desde');
  const hastaInput = document.getElementById('horas-hasta');
  if (!desdeInput.value) desdeInput.value = fechaHoyLaPaz();
  if (!hastaInput.value) hastaInput.value = fechaHoyLaPaz();
  const desde = desdeInput.value, hasta = hastaInput.value;

  if (!personalTodos || !ganttRegistros) { document.getElementById('horas-tabla').innerHTML = '<div class="dropdown-vacio">Cargando…</div>'; return; }

  const fechasEnRango = [...new Set(ganttRegistros.map(r => r.fecha))].filter(f => f >= desde && f <= hasta).sort();

  const filas = personalTodos.map(p => {
    let totalMs = 0, dias = 0;
    fechasEnRango.forEach(f => {
      const { bloques, abierto } = buildGanttBloques(p.id_persona, f);
      if (!bloques.length && !abierto) return;
      const medianoche = new Date(f + 'T00:00:00').getTime();
      const ahora = Date.now();
      const todos = abierto ? [...bloques, { ...abierto, end: Math.min(abierto.start + 16 * 3600000, medianoche + 24 * 3600000, ahora) }] : bloques;
      let msDia = 0;
      todos.filter(b => b.fila === 'seccion').forEach(b => { msDia += Math.max(0, b.end - b.start); });
      const almuerzo = calcAlmuerzoDia(p.id_persona, f);
      if (almuerzo) msDia -= 30 * 60000;
      msDia = Math.max(0, msDia);
      if (msDia > 0) { totalMs += msDia; dias++; }
    });
    return { nombre: p.nombre, id_persona: p.id_persona, totalMs, dias };
  }).filter(f => f.totalMs > 0).sort((a, b) => b.totalMs - a.totalMs);

  const cont = document.getElementById('horas-tabla');
  if (!filas.length) { cont.innerHTML = '<div class="dropdown-vacio">Sin movimientos en ese rango.</div>'; return; }

  cont.innerHTML = `<table class="ocup-table"><thead><tr><th>Persona</th><th>Días con registro</th><th>Total horas</th><th>Promedio/día</th></tr></thead><tbody>
    ${filas.map(f => {
      const h = Math.floor(f.totalMs / 3600000), m = Math.floor((f.totalMs % 3600000) / 60000);
      const promMs = f.totalMs / f.dias;
      const ph = Math.floor(promMs / 3600000), pm = Math.floor((promMs % 3600000) / 60000);
      return `<tr><td>${f.nombre}</td><td>${f.dias}</td><td>${h}h ${m}m</td><td>${ph}h ${pm}m</td></tr>`;
    }).join('')}
  </tbody></table>`;
}

// ── Historial: tabla con TODOS los registros, editable/anulable ───────
// Reusa el cache compartido (ganttRegistros/personalTodos) igual que
// Gantt/Ocupación/Horas-Persona: no vuelve a pedir nada al servidor
// salvo que se presione "↻ Actualizar" (o se guarde/anule algo, que
// invalida el cache y lo vuelve a traer una sola vez).

let histLockInterval = null; // heartbeat del candado mientras el popup de edicion esta abierto
let histEditandoId = null;   // id_registro que esta en edicion ahora mismo

function nombrePersonaHist(id_persona) {
  const p = (personalTodos || []).find(x => String(x.id_persona) === String(id_persona));
  return p ? p.nombre : ('#' + id_persona);
}

function nombreEncargado(id_encargado) {
  const e = (catalogos.encargados || []).find(x => String(x.id_encargado) === String(id_encargado));
  return e ? e.nombre : ('#' + id_encargado);
}

function limpiarFechaHistorial() {
  document.getElementById('hist-fecha').value = '';
  renderHistorial();
}

function renderHistorial() {
  const cont = document.getElementById('hist-tabla');

  // Chip "Mostrando: NOMBRE ✕" cuando se llega aca con el boton 🗂 de una
  // fila de Registro: mientras esta fijado, oculta el buscador de texto
  // (no hace falta, ya sabemos de quien se trata) y solo deja ese filtro.
  const chip = document.getElementById('hist-persona-chip');
  const busquedaInput = document.getElementById('hist-busqueda');
  if (histPersonaId) {
    document.getElementById('hist-persona-chip-nombre').textContent = nombrePersonaHist(histPersonaId);
    chip.classList.remove('hist-persona-chip-hidden');
    busquedaInput.classList.add('hist-busqueda-oculta');
  } else {
    chip.classList.add('hist-persona-chip-hidden');
    busquedaInput.classList.remove('hist-busqueda-oculta');
  }

  if (!ganttRegistros || !personalTodos) { cont.innerHTML = '<div class="dropdown-vacio">Cargando…</div>'; return; }

  const fecha = document.getElementById('hist-fecha').value; // vacio = todas las fechas
  const verAnulados = document.getElementById('hist-ver-anulados').checked;
  const busqueda = (busquedaInput.value || '').trim().toLowerCase();

  let filas = ganttRegistros;
  if (fecha) filas = filas.filter(r => r.fecha === fecha);
  if (!verAnulados) filas = filas.filter(r => !r.anulado);
  if (histPersonaId) {
    filas = filas.filter(r => String(r.id_persona) === String(histPersonaId));
  } else if (busqueda) {
    filas = filas.filter(r => nombrePersonaHist(r.id_persona).toLowerCase().includes(busqueda));
  }
  filas = filas.slice().sort((a, b) => a.timestamp < b.timestamp ? 1 : (a.timestamp > b.timestamp ? -1 : 0));

  if (!filas.length) { cont.innerHTML = '<div class="dropdown-vacio">Sin registros con ese filtro.</div>'; return; }

  cont.innerHTML = `<table class="ocup-table hist-table"><thead><tr>
      <th>Persona</th><th>Fecha</th><th>Hora</th><th>Tipo</th><th>Sección</th><th>Motivo</th><th>Comentario</th><th>Encargado</th><th></th>
    </tr></thead><tbody>${filas.map(filaHistorialHtml).join('')}</tbody></table>`;
}

function filaHistorialHtml(r) {
  const tipoLabel = r.id_tipo === 'ENTRADA' ? 'Entrada' : 'Salida';
  const motivoLabel = r.id_motivo ? motivoNombre(r.id_motivo) : '—';
  const hora = horaDeTimestampLaPaz(r.timestamp);
  const acciones = r.anulado
    ? `<span class="hist-anulado-badge" title="${escapeHtml('Anulado por ' + nombreEncargado(r.anulado_por))}">Anulado</span>`
    : `<button class="btn-sm" onclick="abrirEdicionHistorial('${r.id_registro}')" title="Editar">✏️</button>
       <button class="btn-sm" onclick="confirmarAnular('${r.id_registro}')" title="Anular">🗑️</button>`;
  return `<tr class="${r.anulado ? 'hist-row-anulado' : ''}">
    <td>${escapeHtml(nombrePersonaHist(r.id_persona))}</td>
    <td>${fechaCortaDDMM(r.fecha)}</td>
    <td>${hora}</td>
    <td>${tipoLabel}</td>
    <td>${escapeHtml(seccionNombre(r.id_seccion))}</td>
    <td>${escapeHtml(motivoLabel)}</td>
    <td>${escapeHtml(r.comentarios || '')}</td>
    <td>${escapeHtml(nombreEncargado(r.id_encargado))}</td>
    <td class="hist-acciones">${acciones}</td>
  </tr>`;
}

// Despues de anular/editar: el estado actual de la persona (Registro tab)
// puede haber cambiado, asi que se recarga igual que tras un registro
// normal, y se refresca el cache compartido para Gantt/Ocupación/Horas.
async function refrescarTrasEdicionHistorial() {
  await loadPersonal();
  ganttRegistros = null;
  await ensureGanttRegistros();
  renderHistorial();
}

async function confirmarAnular(id_registro) {
  const r = (ganttRegistros || []).find(x => String(x.id_registro) === String(id_registro));
  if (!r) return;
  const nombre = nombrePersonaHist(r.id_persona);
  const hora = horaDeTimestampLaPaz(r.timestamp);
  const ok = confirm(`¿Anular este registro de ${nombre} (${fechaCortaDDMM(r.fecha)} ${hora})?\n\nNo se borra: queda guardado para poder revisarlo despues, pero ya no cuenta en el Gantt, Ocupación ni Horas-Persona.`);
  if (!ok) return;

  try {
    const res = await apiGas('anular_registro', { id_registro, id_encargado: config.id_encargado });
    toast(res.ya_estaba_anulado ? 'Ese registro ya estaba anulado.' : '✓ Registro anulado.');
    await refrescarTrasEdicionHistorial();
  } catch (err) {
    toast('⚠ ' + err.message);
  }
}

// Pide el candado de edicion al servidor antes de mostrar el popup. Si
// otro encargado lo tiene vigente (hace menos de ~2 min), no deja editar
// y avisa quien lo tiene — asi dos encargados no se pisan el mismo
// registro al mismo tiempo.
async function abrirEdicionHistorial(id_registro) {
  cerrarEdicionHistorial();
  const r = (ganttRegistros || []).find(x => String(x.id_registro) === String(id_registro));
  if (!r) return;

  let res;
  try {
    res = await apiGas('tomar_lock', { id_registro, id_encargado: config.id_encargado });
  } catch (err) {
    toast('⚠ ' + err.message);
    return;
  }
  if (!res.concedido) {
    toast(`🔒 ${nombreEncargado(res.bloqueado_por)} está editando este registro (hace ${res.hace_segundos}s). Probá en un momento.`);
    return;
  }

  histEditandoId = id_registro;
  histLockInterval = setInterval(() => {
    apiGas('refrescar_lock', { id_registro, id_encargado: config.id_encargado }).catch(() => {});
  }, 60000);

  const seccionOptions = catalogos.secciones
    .map(s => `<option value="${s.id_seccion}" ${String(r.id_seccion) === String(s.id_seccion) ? 'selected' : ''}>${s.nombre}</option>`).join('');
  const motivoOptions = catalogos.tipos_salida
    .map(m => `<option value="${m.id_motivo}" ${String(r.id_motivo) === String(m.id_motivo) ? 'selected' : ''}>${m.nombre}</option>`).join('');

  const overlay = document.createElement('div');
  overlay.className = 'hist-edit-overlay';
  overlay.id = 'hist-edit-overlay';
  overlay.innerHTML = `
    <div class="hist-edit-pop" onclick="event.stopPropagation()">
      <div class="hist-edit-label">Editando registro de ${escapeHtml(nombrePersonaHist(r.id_persona))}</div>
      <div class="hist-edit-grid">
        <label>Fecha<input type="date" id="hist-edit-fecha" value="${r.fecha}"/></label>
        <label>Hora<input type="time" id="hist-edit-hora" step="60" value="${horaDeTimestampLaPaz(r.timestamp)}"/></label>
        <label>Tipo
          <select id="hist-edit-tipo">
            <option value="ENTRADA" ${r.id_tipo === 'ENTRADA' ? 'selected' : ''}>Entrada</option>
            <option value="SALIDA" ${r.id_tipo === 'SALIDA' ? 'selected' : ''}>Salida</option>
          </select>
        </label>
        <label>Sección<select id="hist-edit-seccion">${seccionOptions}</select></label>
        <label>Motivo<select id="hist-edit-motivo"><option value="">— (sin motivo / cambio de sección)</option>${motivoOptions}</select></label>
        <label>Comentario<input type="text" id="hist-edit-comentario" value="${escapeHtml(r.comentarios || '')}"/></label>
      </div>
      <div class="hist-edit-btns">
        <button class="ok" onclick="guardarEdicionHistorial('${id_registro}')">Guardar</button>
        <button class="cancel" onclick="cerrarEdicionHistorial()">Cancelar</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', () => cerrarEdicionHistorial());
}

async function guardarEdicionHistorial(id_registro) {
  const r = (ganttRegistros || []).find(x => String(x.id_registro) === String(id_registro));
  if (!r) return;

  const payload = {
    id_registro,
    id_persona: r.id_persona,
    id_tipo: document.getElementById('hist-edit-tipo').value,
    id_seccion: document.getElementById('hist-edit-seccion').value,
    id_motivo: document.getElementById('hist-edit-motivo').value,
    comentarios: document.getElementById('hist-edit-comentario').value,
    fecha: document.getElementById('hist-edit-fecha').value,
    hora: document.getElementById('hist-edit-hora').value,
    id_encargado: config.id_encargado
  };

  try {
    await apiGas('editar_registro', payload);
    await apiGas('liberar_lock', { id_registro, id_encargado: config.id_encargado });
    pararHeartbeatHistorial();
    document.getElementById('hist-edit-overlay')?.remove();
    histEditandoId = null;
    toast('✓ Registro actualizado.');
    await refrescarTrasEdicionHistorial();
  } catch (err) {
    toast('⚠ ' + err.message);
  }
}

function pararHeartbeatHistorial() {
  if (histLockInterval) { clearInterval(histLockInterval); histLockInterval = null; }
}

function cerrarEdicionHistorial() {
  const id_registro = histEditandoId;
  pararHeartbeatHistorial();
  document.getElementById('hist-edit-overlay')?.remove();
  histEditandoId = null;
  if (id_registro) {
    apiGas('liberar_lock', { id_registro, id_encargado: config.id_encargado }).catch(() => {});
  }
}

// ── Init ──────────────────────────────────────────────────────────────

async function init() {
  try {
    catalogos = await apiGas('get_catalogos');
    localStorage.setItem(CATALOGOS_CACHE_KEY, JSON.stringify(catalogos));
  } catch (err) {
    // Sin conexion ni siquiera para lo primero que pide la app: si ya
    // hay un catalogo guardado de una sesion anterior, arrancamos con
    // ese (desactualizado, pero deja trabajar) en vez de dejar la
    // pantalla en blanco.
    const cacheado = localStorage.getItem(CATALOGOS_CACHE_KEY);
    if (cacheado) {
      catalogos = JSON.parse(cacheado);
      toast('📶 Sin conexión: usando el catálogo de secciones/motivos guardado la última vez.');
    } else {
      document.getElementById('lista').innerHTML =
        '<div id="empty">Sin conexión. Conectate a internet al menos una vez para poder usar el programa.</div>';
      document.getElementById('header-sub').textContent = 'Sin conexión';
      iniciarMonitoreoOffline();
      return;
    }
  }

  config = loadConfig();

  document.getElementById('btn-menu').addEventListener('click', toggleHeaderMenu);
  document.addEventListener('click', cerrarHeaderMenu);
  document.getElementById('header-menu').addEventListener('click', e => e.stopPropagation());
  document.getElementById('btn-config').addEventListener('click', () => { cerrarHeaderMenu(); abrirSetup(); });
  document.getElementById('btn-setup-guardar').addEventListener('click', guardarSetup);
  document.getElementById('search').addEventListener('input', e => onFiltro(e.target.value));
  document.getElementById('search').addEventListener('focus', mostrarDropdownAgregar);
  document.getElementById('search').addEventListener('click', mostrarDropdownAgregar);
  document.getElementById('btn-registrar').addEventListener('click', registrarSeleccionados);
  document.getElementById('btn-update').addEventListener('click', () => { cerrarHeaderMenu(); buscarActualizaciones(); });
  document.getElementById('banner-update-btn').addEventListener('click', instalarActualizacion);
  document.getElementById('btn-sel-todo').addEventListener('click', seleccionarTodo);
  document.getElementById('btn-desel-todo').addEventListener('click', desmarcarTodo);
  document.getElementById('btn-aplicar-hora-grupo').addEventListener('click', aplicarHoraAGrupo);

  document.getElementById('gantt-search').addEventListener('input', e => { ganttFiltro = e.target.value; renderGanttDropdown(); });
  document.getElementById('gantt-search').addEventListener('focus', mostrarGanttDropdown);
  document.getElementById('gantt-search').addEventListener('click', mostrarGanttDropdown);
  document.getElementById('gantt-cal-prev').addEventListener('click', () => ganttCalMes(-1));
  document.getElementById('gantt-cal-next').addEventListener('click', () => ganttCalMes(1));
  document.getElementById('gantt-hoy').addEventListener('click', () => {
    const hoy = new Date();
    ganttCalYear = hoy.getFullYear();
    ganttCalMonth = hoy.getMonth();
    ganttFechas = new Set([fechaHoyLaPaz()]);
    renderGanttCalendar();
    renderGanttDias();
  });
  document.getElementById('hist-busqueda').addEventListener('input', renderHistorial);
  document.getElementById('hist-fecha').addEventListener('change', renderHistorial);
  document.getElementById('btn-hist-fecha-limpiar').addEventListener('click', limpiarFechaHistorial);
  document.getElementById('hist-ver-anulados').addEventListener('change', renderHistorial);

  const horaGrupo = document.getElementById('hora-grupo');
  horaGrupo.value = horaRedondeada15();

  if (!config || !config.secciones || !config.secciones.length) {
    abrirSetup();
  } else {
    await loadPersonal();
  }

  // Precarga en segundo plano el personal de TODA la planta (para el dropdown de "agregar personal")
  recargarPersonalTodos();

  iniciarMonitoreoOffline();
}

// ── Banner "sin conexión" + cola de pendientes ────────────────────────
// Cada pocos segundos le pregunta al servidor local (NO a Google directo)
// cuantos registros quedaron pendientes de enviar. El servidor local es
// el que de verdad sabe si logra hablar con Apps Script o no.

let colaPendientesConocida = 0;
let monitoreoOfflineIniciado = false;

async function actualizarBannerOffline() {
  let pendientes = 0;
  try {
    const res = await fetch('/api/cola/estado');
    const data = await res.json();
    pendientes = data.pendientes || 0;
  } catch {
    // El servidor local en si no deberia fallar nunca (corre en la misma
    // compu); si pasara, no tocamos el banner, mantenemos lo ultimo sabido.
    return;
  }

  const banner = document.getElementById('banner-offline');
  if (pendientes > 0) {
    banner.textContent = pendientes === 1
      ? '📶 Sin conexión · 1 registro pendiente de enviar'
      : `📶 Sin conexión · ${pendientes} registros pendientes de enviar`;
    banner.classList.remove('banner-offline-hidden');
  } else {
    banner.classList.add('banner-offline-hidden');
    if (colaPendientesConocida > 0) {
      toast('✓ Conexión recuperada: se enviaron los registros pendientes.');
    }
  }
  colaPendientesConocida = pendientes;
}

function iniciarMonitoreoOffline() {
  if (monitoreoOfflineIniciado) return;
  monitoreoOfflineIniciado = true;
  actualizarBannerOffline();
  setInterval(actualizarBannerOffline, 6000);
}

document.addEventListener('DOMContentLoaded', init);

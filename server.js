const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');
const { parse } = require('csv-parse/sync');

// BIGINT / NUMERIC -> number (si no, pg los devuelve como texto)
types.setTypeParser(20, (v) => parseInt(v, 10));
types.setTypeParser(1700, (v) => parseFloat(v));

const app = express();
const PORT = process.env.PORT || 3000;
const PERSONAS = ['Jairo', 'Paola'];

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('Falta la variable de entorno DATABASE_URL');
  process.exit(1);
}
const pool = new Pool({
  connectionString: dbUrl,
  ssl: /localhost|127\.0\.0\.1/.test(dbUrl) ? false : { rejectUnauthorized: false },
});

app.use(express.json({ limit: '5mb' }));

/* ---------- Clave de acceso (opcional pero recomendada) ----------
   Si defines APP_PASSWORD en Render, el navegador pedirá usuario/clave.
   Usuario: cualquiera. Clave: el valor de APP_PASSWORD.  */
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
app.use((req, res, next) => {
  const pass = process.env.APP_PASSWORD;
  if (!pass) return next();
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (safeEqual(given, pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Hogar"');
  res.status(401).send('Acceso restringido');
});

/* ---------- Base de datos ---------- */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS gastos (
      id          SERIAL PRIMARY KEY,
      fecha       TEXT NOT NULL,
      periodo     TEXT NOT NULL,
      anio        INTEGER,
      categoria   TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      monto       NUMERIC NOT NULL,
      quien       TEXT NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS ingresos (
      id                SERIAL PRIMARY KEY,
      fecha             TEXT NOT NULL,
      periodo           TEXT NOT NULL,
      anio              INTEGER,
      nombre            TEXT NOT NULL,
      salario_quincenal NUMERIC DEFAULT 0,
      porcentaje        NUMERIC DEFAULT 0,
      cantidad_real     NUMERIC DEFAULT 0,
      diferencia        NUMERIC DEFAULT 0,
      created_at        TIMESTAMPTZ DEFAULT now()
    );
  `);
}

async function getAll(db = pool) {
  const [g, i] = await Promise.all([
    db.query(`SELECT id, fecha, periodo, anio, categoria, descripcion, monto, quien
              FROM gastos ORDER BY id`),
    db.query(`SELECT id, fecha, periodo, anio, nombre,
                     salario_quincenal AS "salarioQuincenal", porcentaje,
                     cantidad_real AS "cantidadReal", diferencia
              FROM ingresos ORDER BY id`),
  ]);
  return { gastos: g.rows, ingresos: i.rows };
}

/* ---------- Validación ---------- */
function bad(msg, status = 400) {
  const e = new Error(msg);
  e.status = status;
  return e;
}
const text = (v) => String(v ?? '').trim();

function cleanFecha(v) {
  const f = text(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f)) throw bad('Falta la fecha.');
  return f;
}
function cleanPersona(v) {
  const p = PERSONAS.find((x) => x.toLowerCase() === text(v).toLowerCase());
  if (!p) throw bad('Elige quién es: Jairo o Paola.');
  return p;
}
function cleanGasto(b = {}) {
  const fecha = cleanFecha(b.fecha);
  const periodo = text(b.periodo);
  if (!periodo) throw bad('Elige un periodo.');
  const categoria = text(b.categoria);
  if (!categoria) throw bad('Falta la categoría.');
  const descripcion = text(b.descripcion);
  if (!descripcion) throw bad('Falta la descripción.');
  const monto = Number(b.monto);
  if (!Number.isFinite(monto) || monto === 0) throw bad('Escribe un monto válido.');
  const quien = cleanPersona(b.quien);
  return { fecha, periodo, anio: Number(fecha.slice(0, 4)), categoria, descripcion, monto, quien };
}
function cleanIngreso(b = {}) {
  const fecha = cleanFecha(b.fecha);
  const periodo = text(b.periodo);
  if (!periodo) throw bad('Elige un periodo.');
  const nombre = cleanPersona(b.nombre);
  const salario = Number(b.salarioQuincenal);
  if (!(salario > 0)) throw bad('Escribe el salario quincenal.');
  const porcentaje = Number(b.porcentaje);
  if (!(porcentaje > 0)) throw bad('Escribe cuánto debe aportar.');
  const real = Number(b.cantidadReal);
  if (!Number.isFinite(real) || real < 0) throw bad('Escribe cuánto aportó realmente.');
  return {
    fecha, periodo, anio: Number(fecha.slice(0, 4)), nombre,
    salario, porcentaje, real, diferencia: real - porcentaje,
  };
}
function cleanId(v) {
  const id = parseInt(v, 10);
  if (!Number.isInteger(id)) throw bad('Registro no válido.');
  return id;
}

const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

/* ---------- API ---------- */
app.get('/api/data', wrap(async (req, res) => {
  res.json(await getAll());
}));

app.post('/api/gastos', wrap(async (req, res) => {
  const g = cleanGasto(req.body);
  await pool.query(
    `INSERT INTO gastos (fecha, periodo, anio, categoria, descripcion, monto, quien)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [g.fecha, g.periodo, g.anio, g.categoria, g.descripcion, g.monto, g.quien]
  );
  res.json(await getAll());
}));

app.put('/api/gastos/:id', wrap(async (req, res) => {
  const id = cleanId(req.params.id);
  const g = cleanGasto(req.body);
  const r = await pool.query(
    `UPDATE gastos SET fecha=$1, periodo=$2, anio=$3, categoria=$4, descripcion=$5, monto=$6, quien=$7
     WHERE id=$8`,
    [g.fecha, g.periodo, g.anio, g.categoria, g.descripcion, g.monto, g.quien, id]
  );
  if (!r.rowCount) throw bad('Ese gasto ya no existe. Recarga la página.', 404);
  res.json(await getAll());
}));

app.delete('/api/gastos/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM gastos WHERE id=$1', [cleanId(req.params.id)]);
  res.json(await getAll());
}));

app.post('/api/ingresos', wrap(async (req, res) => {
  const i = cleanIngreso(req.body);
  await pool.query(
    `INSERT INTO ingresos (fecha, periodo, anio, nombre, salario_quincenal, porcentaje, cantidad_real, diferencia)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [i.fecha, i.periodo, i.anio, i.nombre, i.salario, i.porcentaje, i.real, i.diferencia]
  );
  res.json(await getAll());
}));

app.put('/api/ingresos/:id', wrap(async (req, res) => {
  const id = cleanId(req.params.id);
  const i = cleanIngreso(req.body);
  const r = await pool.query(
    `UPDATE ingresos SET fecha=$1, periodo=$2, anio=$3, nombre=$4, salario_quincenal=$5,
            porcentaje=$6, cantidad_real=$7, diferencia=$8
     WHERE id=$9`,
    [i.fecha, i.periodo, i.anio, i.nombre, i.salario, i.porcentaje, i.real, i.diferencia, id]
  );
  if (!r.rowCount) throw bad('Ese aporte ya no existe. Recarga la página.', 404);
  res.json(await getAll());
}));

app.delete('/api/ingresos/:id', wrap(async (req, res) => {
  await pool.query('DELETE FROM ingresos WHERE id=$1', [cleanId(req.params.id)]);
  res.json(await getAll());
}));

/* ---------- Importar desde el Google Sheet (CSV) ----------
   Se usa desde /importar.html.
   Columnas de Gastos:   Fecha, Periodo, Año, Categoria, Descripción, Monto, Quien gastó
   Columnas de Ingresos: Fecha, Periodo, Año, Nombre, Salario Quincenal, Porcentaje, Cantidad Real, Diferencia
   Es seguro repetirlo: lo que ya está en la base no se vuelve a insertar
   (pero dos gastos realmente iguales el mismo día sí se conservan). */
function iso(y, m, d) {
  y = +y; m = +m; d = +d;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
function parseFecha(v) {
  v = text(v);
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(m[1], m[2], m[3]);
  m = v.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    let d = +m[1], mo = +m[2];
    if (mo > 12 && d <= 12) [d, mo] = [mo, d]; // si viene mes/día, se corrige
    return iso(m[3], mo, d);
  }
  return null;
}
function parseNum(v) {
  let s = text(v).replace(/[$\s]/g, '');
  if (!s) return NaN;
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, ''); // 1.200.000 o 1,200,000
  else s = s.replace(',', '.');
  return Number(s);
}
function csvRows(raw) {
  if (!raw || !String(raw).trim()) return [];
  let rows;
  try {
    rows = parse(String(raw), { skip_empty_lines: true, bom: true, relax_column_count: true });
  } catch (e) {
    throw bad('No se pudo leer uno de los archivos. Revisa que sea un CSV descargado del Sheet.');
  }
  rows = rows.filter((r) => r.some((c) => text(c) !== ''));
  if (rows.length && !parseFecha(rows[0][0])) rows = rows.slice(1); // encabezados
  return rows;
}
function personaDe(v) {
  return PERSONAS.find((x) => x.toLowerCase() === text(v).toLowerCase()) || null;
}

app.post('/api/import', wrap(async (req, res) => {
  const { gastos, ingresos } = req.body || {};
  const avisos = [];

  const G = [];
  let gOmit = 0, gSuma = 0;
  csvRows(gastos).forEach((r, n) => {
    const fecha = parseFecha(r[0]);
    const periodo = text(r[1]);
    const categoria = text(r[3]);
    const descripcion = text(r[4]);
    const monto = parseNum(r[5]);
    const quien = personaDe(r[6]);
    if (!fecha || !periodo || !categoria || !Number.isFinite(monto) || !quien) {
      gOmit++;
      if (avisos.length < 6) avisos.push(`Gastos, fila ${n + 1}: no se pudo leer (${r.join(' | ').slice(0, 80)})`);
      return;
    }
    gSuma += monto;
    G.push({ fecha, periodo, anio: +fecha.slice(0, 4), categoria, descripcion: descripcion || categoria, monto, quien });
  });

  const I = [];
  let iOmit = 0, iReal = 0;
  csvRows(ingresos).forEach((r, n) => {
    const fecha = parseFecha(r[0]);
    const periodo = text(r[1]);
    const nombre = personaDe(r[3]);
    const salario = parseNum(r[4]);
    const porcentaje = parseNum(r[5]);
    const real = parseNum(r[6]);
    if (!fecha || !periodo || !nombre || ![salario, porcentaje, real].every(Number.isFinite)) {
      iOmit++;
      if (avisos.length < 6) avisos.push(`Aportes, fila ${n + 1}: no se pudo leer (${r.join(' | ').slice(0, 80)})`);
      return;
    }
    iReal += real;
    I.push({ fecha, periodo, anio: +fecha.slice(0, 4), nombre, salario, porcentaje, real, diferencia: real - porcentaje });
  });

  const client = await pool.connect();
  let gNuevos = 0, iNuevos = 0;
  try {
    await client.query('BEGIN');

    const haveG = new Map();
    const keyG = (o) => [o.fecha, o.periodo, o.categoria, o.descripcion, Number(o.monto), o.quien].join('\u0001');
    (await client.query('SELECT fecha, periodo, categoria, descripcion, monto, quien FROM gastos')).rows
      .forEach((o) => haveG.set(keyG(o), (haveG.get(keyG(o)) || 0) + 1));
    for (const g of G) {
      const k = keyG(g);
      if ((haveG.get(k) || 0) > 0) { haveG.set(k, haveG.get(k) - 1); continue; }
      await client.query(
        `INSERT INTO gastos (fecha, periodo, anio, categoria, descripcion, monto, quien)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [g.fecha, g.periodo, g.anio, g.categoria, g.descripcion, g.monto, g.quien]
      );
      gNuevos++;
    }

    const haveI = new Map();
    const keyI = (o) => [o.fecha, o.periodo, o.nombre, Number(o.salario), Number(o.porcentaje), Number(o.real)].join('\u0001');
    (await client.query(
      `SELECT fecha, periodo, nombre, salario_quincenal AS salario, porcentaje, cantidad_real AS real FROM ingresos`
    )).rows.forEach((o) => haveI.set(keyI(o), (haveI.get(keyI(o)) || 0) + 1));
    for (const i of I) {
      const k = keyI(i);
      if ((haveI.get(k) || 0) > 0) { haveI.set(k, haveI.get(k) - 1); continue; }
      await client.query(
        `INSERT INTO ingresos (fecha, periodo, anio, nombre, salario_quincenal, porcentaje, cantidad_real, diferencia)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [i.fecha, i.periodo, i.anio, i.nombre, i.salario, i.porcentaje, i.real, i.diferencia]
      );
      iNuevos++;
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }

  res.json({
    gastos: { leidos: G.length, nuevos: gNuevos, yaEstaban: G.length - gNuevos, omitidos: gOmit, suma: gSuma },
    ingresos: { leidos: I.length, nuevos: iNuevos, yaEstaban: I.length - iNuevos, omitidos: iOmit, sumaAportado: iReal },
    avisos,
  });
}));

/* ---------- Frontend ---------- */
app.use(express.static(path.join(__dirname, 'public')));

app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Error del servidor' : err.message });
});

initDb()
  .then(() => app.listen(PORT, () => console.log('Hogar corriendo en puerto ' + PORT)))
  .catch((e) => { console.error('No se pudo iniciar la base de datos:', e.message); process.exit(1); });

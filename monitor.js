import express from 'express';
import dotenv from 'dotenv';
import fs from 'fs';
import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';
import cron from 'node-cron';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.get('/', (_req, res) => {
  res.send('Bot activo y funcionando!');
});

if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error('BOT_TOKEN y CHAT_ID deben estar definidos en las variables de entorno.');
}

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

const URL_API = 'https://servicios3.abc.gob.ar/valoracion.docente/api/apd.oferta.encabezado/select';
const ESTADO_FILE = 'estado_ofertas.json';
const CONFIG_FILE = 'config.json';

// 👉 Formatea fechas al estilo argentino
function formatDateArg(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return isNaN(date) ? dateStr : new Intl.DateTimeFormat('es-AR').format(date);
}

function fixEncoding(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/�/g, (match, offset, string) => {
      if (string[offset + 1]?.match(/[aAeE]/)) return 'á';
      if (string[offset + 1]?.match(/[eEiI]/)) return 'é';
      if (string[offset + 1]?.match(/[iIoO]/)) return 'í';
      if (string[offset + 1]?.match(/[oOuU]/)) return 'ó';
      if (string[offset + 1]?.match(/[uUnN]/)) return 'ú';
      return '°';
    })
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Í')
    .replace(/Ã"/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ã'/g, 'Ñ');
}

function cleanString(str) {
  if (!str) return '';
  return fixEncoding(str.trim().normalize('NFC'));
}

// Fixed function name and implementation
function formatDateTimeArg(dateTimeStr, omitSpecificTime = false) {
  if (!dateTimeStr) return '';
  let dt = dateTimeStr.endsWith('Z') ? dateTimeStr.slice(0, -1) : dateTimeStr;
  if (omitSpecificTime && dt.endsWith('T03:00:00')) {
    return dt.slice(0, 10);
  }
  // Format the datetime for Argentina locale
  try {
    const date = new Date(dt);
    return isNaN(date) ? dt : new Intl.DateTimeFormat('es-AR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit'
    }).format(date);
  } catch {
    return dt;
  }
}

function loadState() {
  try {
    const data = fs.readFileSync(ESTADO_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { seen_offers: [], firstRun: true };
  }
}

function saveState(state) {
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(state, null, 2));
}

function loadConfig() {
  // Usar variables de entorno si están disponibles, sino valores por defecto
  return {
    rows: parseInt(process.env.ROWS) || 100,
    descdistrito: process.env.DISTRITO || 'general pueyrredon',
    estado: process.env.ESTADO || 'Publicada'
  };
}

async function getOffers(filters) {
  try {
    const params = new URLSearchParams();
    params.append('rows', filters.rows.toString());
    params.append('facet', 'true');
    params.append('facet.limit', '-1');
    params.append('facet.mincount', '1');
    params.append('json.nl', 'map');
    params.append('facet.field', 'cargo');
    params.append('fq', `descdistrito:"${filters.descdistrito}"`);
    params.append('fq', `estado:${filters.estado}`);
    params.append('q', '*:*');
    params.append('wt', 'json');

    const response = await axios.get(URL_API, {
      params,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const docs = response.data.response?.docs || [];
    console.log(`📥 Ofertas totales recibidas: ${docs.length}`);

    return docs.map((offer) => {
      const offerId = offer.idoferta || offer.id || '';
      return {
        id: offerId.toString(),
        title: cleanString(offer.cargo),
        cierreoferta: formatDateTimeArg(offer.finoferta),
        zone: cleanString(offer.descdistrito),
        nivelModalidad: cleanString(offer.descnivelmodalidad),
        cursodivision: cleanString(offer.cursodivision),
        escuela: cleanString(offer.escuela),
        domiciliodesempeno: cleanString(offer.domiciliodesempeno),
        estado: cleanString(offer.estado),
        supl_hasta: formatDateArg(cleanString(offer.supl_hasta)),
        turno: cleanString(offer.turno),
        tomaposesion: formatDateArg(cleanString(offer.tomaposesion)),
        supl_revista: cleanString(offer.supl_revista),
        position_type: cleanString(offer.area),
        link: `https://servicios.abc.gob.ar/actos.publicos.digitales/`
      };
    });
  } catch (error) {
    console.error('❌ Error al obtener ofertas:', error.message);
    return [];
  }
}

async function sendTelegramMessage(message) {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log('📨 Mensaje enviado a Telegram');
  } catch (error) {
    console.error('❌ Error enviando mensaje a Telegram:', error.message);
  }
}

async function checkOffers(isFirstRun = false) {
  console.log('🔎 Iniciando chequeo de ofertas...');
  const state = loadState();
  const seenOffers = new Set(state.seen_offers);
  const filters = loadConfig();

  const offers = await getOffers(filters);
  console.log(`🔢 Total ofertas procesadas: ${offers.length}`);

  let newCount = 0;

  // Si es la primera ejecución, enviar TODAS las ofertas
  if (isFirstRun) {
    console.log('🚀 Primera ejecución: enviando TODAS las ofertas publicadas...');
    
    for (const offer of offers) {
      const message = `
<b>📢 Oferta Publicada:</b>
<b>Cargo:</b> ${offer.title}
<b>Cierre de oferta:</b> ${offer.cierreoferta}
<b>Estado:</b> ${offer.estado}
<b>Zona:</b> ${offer.zone}
<b>Nivel o Modalidad:</b> ${offer.nivelModalidad}
<b>Curso/División:</b> ${offer.cursodivision} - Turno: ${offer.turno}
<b>Domicilio:</b> ${offer.domiciliodesempeno}
<b>Suplente revista:</b> ${offer.supl_revista}
<b>Toma posesión:</b> ${offer.tomaposesion}
<b>Suplente hasta:</b> ${offer.supl_hasta}
<b>Enlace:</b> ${offer.link}
`;
      await sendTelegramMessage(message);
      newCount++;
    }
    
    // Guardar todas las ofertas como vistas para próximas ejecuciones
    state.seen_offers = offers.map(o => o.id);
    state.firstRun = false;
    saveState(state);
    console.log(`✅ Primera ejecución completada. Total ofertas enviadas: ${newCount}`);
    return;
  }

  // Ejecuciones posteriores: solo ofertas nuevas
  for (const offer of offers) {
    if (!seenOffers.has(offer.id)) {
      const message = `
<b>🆕 Nueva Oferta:</b>
<b>Cargo:</b> ${offer.title}
<b>Cierre de oferta:</b> ${offer.cierreoferta}
<b>Estado:</b> ${offer.estado}
<b>Zona:</b> ${offer.zone}
<b>Nivel o Modalidad:</b> ${offer.nivelModalidad}
<b>Curso/División:</b> ${offer.cursodivision} - Turno: ${offer.turno}
<b>Domicilio:</b> ${offer.domiciliodesempeno}
<b>Suplente revista:</b> ${offer.supl_revista}
<b>Toma posesión:</b> ${offer.tomaposesion}
<b>Suplente hasta:</b> ${offer.supl_hasta}
<b>Enlace:</b> ${offer.link}
`;
      await sendTelegramMessage(message);
      seenOffers.add(offer.id);
      newCount++;
    }
  }

  state.seen_offers = Array.from(seenOffers);
  saveState(state);
  console.log(`✅ Chequeo finalizado. Nuevas ofertas enviadas: ${newCount}`);
}

// Cron job cada 30 minutos
cron.schedule('*/30 * * * *', () => {
  console.log('⏱ Chequeo automático programado (cada 30 min)...');
  checkOffers(false); // false = no es primera ejecución
});

// Primera ejecución al iniciar - ENVÍA TODAS LAS OFERTAS
(async () => {
  const state = loadState();
  const isFirstRun = state.firstRun !== false; // Si no existe o es true
  await checkOffers(isFirstRun);
})();

// Función para envío manual (solo para testing)
async function forzarEnvio() {
  console.log('🧪 Envío manual para testing...');
  const filters = loadConfig();
  const offers = await getOffers(filters);

  if (offers.length === 0) {
    console.log('ℹ️ No se encontraron ofertas para enviar.');
    return;
  }

  for (const offer of offers) {
    const message = `
<b>🧪 Oferta (TEST):</b>
<b>Cargo:</b> ${offer.title}
<b>Cierre de oferta:</b> ${offer.cierreoferta}
<b>Estado:</b> ${offer.estado}
<b>Zona:</b> ${offer.zone}
<b>Nivel o Modalidad:</b> ${offer.nivelModalidad}
<b>Curso/División:</b> ${offer.cursodivision} - Turno: ${offer.turno}
<b>Domicilio:</b> ${offer.domiciliodesempeno}
<b>Suplente revista:</b> ${offer.supl_revista}
<b>Toma posesión:</b> ${offer.tomaposesion}
<b>Suplente hasta:</b> ${offer.supl_hasta}
<b>Enlace:</b> ${offer.link}
`;
    await sendTelegramMessage(message);
  }

  console.log(`✅ Testing completado. Total ofertas enviadas: ${offers.length}`);
}

// Descomenta la siguiente línea SOLO para testing
// forzarEnvio();

// app escucha en el puerto
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
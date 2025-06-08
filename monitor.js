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
const URL = 'https://abc-monitor.onrender.com/';

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

// Formatea fechas al estilo argentino
function formatDateArg(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return isNaN(date) ? dateStr : new Intl.DateTimeFormat('es-AR').format(date);
}

// Mapa de reemplazos para errores de codificación
const encodingFixes = {
  'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú',
  'ÃÀ': 'Á', 'ÃÉ': 'É', 'ÃÍ': 'Í', 'ÃÓ': 'Ó', 'ÃÚ': 'Ú',
  'Ã±': 'ñ', 'ÃÑ': 'Ñ', 'ÂÑ': 'Ñ', 'Ãñ': 'ñ',
  'Ãí': 'í', 'ÃÍ': 'Í', 'Ã³': 'ó', 'ÃÓ': 'Ó', 'Ãá': 'á', 'ÃÁ': 'Á',
  'Â¡': '¡', 'Â¿': '¿', 'Ã¼': 'ü', 'Ãœ': 'Ü',
  'Â°': '°', 'º': '°', 'Ã°': '°', 'Ã‚Â°': '°', 'Ãº°': '°', // Símbolo °
  'Ã': '', 'Â': '', // Eliminar caracteres extraños
  'â€¢': '•', 'â€“': '–', 'â€': '€', 'â„¢': '™'
};

// Función para corregir codificación
function fixEncoding(str) {
  if (!str || typeof str !== 'string') return '';
  
  console.log(`📝 Texto original: "${str}"`);
  
  let fixed = str;
  // Aplicar reemplazos específicos
  for (const [wrong, correct] of Object.entries(encodingFixes)) {
    fixed = fixed.replace(new RegExp(wrong, 'g'), correct);
  }
  
  // Eliminar carácter � (U+FFFD)
  fixed = fixed.replace(/\uFFFD/g, '');
  
  // Preservar caracteres imprimibles, permitiendo acentos y °
  fixed = fixed.replace(/[^\x20-\x7E0-9a-zA-ZáéíóúñÁÉÍÓÚÑ¡¿üÜ°\s]/g, '');
  
  // Para cursodivision, garantizar un espacio si no hay °
  if (fixed.match(/^\d+[A-Za-z]$/)) { // Ejemplo: "5A" -> "5 A"
    fixed = fixed.replace(/(\d+)([A-Za-z])/, '$1 $2');
  }
  
  console.log(`📝 Texto corregido: "${fixed}"`);
  return fixed;
}

function cleanString(str) {
  if (!str) return '';
  return fixEncoding(str.trim());
}

// Formatear horarios de desempeño
function formatSchedule(offer) {
  const days = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const dayNames = {
    'lunes': 'Lunes',
    'martes': 'Martes', 
    'miercoles': 'Miércoles',
    'jueves': 'Jueves',
    'viernes': 'Viernes',
    'sabado': 'Sábado'
  };
  
  const schedule = [];
  
  for (const day of days) {
    const time = offer[day];
    if (time && time.trim() !== '') {
      schedule.push(`${dayNames[day]}: ${time.trim()}`);
    }
  }
  
  return schedule.length > 0 ? schedule.join('\n') : 'No especificado';
}

// Formatear fechas y horas
function formatDateTimeArg(dateTimeStr, omitSpecificTime = false) {
  if (!dateTimeStr) return '';
  let dt = dateTimeStr.endsWith('Z') ? dateTimeStr.slice(0, -1) : dateTimeStr;
  if (omitSpecificTime && dt.endsWith('T03:00:00')) {
    return dt.slice(0, 10);
  }
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
    console.log('📝 Datos crudos de cursodivision:', docs.slice(0, 2).map(doc => doc.cursodivision));
    console.log('📝 Datos crudos de cargo:', docs.slice(0, 2).map(doc => doc.cargo));
    console.log('📝 Datos crudos de escuela:', docs.slice(0, 2).map(doc => doc.escuela));
    console.log('📝 Datos crudos de domiciliodesempeno:', docs.slice(0, 2).map(doc => doc.domiciliodesempeno));
    console.log('📝 Datos crudos de observaciones:', docs.slice(0, 2).map(doc => doc.observaciones));

    return docs.map((offer) => {
      const offerId = offer.idoferta || offer.id || '';
      const cursodivision = cleanString(offer.cursodivision);
      const cargo = cleanString(offer.cargo);
      const escuela = cleanString(offer.escuela);
      const domiciliodesempeno = cleanString(offer.domiciliodesempeno);
      const observaciones = cleanString(offer.observaciones);
      console.log(`📝 cursodivision procesado: "${offer.cursodivision}" -> "${cursodivision}"`);
      console.log(`📝 cargo procesado: "${offer.cargo}" -> "${cargo}"`);
      console.log(`📝 escuela procesado: "${offer.escuela}" -> "${escuela}"`);
      console.log(`📝 domiciliodesempeno procesado: "${offer.domiciliodesempeno}" -> "${domiciliodesempeno}"`);
      console.log(`📝 observaciones procesado: "${offer.observaciones}" -> "${observaciones}"`);
      return {
        id: offerId.toString(),
        title: cargo,
        cierreoferta: formatDateTimeArg(offer.finoferta),
        zone: cleanString(offer.descdistrito),
        nivelModalidad: cleanString(offer.descnivelmodalidad),
        cursodivision: cursodivision,
        escuela: escuela,
        domiciliodesempeno: domiciliodesempeno,
        estado: cleanString(offer.estado),
        iniciooferta: formatDateArg(cleanString(offer.iniciooferta)),
        supl_hasta: formatDateArg(cleanString(offer.supl_hasta)),
        turno: cleanString(offer.turno),
        tomaposesion: formatDateArg(cleanString(offer.tomaposesion)),
        supl_revista: cleanString(offer.supl_revista),
        position_type: cleanString(offer.area),
        horarios: formatSchedule(offer),
        observaciones: observaciones,
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

function createOfferMessage(offer, isNew = true) {
  const title = isNew ? '🆕 Nueva Oferta:' : '📢 Oferta Publicada:';
  
  let message = `
<b>${title}</b>
<b>Cargo:</b> ${offer.title}
<b>Cierre de oferta:</b> ${offer.cierreoferta}
<b>Estado:</b> ${offer.estado}
<b>Distrito:</b> ${offer.zone}
<b>Nivel o Modalidad:</b> ${offer.nivelModalidad}
<b>Curso/División:</b> ${offer.cursodivision} - Turno: ${offer.turno}
<b>Domicilio:</b> ${offer.domiciliodesempeno}`;

  if (offer.horarios && offer.horarios !== 'No especificado') {
    message += `\n<b>📅 Horarios de desempeño:</b>\n${offer.horarios}`;
  }

  if (offer.jornada) {
    message += `\n<b>Jornada:</b> ${offer.jornada}`;
  }
  
  if (offer.hsmodulos) {
    message += `\n<b>Horas/Módulos:</b> ${offer.hsmodulos}`;
  }

  message += `
<b>Revista:</b> ${offer.supl_revista}
<b>Inicio:</b> ${offer.iniciooferta}
<b>Hasta:</b> ${offer.supl_hasta}`;

  if (offer.observaciones && offer.observaciones.trim()) {
    message += `\n<b>Observaciones:</b> ${offer.observaciones}`;
  }

  message += `\n<b>Enlace:</b> ${offer.link}`;

  return message;
}

async function checkOffers(isFirstRun = false) {
  console.log('🔎 Iniciando chequeo de ofertas...');
  const state = loadState();
  const seenOffers = new Set(state.seen_offers);
  const filters = loadConfig();

  const offers = await getOffers(filters);
  console.log(`🔢 Total ofertas procesadas: ${offers.length}`);

  let newCount = 0;

  if (isFirstRun) {
    console.log('🚀 Primera ejecución: enviando TODAS las ofertas publicadas...');
    
    for (const offer of offers) {
      const message = createOfferMessage(offer, false);
      await sendTelegramMessage(message);
      newCount++;
    }
    
    state.seen_offers = offers.map(o => o.id);
    state.firstRun = false;
    saveState(state);
    console.log(`✅ Primera ejecución completada. Total ofertas enviadas: ${newCount}`);
    return;
  }

  for (const offer of offers) {
    if (!seenOffers.has(offer.id)) {
      const message = createOfferMessage(offer, true);
      await sendTelegramMessage(message);
      seenOffers.add(offer.id);
      newCount++;
    }
  }

  state.seen_offers = Array.from(seenOffers);
  saveState(state);
  console.log(`✅ Chequeo finalizado. Nuevas ofertas enviadas: ${newCount}`);
}

cron.schedule('*/30 * * * *', () => {
  console.log('⏱ Chequeo automático programado (cada 30 min)...');
  checkOffers(false);
});

(async () => {
  const state = loadState();
  const isFirstRun = state.firstRun !== false;
  await checkOffers(isFirstRun);
})();

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
<b>Distrito:</b> ${offer.zone}
<b>Nivel o Modalidad:</b> ${offer.nivelModalidad}
<b>Curso/División:</b> ${offer.cursodivision} - Turno: ${offer.turno}
<b>Domicilio:</b> ${offer.domiciliodesempeno}
<b>📅 Horarios de desempeño:</b>
${offer.horarios}
<b>Revista:</b> ${offer.supl_revista}
<b>Toma posesión:</b> ${offer.tomaposesion}
<b>Inicio:</b> ${offer.iniciooferta}
<b>Hasta:</b> ${offer.supl_hasta}
<b>Observaciones:</b> ${offer.observaciones}
<b>Enlace:</b> ${offer.link}
`;
    await sendTelegramMessage(message);
  }

  console.log(`✅ Testing completado. Total ofertas enviadas: ${offers.length}`);
}

// Descomenta la siguiente línea para testing
// forzarEnvio();

app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
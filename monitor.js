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
const URL_API = 'https://servicios3.abc.gob.ar/valoracion.docente/api/apd.oferta.encabezado/select';
const ESTADO_FILE = 'estado_ofertas.json';

// Verificación de variables de entorno
if (!BOT_TOKEN || !CHAT_ID) {
  throw new Error('BOT_TOKEN y CHAT_ID deben estar definidos en las variables de entorno.');
}

// Inicialización del bot (sin polling porque sólo envía mensajes)
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// Ruta simple para chequear que el bot está activo

app.get('/', (_req, res) => {
  res.send('Bot activo y funcionando!');
});

// Función para formatear fechas a formato argentino (dd/mm/yyyy)
function formatDateArg(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  if (isNaN(date)) return dateStr;
  return new Intl.DateTimeFormat('es-AR').format(date);
}

// Corrección de errores comunes en codificación
const encodingFixes = {
  'Ã¡': 'á', 'Ã©': 'é', 'Ã­': 'í', 'Ã³': 'ó', 'Ãº': 'ú',
  'ÃÀ': 'Á', 'ÃÉ': 'É', 'ÃÍ': 'Í', 'ÃÓ': 'Ó', 'ÃÚ': 'Ú',
  'Ã±': 'ñ', 'ÃÑ': 'Ñ', 'ÂÑ': 'Ñ', 'Ãñ': 'ñ',
  'Ãí': 'í', 'ÃÍ': 'Í', 'Ã³': 'ó', 'ÃÓ': 'Ó', 'Ãá': 'á', 'ÃÁ': 'Á',
  'Â¡': '¡', 'Â¿': '¿', 'Ã¼': 'ü', 'Ãœ': 'Ü',
  'Â°': '°', 'º': '°', 'Ã°': '°', 'Ã‚Â°': '°', 'Ãº°': '°',
  'Ã': '', 'Â': '',
  'â€¢': '•', 'â€"': '–', 'â€': '€', 'â„¢': '™'
};

// Función para corregir la codificación en textos
function fixEncoding(str) {
  if (!str || typeof str !== 'string') return '';
  let fixed = str;
  for (const [wrong, correct] of Object.entries(encodingFixes)) {
    fixed = fixed.replace(new RegExp(wrong, 'g'), correct);
  }
  fixed = fixed.replace(/\uFFFD/g, ''); // eliminar caracter �
  // Permitir caracteres imprimibles y acentos
  fixed = fixed.replace(/[^\x20-\x7E0-9a-zA-ZáéíóúñÁÉÍÓÚÑ¡¿üÜ°\s]/g, '');
  // Espacio entre número y letra si es formato "5A" -> "5 A"
  if (fixed.match(/^\d+[A-Za-z]$/)) {
    fixed = fixed.replace(/(\d+)([A-Za-z])/, '$1 $2');
  }
  return fixed;
}

// Limpieza y corrección de strings
function cleanString(str) {
  if (!str) return '';
  return fixEncoding(str.trim());
}

// Formatear horarios de desempeño
function formatSchedule(offer) {
  const days = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
  const dayNames = {
    lunes: 'Lunes',
    martes: 'Martes',
    miercoles: 'Miércoles',
    jueves: 'Jueves',
    viernes: 'Viernes',
    sabado: 'Sábado'
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

// Formatear fecha y hora con opción de omitir hora específica
function formatDateTimeArg(dateTimeStr, omitSpecificTime = false) {
  if (!dateTimeStr) return '';
  let dt = dateTimeStr.endsWith('Z') ? dateTimeStr.slice(0, -1) : dateTimeStr;
  if (omitSpecificTime && dt.endsWith('T03:00:00')) {
    return dt.slice(0, 10);
  }
  try {
    const date = new Date(dt);
    if (isNaN(date)) return dt;
    return new Intl.DateTimeFormat('es-AR', {
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

// Cargar estado desde archivo
function loadState() {
  try {
    const data = fs.readFileSync(ESTADO_FILE, 'utf8');
    return JSON.parse(data);
  } catch {
    return { seen_offers: [], firstRun: true };
  }
}

// Guardar estado en archivo
function saveState(state) {
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(state, null, 2));
}

// Cargar configuración desde variables de entorno o valores por defecto
function loadConfig() {
  return {
    rows: parseInt(process.env.ROWS) || 100,
    descdistrito: process.env.DISTRITO || 'general pueyrredon',
    estado: process.env.ESTADO || 'Publicada'
  };
}

// Obtener ofertas desde la API con filtros
async function getOffers(filters) {
  try {
    const params = new URLSearchParams();
    params.append('rows', filters.rows.toString());
    params.append('facet', 'true');
    params.append('facet.limit', '-1');
    params.append('facet.mincount', '1');
    params.append('json.nl', 'map');
    params.append('facet.field', 'cargo');
    // CORRECCIÓN: Formato correcto para el filtro de distrito
    params.append('fq', `descdistrito:"${filters.descdistrito}"`);
    params.append('fq', `estado:${filters.estado}`);
    params.append('q', '*:*');
    params.append('wt', 'json');

    console.log('🔍 Consultando API con filtros:', {
      distrito: filters.descdistrito,
      estado: filters.estado,
      rows: filters.rows
    });

    const response = await axios.get(URL_API, {
      params,
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000 // Timeout de 10 segundos
    });

    const docs = response.data.response?.docs || [];
    console.log(`📊 Se encontraron ${docs.length} ofertas`);

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
        iniciooferta: formatDateArg(cleanString(offer.iniciooferta)),
        supl_hasta: formatDateArg(cleanString(offer.supl_hasta)),
        turno: cleanString(offer.turno),
        tomaposesion: formatDateArg(cleanString(offer.tomaposesion)),
        supl_revista: cleanString(offer.supl_revista),
        position_type: cleanString(offer.area),
        horarios: formatSchedule(offer),
        observaciones: cleanString(offer.observaciones),
        link: `https://servicios.abc.gob.ar/actos.publicos.digitales/`
      };
    });
  } catch (error) {
    console.error('❌ Error al obtener ofertas:', error.message);
    if (error.code === 'ECONNABORTED') {
      console.error('⏰ Timeout - La API tardó demasiado en responder');
    }
    return [];
  }
}

// Enviar mensaje por Telegram
async function sendTelegramMessage(message) {
  try {
    await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
    console.log('📨 Mensaje enviado a Telegram');
  } catch (error) {
    console.error('❌ Error enviando mensaje a Telegram:', error.message);
  }
}

// Crear el mensaje para una oferta (nuevo o ya publicada)
function createOfferMessage(offer, isNew = true) {
  const title = isNew ? '🆕 Nueva Oferta:' : '📢 Oferta Publicada:';

  let message = `<b>${title}</b>
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
<b>Suplencia hasta:</b> ${offer.supl_hasta}
<b>Toma de posesión:</b> ${offer.tomaposesion}
<b>Escuela:</b> ${offer.escuela}
<b>Observaciones:</b> ${offer.observaciones}
<a href="${offer.link}">Enlace a la oferta completa</a>`;

  return message;
}

// --- NUEVO: Gestión de usuarios que inician el bot ---

const USERS_FILE = 'usuarios.json';

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

async function sendTelegramMessageToAll(message) {
  const users = loadUsers();
  for (const chatId of users) {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      console.log(`📨 Mensaje enviado a usuario ${chatId}`);
    } catch (error) {
      console.error(`❌ Error enviando mensaje a usuario ${chatId}:`, error.message);
    }
  }
}

// Cambiamos a polling para escuchar mensajes entrantes 
const botPolling = new TelegramBot(BOT_TOKEN, { polling: true });

botPolling.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();

  if (!users.includes(chatId)) {
    users.push(chatId);
    saveUsers(users);
  }

  // Mensaje de bienvenida
  await botPolling.sendMessage(chatId, '¡Hola! Bienvenido al bot de ofertas docentes. Aquí recibirás las últimas novedades.');

  // Enviar las últimas ofertas al usuario que inicia
  const filters = loadConfig();
  const offers = await getOffers(filters);

  if (offers.length === 0) {
    await botPolling.sendMessage(chatId, 'Actualmente no hay ofertas para mostrar.');
  } else {
    for (const offer of offers.slice(0, 5)) { 
      const message = createOfferMessage(offer, false);
      await botPolling.sendMessage(chatId, message, { parse_mode: 'HTML' });
    }
  }
});

// Función principal para revisar ofertas y enviar novedades
async function checkOffers() {
  console.log('⏰ Revisando ofertas...');
  const state = loadState();
  const filters = loadConfig();

  const offers = await getOffers(filters);

  if (state.firstRun) {
    console.log('Primera ejecución: guardando estado sin enviar mensajes.');
    state.seen_offers = offers.map((o) => o.id);
    state.firstRun = false;
    saveState(state);
    return;
  }

  for (const offer of offers) {
    if (!state.seen_offers.includes(offer.id)) {
      console.log('Nueva oferta detectada:', offer.title);
      const message = createOfferMessage(offer, true);
      await sendTelegramMessageToAll(message);
      state.seen_offers.push(offer.id);
      saveState(state);
    }
  }
}

// Ejecutar la revisión al iniciar servidor
checkOffers();

// Programar revisión cada 10 minutos con cron
cron.schedule('*/10 * * * *', () => {
  checkOffers();
});
 
// Arrancar servidor Express
app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
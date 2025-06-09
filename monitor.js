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
const URL_API = 'https://servicios3.abc.gob.ar/valoracion.docente/api/apd.oferta.encabezado/select';
const ESTADO_FILE = 'estado_ofertas.json';
const USERS_FILE = 'usuarios.json';

// Verificación de variables de entorno
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN debe estar definido en las variables de entorno.');
}

// Inicialización del bot para polling
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// --- Funciones Utilitarias ---

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

function loadUsers() {
  try {
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveUsers(users) {
  const uniqueUsers = [...new Set(users)]; // Eliminar duplicados
  fs.writeFileSync(USERS_FILE, JSON.stringify(uniqueUsers, null, 2));
}

function cleanString(str) {
  if (!str) return '';
  return str.trim();
}

function formatDateArg(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  return isNaN(date) ? dateStr : new Intl.DateTimeFormat('es-AR').format(date);
}

async function getOffers() {
  try {
    const params = new URLSearchParams({
      rows: '100',
      'facet': 'true',
      'facet.limit': '-1',
      'facet.mincount': '1',
      'json.nl': 'map',
      'facet.field': 'cargo',
      'fq': 'descdistrito:"general pueyrredon"',
      'fq': 'estado:Publicada',
      'q': '*:*',
      'wt': 'json'
    });

    const response = await axios.get(URL_API, { params });
    return response.data.response?.docs || [];
  } catch (error) {
    console.error('❌ Error obteniendo ofertas:', error.message);
    return [];
  }
}

function createOfferMessage(offer) {
  return `<b>🆕 Nueva Oferta:</b>
<b>Cargo:</b> ${cleanString(offer.cargo)}
<b>Domicilio:</b> ${cleanString(offer.domiciliodesempeno)}
<b>Distrito:</b> ${cleanString(offer.descdistrito)}
<b>Estado:</b> ${cleanString(offer.estado)}
<b>Cierre:</b> ${formatDateArg(offer.finoferta)}
<a href="https://servicios.abc.gob.ar/actos.publicos.digitales/">Ver oferta</a>`;
}

async function sendTelegramMessageToAll(message) {
  const users = loadUsers();
  for (const chatId of users) {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
      console.log(`📨 Mensaje enviado a usuario ${chatId}`);
    } catch (error) {
      console.error(`❌ Error enviando a ${chatId}:`, error.message);
    }
  }
}

// --- Telegram Bot Handlers ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  let users = loadUsers();

  if (!users.includes(chatId)) {
    users.push(chatId);
    saveUsers(users);
    console.log(`✅ Nuevo usuario registrado: ${chatId}`);
  }

  bot.sendMessage(chatId, '¡Hola! Te notificaré nuevas ofertas automáticamente.');
});

// --- Cron Task ---

cron.schedule('* * * * *', async () => {
  console.log('🔍 Buscando nuevas ofertas...');
  const state = loadState();
  const offers = await getOffers();

  const newOffers = offers.filter(offer => !state.seen_offers.includes(offer.idoferta));
  if (newOffers.length > 0) {
    console.log(`🆕 ${newOffers.length} nuevas ofertas encontradas.`);
    for (const offer of newOffers) {
      const message = createOfferMessage(offer);
      await sendTelegramMessageToAll(message);
      state.seen_offers.push(offer.idoferta);
    }
    state.firstRun = false;
    saveState(state);
  } else {
    console.log('No hay nuevas ofertas.');
  }
});

// --- Express Server ---

app.get('/', (_req, res) => {
  res.send('Bot activo y funcionando!');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
});

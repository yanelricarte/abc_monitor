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

function fixEncoding(str) {
  if (!str || typeof str !== 'string') return '';
  return str
    .replace(/�/g, (match, offset, string) => {
      // Intenta deducir qué reemplazar según el contexto
      // Esto es un ejemplo básico, puedes ajustarlo según patrones
      if (string[offset + 1]?.match(/[aAeE]/)) return 'á';
      if (string[offset + 1]?.match(/[eEiI]/)) return 'é';
      if (string[offset + 1]?.match(/[iIoO]/)) return 'í';
      if (string[offset + 1]?.match(/[oOuU]/)) return 'ó';
      if (string[offset + 1]?.match(/[uUnN]/)) return 'ú';
      return '°'; // Por defecto, reemplaza por °
    })
    .replace(/Ã¡/g, 'á')
    .replace(/Ã©/g, 'é')
    .replace(/Ã­/g, 'í')
    .replace(/Ã³/g, 'ó')
    .replace(/Ãº/g, 'ú')
    .replace(/Ã±/g, 'ñ')
    .replace(/Ã/g, 'Á')
    .replace(/Ã‰/g, 'É')
    .replace(/Ã/g, 'Í')
    .replace(/Ã“/g, 'Ó')
    .replace(/Ãš/g, 'Ú')
    .replace(/Ã‘/g, 'Ñ');
}
function cleanString(str) {
  if (!str) return '';
  return fixEncoding(str.trim().normalize('NFC'));
}


function loadState() {
  try {
    const data = fs.readFileSync(ESTADO_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { seen_offers: [], firstRun: true };
  }
}

function saveState(state) {
  fs.writeFileSync(ESTADO_FILE, JSON.stringify(state, null, 2));
}

function loadConfig() {
  try {
    const data = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    console.error('No se pudo cargar config.json, usando valores por defecto');
    return {
      rows: 100,
      descdistrito: 'general pueyrredon',
      estado: 'Publicada'
    };
  }
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
        date: cleanString(offer.inicio),
        cierreoferta: cleanString(offer.finoferta),
        zone: cleanString(offer.descdistrito),
        nivelModalidad: cleanString(offer.descnivelmodalidad),
        cursodivision: cleanString(offer.cursodivision),
        escuela: cleanString(offer.escuela),
        domiciliodesempeno: cleanString(offer.domiciliodesempeno),
        estado: cleanString(offer.estado),
        supl_hasta: cleanString(offer.supl_hasta),
        turno: cleanString(offer.turno),
        tomaposesion: cleanString(offer.tomaposesion),
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
    console.log('📨 Mensaje enviado a Telegram:\n', message);
  } catch (error) {
    console.error('❌ Error enviando mensaje a Telegram:', error.message);
  }
}

async function checkOffers() {
  console.log('🔎 Iniciando chequeo de ofertas...');
  const state = loadState();
  const seenOffers = new Set(state.seen_offers);
  const filters = loadConfig();

  const offers = await getOffers(filters);
  console.log(`🔢 Total ofertas procesadas: ${offers.length}`);

  let newCount = 0;

  // Primera ejecución: marcamos todas las ofertas como vistas sin enviar mensajes
  if (state.firstRun) {
    console.log('👋 Primera ejecución: registrando ofertas sin enviar mensajes.');
    state.firstRun = false;
    state.seen_offers = offers.map(o => o.id);
    saveState(state);
    console.log(`✅ Estado inicial guardado con ${offers.length} ofertas.`);
    return;
  }

  // De aquí en adelante, enviamos solo las ofertas nuevas
  for (const offer of offers) {
    if (!seenOffers.has(offer.id)) {
      const message = `
<b>Oferta:</b>
<b> Cargo:</b> ${offer.title}
<b> Cierre de oferta: </b> ${offer.cierreoferta} - Estado: ${offer.estado}
<b> Zona: </b> ${offer.zone}
<b> Nivel o Modalidad: </b> ${offer.nivelModalidad}
<b> Curso/División: </b> ${offer.cursodivision} - Turno: ${offer.turno}
<b> Domicilio: </b> ${offer.domiciliodesempeno}
<b> Suplente revista: </b>${offer.supl_revista}
<b> Toma posesión: </b> ${offer.tomaposesion}
<b> Suplente hasta: </b> ${offer.supl_hasta}
<b> Enlace: </b> ${offer.link}
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

// Programar la tarea para que corra cada 40 minutos
cron.schedule('*/40 * * * *', () => {
  console.log('⏱ Chequeo automático programado...');
  checkOffers();
});

// Ejecutar una vez al iniciar la aplicación
checkOffers();

// Función para envío manual de todas las ofertas
async function forzarEnvio() {
  console.log('🚀 Envío manual forzado de todas las ofertas...');
  const filters = loadConfig();
  const offers = await getOffers(filters);

  if (offers.length === 0) {
    console.log('ℹ️ No se encontraron ofertas para enviar.');
    return;
  }

  // Log de prueba: muestra la primera oferta sin afectar el envío de todas
  const primera = offers[0];
  console.log('📋 Oferta ejemplo para prueba manual:');
  console.log(`  Cargo: ${primera.title}`);
  console.log(`  Cierre: ${primera.cierreoferta} - Estado: ${primera.estado}`);
  console.log(`  Zona: ${primera.zone}`);
  console.log(`  Nivel/Modalidad: ${primera.nivelModalidad}`);
  console.log(`  Escuela: ${primera.escuela}`);
  console.log(`  Domicilio: ${primera.domiciliodesempeno}`);
  console.log('----------------------------------------------------');

  // Enviar todas las ofertas al canal
  for (const offer of offers) {
    const message = `
<b>Oferta:</b>
Cargo: ${offer.title}
Cierre de oferta: ${offer.cierreoferta} - Estado: ${offer.estado}
Zona: ${offer.zone}
Nivel o Modalidad: ${offer.nivelModalidad}
Curso/División: ${offer.cursodivision} - Turno: ${offer.turno}
Domicilio: ${offer.domiciliodesempeno}
Suplente revista: ${offer.supl_revista}
Toma posesión: ${offer.tomaposesion}
Suplente hasta: ${offer.supl_hasta}
Enlace: ${offer.link}
`;
    await sendTelegramMessage(message);
  }

  console.log(`✅ Envío manual completado. Total de ofertas enviadas: ${offers.length}`);
}

// Para probar manualmente, descomenta la siguiente línea:
forzarEnvio();
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
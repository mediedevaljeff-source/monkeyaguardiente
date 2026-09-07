/**
 * EL MONKEY — Tienda en línea (Google Apps Script + Wompi El Salvador)
 * =====================================================================
 * ANTES DE PUBLICAR, haz esto en orden:
 *
 * 1) Crea una Google Sheet vacía para guardar los pedidos y copia su ID
 *    (el texto largo en la URL entre /d/ y /edit).
 *
 * 2) En el editor de Apps Script: Proyecto ⚙ > Propiedades del script > Agregar propiedad:
 *      WOMPI_CLIENT_ID        -> "App ID" de tu negocio en panel.wompi.sv
 *      WOMPI_CLIENT_SECRET    -> "API Secret" del mismo negocio
 *      SHEET_ID               -> el ID de la hoja del paso 1
 *      EMAIL_NOTIFICACIONES   -> (opcional) tu correo para avisos de venta
 *
 * 3) Edita el catálogo PRODUCTOS y el costo ENVIO_FIJO más abajo con tus
 *    precios reales.
 *
 * 4) Implementar > Nueva implementación > Aplicación web
 *      Ejecutar como: Yo
 *      Quién tiene acceso: Cualquier usuario
 *    Copia la URL que termina en /exec — esa es la URL pública de tu tienda.
 *    (No uses la URL de "implementación de prueba": el webhook de Wompi
 *    necesita la URL definitiva de /exec).
 *
 * 5) En panel.wompi.sv, mientras tu negocio esté en modo "Desarrollo" puedes
 *    hacer compras de prueba: se aprueban automáticamente, y puedes forzar un
 *    rechazo simulado poniendo CVV = "111" en la pantalla de pago de Wompi.
 *    Cuando Registro Sanitario y tu negocio estén listos, cambia el negocio
 *    a "Productivo" en el panel — el código no necesita cambios.
 */

// ---------------------------------------------------------------------
// CATÁLOGO — edita nombres, descripciones y PRECIOS REALES aquí
// ---------------------------------------------------------------------
const PRODUCTOS = {
  'monkey-750': {
    nombre: 'El Monkey 750 ml',
    descripcion: 'Destilado de caña artesanal, 40% Alc. Vol. Botella de 750 ml.',
    precio: 12.50 // TODO: precio real
  },
  'monkey-250': {
    nombre: 'El Monkey 250 ml',
    descripcion: 'Destilado de caña artesanal. Presentación de 250 ml, ideal para regalo.',
    precio: 5.50
  }
};

const ENVIO_FIJO = 3.00; // TODO: ajusta el costo de envío o crea una lógica por departamento

const DEPARTAMENTOS_SV = [
  'San Salvador', 'La Libertad', 'Santa Ana', 'San Miguel', 'Sonsonate',
  'Usulután', 'La Unión', 'La Paz', 'Cuscatlán', 'Ahuachapán',
  'Chalatenango', 'Cabañas', 'Morazán', 'San Vicente'
];

const SHEET_NAME = 'Pedidos';

// ---------------------------------------------------------------------
// PÁGINAS WEB
// ---------------------------------------------------------------------

function doGet(e) {
  if (e.parameter.page === 'gracias') {
    const t = HtmlService.createTemplateFromFile('Gracias');
    t.aprobada = String(e.parameter.esAprobada).toLowerCase() === 'true';
    t.scriptUrl = ScriptApp.getService().getUrl();
    return t.evaluate().setTitle('El Monkey — Gracias');
  }

  const t = HtmlService.createTemplateFromFile('Index');
  t.productos = PRODUCTOS;
  t.departamentos = DEPARTAMENTOS_SV;
  t.envio = ENVIO_FIJO;
  return t.evaluate()
    .setTitle('El Monkey — Pedidos')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ---------------------------------------------------------------------
// AUTENTICACIÓN CON WOMPI (OAuth2 Client Credentials)
// ---------------------------------------------------------------------

function getWompiToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('wompi_token');
  if (cached) return cached;

  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('WOMPI_CLIENT_ID');
  const clientSecret = props.getProperty('WOMPI_CLIENT_SECRET');

  if (!clientId || !clientSecret) {
    throw new Error('Faltan WOMPI_CLIENT_ID / WOMPI_CLIENT_SECRET en Propiedades del script.');
  }

  const res = UrlFetchApp.fetch('https://id.wompi.sv/connect/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'client_credentials',
      audience: 'wompi_api',
      client_id: clientId,
      client_secret: clientSecret
    },
    muteHttpExceptions: true
  });

  const data = JSON.parse(res.getContentText());
  if (!data.access_token) {
    throw new Error('No se pudo autenticar con Wompi: ' + res.getContentText());
  }

  // Se cachea un poco antes de que expire (normalmente 3600s) para nunca usar uno vencido
  cache.put('wompi_token', data.access_token, Math.max(60, data.expires_in - 60));
  return data.access_token;
}

// ---------------------------------------------------------------------
// CREAR PEDIDO + ENLACE DE PAGO (llamado desde el navegador con google.script.run)
// ---------------------------------------------------------------------

function crearPedido(pedido) {
  if (!pedido || !pedido.items || !pedido.items.length) {
    throw new Error('El carrito está vacío.');
  }
  const c = pedido.cliente || {};
  if (!c.nombre || !c.telefono || !c.departamento || !c.municipio || !c.direccion) {
    throw new Error('Faltan datos de entrega.');
  }
  // El total SIEMPRE se calcula en el servidor con el catálogo real:
  // nunca se confía en un monto que venga del navegador.
  let subtotal = 0;
  const detalle = [];
  pedido.items.forEach(function (item) {
    const p = PRODUCTOS[item.id];
    if (!p) throw new Error('Producto inválido: ' + item.id);
    const cantidad = Math.max(1, parseInt(item.cantidad, 10) || 1);
    subtotal += p.precio * cantidad;
    detalle.push(p.nombre + ' x' + cantidad);
  });
  const total = Math.round((subtotal + ENVIO_FIJO) * 100) / 100;
  const identificador = 'MONKEY-' + new Date().getTime();

  registrarPedido_(identificador, c, detalle.join(', '), total);

  const token = getWompiToken_();
  const scriptUrl = ScriptApp.getService().getUrl();

  const body = {
    identificadorEnlaceComercio: identificador,
    monto: total,
    nombreProducto: 'Pedido El Monkey: ' + detalle.join(', '),
    formaPago: {
      permitirTarjetaCreditoDebido: true,
      permitirPagoConPuntoAgricola: false,
      permitirPagoEnCuotasAgricola: false,
      permitirPagoEnBitcoin: false,
      permitePagoQuickPay: false
    },
    configuracion: {
      urlWebhook: scriptUrl,
      urlRedirect: scriptUrl + '?page=gracias',
      notificarTransaccionCliente: true
    }
  };

  const res = UrlFetchApp.fetch('https://api.wompi.sv/EnlacePago', {
    method: 'post',
    contentType: 'application/json',
    headers: { authorization: 'Bearer ' + token },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  });

  const data = JSON.parse(res.getContentText());
  if (!data.urlEnlace) {
    throw new Error('Wompi no devolvió un enlace de pago: ' + res.getContentText());
  }

  return { url: data.urlEnlace, identificador: identificador };
}

// ---------------------------------------------------------------------
// WEBHOOK DE WOMPI
// Nota importante: Apps Script no puede leer el header "wompi_hash" que
// recomienda la documentación estándar de Wompi para validar el webhook.
// En vez de eso, usamos el método alterno que la propia documentación
// ofrece: al recibir el aviso, RECONSULTAMOS la transacción directamente
// al API de Wompi con nuestro propio token, y solo confiamos en esa
// respuesta autenticada — nunca en el contenido crudo del POST.
// ---------------------------------------------------------------------

function doPost(e) {
  try {
    const raw = e.postData ? e.postData.contents : '';
    if (!raw) return ContentService.createTextOutput('ok');

    const evento = JSON.parse(raw);
    const idTransaccion = evento.IdTransaccion || evento.idTransaccion;
    const identificador = evento.EnlacePago
      ? (evento.EnlacePago.IdentificadorEnlaceComercio || evento.EnlacePago.identificadorEnlaceComercio)
      : null;

    if (!idTransaccion || !identificador) {
      return ContentService.createTextOutput('ok'); // evento no reconocido, no se falla
    }

    const transaccion = verificarTransaccionWompi_(idTransaccion);
    const resultado = (transaccion.resultadoTransaccion || transaccion.ResultadoTransaccion || '')
      .toString().toLowerCase();
    const aprobada = resultado.indexOf('aprobada') !== -1;
    const esProductiva = (transaccion.esProductiva !== undefined) ? transaccion.esProductiva : transaccion.EsProductiva;

    actualizarPedido_(identificador, aprobada ? 'Pagado' : 'Rechazado', idTransaccion, esProductiva);

    if (aprobada) {
      notificarVentaConfirmada_(identificador, esProductiva);
    }
  } catch (err) {
    // Se registra el error pero se responde 200 para no generar reintentos infinitos
    console.error('Error en webhook Wompi: ' + err);
  }
  return ContentService.createTextOutput('ok');
}

function verificarTransaccionWompi_(idTransaccion) {
  const token = getWompiToken_();
  const res = UrlFetchApp.fetch('https://api.wompi.sv/TransaccionCompra/' + encodeURIComponent(idTransaccion), {
    method: 'get',
    headers: { authorization: 'Bearer ' + token },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('No se pudo verificar la transacción ' + idTransaccion + ': ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

// ---------------------------------------------------------------------
// HOJA DE CÁLCULO — registro de pedidos
// ---------------------------------------------------------------------

function getSheet_() {
  const sheetId = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!sheetId) throw new Error('Falta SHEET_ID en Propiedades del script.');
  const ss = SpreadsheetApp.openById(sheetId);
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(['Identificador', 'Fecha', 'Nombre', 'Teléfono', 'Departamento', 'Municipio', 'Dirección', 'Detalle', 'Total', 'Estado', 'IdTransacción', 'FechaPago']);
  }
  return sheet;
}

function registrarPedido_(identificador, cliente, detalle, total) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_().appendRow([
      identificador, new Date(), cliente.nombre, cliente.telefono,
      cliente.departamento, cliente.municipio, cliente.direccion,
      detalle, total, 'Pendiente', '', ''
    ]);
  } finally {
    lock.releaseLock();
  }
}

function actualizarPedido_(identificador, estado, idTransaccion, esProductiva) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][0] === identificador) {
        const etiqueta = (esProductiva === false) ? estado + ' (PRUEBA)' : estado;
        sheet.getRange(i + 1, 10).setValue(etiqueta);
        sheet.getRange(i + 1, 11).setValue(idTransaccion);
        sheet.getRange(i + 1, 12).setValue(new Date());
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function notificarVentaConfirmada_(identificador, esProductiva) {
  const email = PropertiesService.getScriptProperties().getProperty('EMAIL_NOTIFICACIONES');
  if (!email) return;
  const prefijo = (esProductiva === false) ? '[PRUEBA] ' : '';
  MailApp.sendEmail(email, prefijo + '🐒 Nuevo pedido pagado — ' + identificador,
    'Se confirmó el pago del pedido ' + identificador + '. Revisa la hoja "Pedidos" para los detalles y coordinar la entrega.');
}

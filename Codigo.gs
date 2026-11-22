/* ============================================================
   NÚCLEO NATIVO
   ============================================================ */

/*
=====================================================================
  HERALSA · REGISTRO EN CAMPO  ·  BACKEND  (v4)
  Archivo: Codigo.gs          ·  El frontend va en Index.html
=====================================================================
  QUE HACE ESTA VERSION (todo sale de los requisitos del usuario)

  1. EXPEDIENTE COMPLETO AL CREAR EL PEDIDO
     apiCrearPedido_() escribe en UNA sola operacion bloqueada:
       R3_Pedidos      -> 1 fila (el pedido)
       R2_Preparacion  -> 2 filas (parte F y parte R)
       R4_Entregas     -> 1 fila (la entrega)
     Alineacion: pedido k -> R3 fila k+1 · R4 fila k+1 · R2 filas 2k y 2k+1.

  2. R2_Detalle: UNA FILA POR REFERENCIA PENDIENTE (hoja nueva)
     Las referencias que no salieron de inventario ya no van como lista
     dentro de una celda: van una por fila, con su descripcion, como se
     va a suplir, y si finalmente se suplio o no.

  3. Estado_registro CON 4 ESTADOS. Regla unica para los indicadores:
     SOLO CUENTA LO QUE DIGA "VIGENTE".
       PENDIENTE  = la fila existe, el proceso no llego ahi
       VIGENTE    = tiene datos reales y cuenta
       NO_APLICA  = ese pedido no llevaba esa parte (F o R)
       ANULADO    = se inhabilito, con motivo, quien y cuando

  4. CANDADO DE ANULACION: una fila ANULADO es INMODIFICABLE, venga de
     donde venga. Si otro celular con datos viejos la intenta escribir,
     el servidor la rechaza y lo reporta.

  5. CATALOGOS CON DESCRIPCION: el buscador de la app muestra codigo y
     nombre. Los productos traen Tipo_trabajo (F/R/M) como informacion,
     NUNCA como filtro: la lista completa siempre esta disponible.

  6. COMPRAS DIFERENCIADAS: cada compra es de PRODUCTO o de MP, nunca
     mixta, para que el lead time y el TCR no mezclen poblaciones.

  7. NUMEROS EXACTOS: el servidor no redondea nada. El redondeo es solo
     de presentacion, en la pantalla.

  MIGRACIONES (se corren una sola vez, y avisan si ya se corrieron):
     simularMigracion_() / migrar_()            -> linea base de numeracion
     simularReparto_()   / repartir_()          -> llena R2_Detalle desde
                                                 Por_pedir y Faltante
  SI MIGRAS DE HOJA: cambia SS_ID.
=====================================================================
*/

var SS_ID = ''; // No escribir identificadores aquí: usar HERALSA_SPREADSHEET_ID si el proyecto es independiente.
var H = {
  compras:'R1_Compras',  detalle:'R1_Detalle',
  prep:'R2_Preparacion', prepDet:'R2_Detalle',
  pedidos:'R3_Pedidos',  entregas:'R4_Entregas',
  clientes:'CAT_Clientes', proveedores:'CAT_Proveedores',
  productos:'CAT_Productos', materias:'CAT_MateriasPrimas',
  /* --- FASE 2 --- las tres unicas hojas nuevas, y las tres son de REGISTRO:
     el kardex, la auditoria del lapiz de edicion y la configuracion.
     Ninguna tabla transaccional nueva: la factura es una proyeccion de
     R2_Detalle + R3 + R4, no una tabla. */
  mov:'MOV_Inventario', log:'LOG_Cambios', cfg:'CFG_Config'
};
var COL_EST = 'Estado_registro', COL_MOT = 'Motivo_anulacion',
    COL_POR = 'Anulado_por',     COL_CUA = 'Anulado_en';
var E_PEND = 'PENDIENTE', E_VIG = 'VIGENTE', E_NA = 'NO_APLICA', E_ANU = 'ANULADO';
var DIGITOS = 3;   /* P-001 */

/* =====================================================================
   v5.3 · RENDIMIENTO · EL LIBRO SE ABRE UNA VEZ POR EJECUCION
   =====================================================================
   MEDIDO, no supuesto: libro() hacia getProperty + openById en CADA
   llamada, y filas() la llamaba DOS veces (una para la hoja y otra solo
   para la zona horaria, que no cambia). Un apiEstado completo disparaba
   del orden de 27 aperturas del libro antes de leer un solo dato.

   Cada ejecucion de Apps Script arranca con un ambito global nuevo, asi
   que esta variable vive lo que vive la peticion: no hay forma de que un
   usuario vea el libro de otro, ni de que quede un libro viejo cacheado
   entre peticiones. Y no cachea DATOS, solo el objeto del libro: si otro
   dispositivo escribe una fila, la siguiente lectura la trae igual.
   ===================================================================== */
var LIBRO_ABIERTO_ = null;
var LIBRO_TZ_ = '';

function libro(){
  if(LIBRO_ABIERTO_) return LIBRO_ABIERTO_;
  var id = PropertiesService.getScriptProperties().getProperty('HERALSA_SPREADSHEET_ID') || SS_ID;
  var ss = id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
  if(!ss) throw new Error('No hay libro activo. Abre Apps Script desde el Sheet o configura HERALSA_SPREADSHEET_ID en Propiedades del script.');
  LIBRO_ABIERTO_ = ss;
  return ss;
}
/** La zona horaria del libro no cambia durante una ejecucion. */
function tzLibro_(){
  if(!LIBRO_TZ_) LIBRO_TZ_ = libro().getSpreadsheetTimeZone();
  return LIBRO_TZ_;
}
function hoja(n){
  var sh = libro().getSheetByName(n);
  if(!sh) throw new Error('No existe la pestana "' + n + '"');
  return sh;
}
function ahora(){ return Utilities.formatDate(new Date(), tzLibro_(), 'yyyy-MM-dd HH:mm'); }
function ceros(n){ var s = String(n); while(s.length < DIGITOS) s = '0' + s; return s; }
function txt(v){ return String(v == null ? '' : v).trim(); }
function low(v){ return txt(v).toLowerCase(); }

/* ===================== EL FRONTEND ===================== */
function doGet(){
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('HERALSA · Registro en campo')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .addMetaTag('mobile-web-app-capable', 'yes')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ===================== LECTURA ===================== */
function apiPing_(){ var ss = libro(); return { ok:true, hoja:ss.getName(), pestanas:ss.getSheets().length }; }

/** Catalogo como lista de objetos {v:valor, d:descripcion, t:tipo}. */
function catalogo(nombreHoja, colDesc, colTipo){
  var sh = libro().getSheetByName(nombreHoja);
  if(!sh || sh.getLastRow() < 2) return [];
  var idx = indices(sh);
  var bloque = sh.getRange(2, 1, sh.getLastRow() - 1, idx.__ancho).getValues();
  var campoValor = nombreHoja === H.clientes ? 'Cliente' : nombreHoja === H.proveedores ? 'Proveedor' : 'Codigo';
  var iV = idx[campoValor] !== undefined ? idx[campoValor] : 0;
  var iAct = idx['Activo'], iD = colDesc ? idx[colDesc] : undefined, iT = colTipo ? idx[colTipo] : undefined;
  var out = [], vistos = {};
  for(var i = 0; i < bloque.length; i++){
    var v = txt(bloque[i][iV]);
    if(!v) continue;
    if(iAct !== undefined && txt(bloque[i][iAct]).toUpperCase() === 'N') continue;
    if(vistos[v.toLowerCase()]) continue;
    vistos[v.toLowerCase()] = 1;
    var o = { v:v };
    if(iD !== undefined && txt(bloque[i][iD])) o.d = txt(bloque[i][iD]);
    if(iT !== undefined && txt(bloque[i][iT])) o.t = txt(bloque[i][iT]).toUpperCase();
    out.push(o);
  }
  out.sort(function(a, b){ return a.v < b.v ? -1 : a.v > b.v ? 1 : 0; });
  return out;
}
/** Solo los valores, para comparar. */
function columna(nombreHoja){ return catalogo(nombreHoja).map(function(o){ return o.v; }); }

/**
 * Devuelve los catalogos como LISTAS DE TEXTO (compatibles con cualquier version
 * del frontend) mas tres mapas con la informacion extra. Asi, si alguna vez el
 * Index.html y el Codigo.gs quedan desfasados, la app no se rompe.
 */
function apiCatalogos_(){
  var cl = catalogo(H.clientes);
  var pv = catalogo(H.proveedores, null, 'Clase');
  var pr = catalogo(H.productos, 'Descripcion', 'Tipo_trabajo');
  var mt = catalogo(H.materias, 'Descripcion');
  function vals(l){ return l.map(function(o){ return o.v; }); }
  var desc = {}, tipo = {}, clase = {};
  pr.forEach(function(o){ if(o.d) desc[o.v] = o.d; if(o.t) tipo[o.v] = o.t; });
  mt.forEach(function(o){ if(o.d) desc[o.v] = o.d; });
  pv.forEach(function(o){ if(o.t) clase[o.v] = o.t; });
  return {
    clientes:vals(cl), proveedores:vals(pv), productos:vals(pr), materias:vals(mt),
    desc:desc, tipo:tipo, clase:clase
  };
}

/** Todo lo que la app necesita para reconstruirse. La hoja es la unica verdad. */
/* =====================================================================
   v5.1 · C2 · MODO LIGERO PARA EL CICLO DE 30 SEGUNDOS
   =====================================================================
   El ciclo de sincronizacion llamaba a esto cada 30 segundos y por cada
   dispositivo, y esto lee TRECE hojas completas, entre ellas el catalogo
   de 853 productos, los 124 clientes y el log de cambios, que crece sin
   parar. Nada de eso cambia en 30 segundos.
   En modo ligero se devuelve solo lo operativo: lo que de verdad se mueve
   cuando alguien trabaja. Se marca con ligero:true para que la app FUSIONE
   en lugar de reemplazar, y no se quede sin catalogo.
   Al entrar, al cambiar de pantalla y al refrescar a mano se sigue
   pidiendo el estado COMPLETO, asi que nadie trabaja con un catalogo viejo.
   ===================================================================== */
function apiEstado_(ligero){
  var e = {
    compras:   filas(H.compras),
    detalle:   filas(H.detalle),
    partes:    filas(H.prep),
    refs:      filas(H.prepDet),
    pedidos:   filas(H.pedidos),
    entregas:  filas(H.entregas),
    /* --- FASE 2 --- se devuelven con el mismo criterio: la hoja manda.
       Si una hoja todavia no existe, filas() devuelve [] y la app sigue
       funcionando: Fase 2 degrada a Fase 1 en vez de romperse. */
    movimientos:  filas(H.mov),
    config:       filas(H.cfg),
    ahora:     ahora()
  };
  if(ligero){ e.ligero = true; return e; }
  e.catalogos    = apiCatalogos_();
  e.cambios      = filas(H.log);
  e.productos    = filas(H.productos);
  e.clientesFull = filas(H.clientes);
  return e;
}

/** Filas como objetos {Columna: valor}. __fila = fila real, para auditar alineacion. */
function filas(nombreHoja){
  var sh = libro().getSheetByName(nombreHoja);
  if(!sh || sh.getLastRow() < 2) return [];
  var ancho = Math.max(sh.getLastColumn(), 1);
  var cols = sh.getRange(1, 1, 1, ancho).getValues()[0];
  var bloque = sh.getRange(2, 1, sh.getLastRow() - 1, ancho).getValues();
  var tz = tzLibro_(), out = [];
  for(var i = 0; i < bloque.length; i++){
    if(!txt(bloque[i][0])) continue;
    var o = { __fila: i + 2 };
    for(var j = 0; j < cols.length; j++){
      var v = bloque[i][j];
      o[txt(cols[j])] = (v instanceof Date) ? fechaTexto(v, tz) : v;
    }
    out.push(o);
  }
  return out;
}
/** Una fecha sin hora sale sin hora: asi la hoja no cambia de formato al reescribirla. */
function fechaTexto(d, tz){
  var hhmm = Utilities.formatDate(d, tz, 'HH:mm');
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd') + (hhmm === '00:00' ? '' : ' ' + hhmm);
}

/* ===================== CONSECUTIVOS ===================== */
/** Unica fuente de numeros. Nunca reutiliza: cuenta el maximo, aunque este anulado. */
function nuevoId(prefijo){
  var sh = hoja(prefijo === 'C' ? H.compras : H.pedidos);
  var n = sh.getLastRow(), max = 0;
  if(n > 1){
    var ids = sh.getRange(2, 1, n - 1, 1).getValues();
    for(var i = 0; i < ids.length; i++){
      var m = String(ids[i][0]).match(/-(\d+)\s*$/);
      if(m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return prefijo + '-' + ceros(max + 1);
}
function apiNuevoId_(prefijo){
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{ return nuevoId(prefijo); } finally { lock.releaseLock(); }
}

/* ===================== CREACION DEL EXPEDIENTE ===================== */
/**
 * Crea el pedido COMPLETO en las 3 hojas, de una vez y con candado.
 * fila3 = objeto con los nombres de columna de R3 (sin P_num).
 */
function apiCrearPedido_(fila3){
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    var id = nuevoId('P'), f = {}, k;
    for(k in (fila3 || {})) f[k] = fila3[k];
    f['P_num'] = id;
    f[COL_EST] = E_VIG;
    f['Etapa_preparacion'] = 'ORGANIZAR';
    f['Revision'] = 1;
    f['Organizado_en'] = ahora();
    var r3 = escribirFila({ hoja:H.pedidos, claves:[{ columna:'P_num', valor:id }], fila:f });

    var cli = f['Cliente'] || '', can = f['Canal'] || '';
    var rF = escribirFila({ hoja:H.prep, noSello:true,
      claves:[{ columna:'P_num', valor:id }, { columna:'Tipo', valor:'F' }],
      fila:{ P_num:id, Tipo:'F', Estado_registro:E_PEND } });
    var rR = escribirFila({ hoja:H.prep, noSello:true,
      claves:[{ columna:'P_num', valor:id }, { columna:'Tipo', valor:'R' }],
      fila:{ P_num:id, Tipo:'R', Estado_registro:E_PEND } });
    var r4 = escribirFila({ hoja:H.entregas, noSello:true,
      claves:[{ columna:'P_num', valor:id }],
      fila:{ P_num:id, Cliente:cli, Canal:can, Estado_registro:E_PEND } });

    return { ok:true, id:id, filas:{ pedido:r3.fila, parteF:rF.fila, parteR:rR.fila, entrega:r4.fila } };
  } finally { lock.releaseLock(); }
}

/**
 * Crea la compra COMPLETA: cabecera + una linea por referencia.
 * Una compra es de PRODUCTO o de MP, nunca mixta.
 */
function apiCrearCompra_(fila1, lineas){
  fila1=fila1||{};
  var forma=txt(fila1.Forma_pago)||'Contado',medio=txt(fila1.Medio_pago)||'Efectivo';
  if(['Contado','Contraentrega','Pago_al_recibir','Credito'].indexOf(forma)<0)throw new Error('Forma de pago de compra no válida.');
  if(AL_MEDIO.indexOf(medio)<0)throw new Error('Medio de pago de compra no válido.');
  if(!(numero(fila1.Valor_total)>0))throw new Error('La compra necesita un valor total mayor que cero.');
  var plazo=numero(fila1.Plazo_dias)||0,esCredito=forma.toUpperCase().indexOf('CRED')===0;
  if(esCredito&&plazo<=0)throw new Error('Una compra a crédito necesita un plazo en días.');
  if(!esCredito&&plazo>0)throw new Error('Sólo una compra a crédito puede tener plazo.');
  if(!Array.isArray(lineas)||!lineas.length)throw new Error('La compra necesita al menos una línea.');
  lineas.forEach(function(l){
    if(!l||!txt(l.Codigo))throw new Error('Cada línea de compra necesita un código.');
    if(!(numero(l.Cant_pedida)>0))throw new Error('Cada línea de compra necesita una cantidad mayor que cero.');
  });
  fila1.Forma_pago=forma;fila1.Medio_pago=medio;fila1.Plazo_dias=esCredito?plazo:'';
  if(esCredito&&!txt(fila1.Vencimiento))fila1.Vencimiento=masDias(txt(fila1.tp),plazo);
  if(!esCredito)fila1.Vencimiento='';
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    var id = nuevoId('C'), f = {}, k;
    for(k in (fila1 || {})) f[k] = fila1[k];
    f['C_num'] = id;
    f[COL_EST] = E_VIG;
    escribirFila({ hoja:H.compras, claves:[{ columna:'C_num', valor:id }], fila:f });
    (lineas || []).forEach(function(l){
      var d = {}; for(var kk in l) d[kk] = l[kk];
      d['C_num'] = id;
      d['Proveedor'] = f['Proveedor'] || '';
      d['tn'] = f['tn'] || '';
      d[COL_EST] = E_VIG;
      escribirFila({ hoja:H.detalle, noSello:true,
        claves:[{ columna:'C_num', valor:id }, { columna:'Codigo', valor:d['Codigo'] }], fila:d });
    });
    return { ok:true, id:id };
  } finally { lock.releaseLock(); }
}

/* ===================== ESCRITURA ===================== */
/**
 * Escribe un lote de filas.
 *
 * v5.0 · EL SERVIDOR NO CONFIA EN EL CELULAR. Antes esta funcion escribia lo
 * que le llegara. Ahora, las filas que van a R2_Detalle pasan por
 * validarLineas() y se RECHAZAN si violan I-17 (despachar mas de lo pedido) o
 * si dicen que salieron de inventario con W distinto de N.
 *
 * Por que aqui y no solo en la app: la app impide escribir W > N en el
 * teclado, pero un celular con una version vieja, una peticion repetida, o la
 * cola de sincronizacion de un dispositivo que estuvo dias sin señal pueden
 * traer una linea imposible. La unica barrera que de verdad protege la hoja es
 * la que esta del lado de la hoja.
 */
/* =====================================================================
   v5.5 · LAS COLUMNAS DEL DOCUMENTO SON DEL SERVIDOR
   =====================================================================
   Estas columnas de R4_Entregas las escribe UNICAMENTE el servidor, en
   apiDocumento_ (remision y decision de FE) y en apiAlegraEmitir /
   apiAlegraEstado (la factura electronica real). Ninguna cola de ningun
   dispositivo puede tocarlas: ver el comentario largo en el bucle de
   apiGuardar_, que explica el defecto que esto cierra y por que tiene que
   estar en el servidor y no en el navegador.

   Lo que NO esta en esta lista, a proposito, porque si es del navegador:
   te, Gasto_entrega, Completa, A_tiempo, Sin_novedad, Documento_correcto,
   OTIF, Motivo_no_OTIF, Observaciones -- todo lo que el operador registra
   al entregar -- y las cuatro columnas de anulacion.
   ===================================================================== */
var COLS_DOC_SERVIDOR_ = ['Doc_tipo', 'Doc_numero', 'Doc_fecha', 'Doc_estado', 'Doc_vendedor',
                          'Forma_pago', 'Medio_pago', 'Plazo_dias', 'Vencimiento',
                          'Alegra_id', 'CUFE', 'Estado_DIAN', 'Emitido_en'];

/* La regla, en una funcion PURA, para que se pueda comprobar caso por caso
   sin tocar la hoja. La comprueba heralsaVerificarDocumento(). */
function colaPuedeEscribirDocumento_(traeDoc, yaTieneDoc){
  return !!txt(traeDoc) && !yaTieneDoc;
}

/* =====================================================================
   v5.5.2 · BUG_023 · «P-021 YA ESTABA LISTO EN OTRO DISPOSITIVO» EN BUCLE
   =====================================================================
   LA CONTRADICCION, y esta escrita en el propio mensaje de error que se
   lanzaba: decia «Entrega y documento siguen habilitados; la preparacion no
   se puede sobrescribir»... y acto seguido BLOQUEABA la fila de R3 que
   manda la entrega. Porque registrar una entrega sube dos filas:
   packEntrega (R4) y packPedido (R3, con Estado = ENTREGADO). Y un pedido
   que se entrega esta necesariamente LISTO, asi que la guarda disparaba
   SIEMPRE. La guarda prohibia justo lo que su propio mensaje prometia.

   LO QUE OCULTABA: el navegador descartaba la fila de R3, subia solo la de
   R4, y la entrega quedaba en R4 mientras R3 NUNCA recibia
   Estado = ENTREGADO. No se notaba porque derivarPar_ deduce ENTREGADO de
   la fecha te: la derivacion tapaba una escritura que no ocurria. Es el
   mismo patron de media escritura que vengo cerrando.

   LA REGLA CORRECTA no es «cerrado = no se toca», es EL EXPEDIENTE AVANZA
   Y NO RETROCEDE:
     R2_Preparacion y R2_Detalle   nunca si el pedido ya esta cerrado. Esa
                                   era la intencion original y se conserva:
                                   la preparacion no se reescribe despues.
     R3_Pedidos                    se permite si el estado que llega es
                                   igual o MAS avanzado que el de la hoja.
                                   LISTO -> ENTREGADO es avanzar: se
                                   permite. ENTREGADO -> EN_PREPARACION es
                                   retroceder: se bloquea.
   Asi la entrega puede escribir su propio estado y ningun dispositivo con
   datos viejos puede reabrir un pedido cerrado.
   ===================================================================== */
var ORDEN_ESTADO_ = { '':0, 'NUEVO':1, 'EN_PREPARACION':2, 'LISTO':3, 'ENTREGADO':4 };

function colaPuedeEscribirExpediente_(nombreHoja, estadoEntrante, estadoHoja, etapaHoja){
  var eh = txt(estadoHoja).toUpperCase(), th = txt(etapaHoja).toUpperCase();
  var cerrado = (eh === 'LISTO' || eh === 'ENTREGADO' || th === 'LISTO');
  if(nombreHoja === 'R2_Preparacion' || nombreHoja === 'R2_Detalle') return !cerrado;
  if(nombreHoja !== 'R3_Pedidos') return true;      /* no es asunto de esta regla */
  var ee = txt(estadoEntrante).toUpperCase();
  if(!ee) return true;        /* no trae estado: no mueve el expediente */
  var oe = ORDEN_ESTADO_[ee], oh = ORDEN_ESTADO_[eh];
  if(oe === undefined || oh === undefined) return true;   /* valor raro: no se adivina */
  return oe >= oh;
}

/* COPIA EXACTA de la lista de columnas de R4 que proyecta el navegador
   (index.html, sheetData(4)). Se tiene aqui para poder comprobar que
   NINGUNA columna de documento que el navegador sepa escribir se quede sin
   proteger. Es el mismo criterio que ya se usa con derivarPar_: la copia
   existe para que una comprobacion automatica detecte la divergencia.
   Si se cambia la lista alla, heralsaVerificarDocumento() lo dira. */
var COLS_R4_NAVEGADOR_ = ['P_num','Cliente','Canal','tl','te','Ciclo_entrega_d','Gasto_entrega',
  'Completa','A_tiempo','Sin_novedad','Documento_correcto','OTIF','Motivo_no_OTIF','Observaciones',
  'Operador','Registrado_en','Doc_tipo','Doc_numero','Doc_fecha','Doc_estado','Forma_pago',
  'Medio_pago','Plazo_dias','Vencimiento','Estado_registro','Motivo_anulacion','Anulado_por','Anulado_en'];

/* =====================================================================
   v5.5 · COMPROBACION EJECUTABLE DE LA REGLA DEL DOCUMENTO
   =====================================================================
   SOLO LEE. Comprueba tres cosas que no se pueden «ver» leyendo:
     1. la tabla completa de la regla de la cola, los cuatro casos
     2. que toda columna de documento que el navegador sabe escribir este
        protegida (si manana alguien agrega una alla y no aqui, falla)
     3. que el filtro de dias negativos este en los tres indicadores
   ===================================================================== */
function heralsaVerificarDocumento(){
  var fallos = 0, L = function(s){ Logger.log(s); };
  L('===== VERIFICACION DE LA REGLA DEL DOCUMENTO · solo lectura =====');
  L('');

  L('--- 1 · la regla de la cola, los cuatro casos ---');
  var casos = [
    { trae:'REMISION', ya:false, esperado:true,
      caso:'la cola trae documento y la fila no tiene ninguno (emision sin señal)' },
    { trae:'',         ya:true,  esperado:false,
      caso:'la cola trae las columnas EN BLANCO y la fila si tiene documento  <-- el defecto de P-021' },
    { trae:'',         ya:false, esperado:false,
      caso:'la cola trae blanco y la fila tampoco tiene: nada que escribir' },
    { trae:'REMISION', ya:true,  esperado:false,
      caso:'la cola intenta CAMBIAR un documento ya emitido' }
  ];
  casos.forEach(function(c){
    var r = colaPuedeEscribirDocumento_(c.trae, c.ya);
    var ok = (r === c.esperado);
    if(!ok) fallos++;
    L('   ' + (ok ? 'OK  ' : 'FALLA') + ' · ' + (r ? 'se permite' : 'se bloquea') + ' · ' + c.caso);
  });
  L('');

  L('--- 1b · la regla del expediente: avanza, no retrocede ---');
  var casosExp = [
    { h:'R3_Pedidos', e:'ENTREGADO', eh:'LISTO', th:'LISTO', esperado:true,
      caso:'la ENTREGA escribe su estado en un pedido LISTO  <-- el bucle de P-021' },
    { h:'R3_Pedidos', e:'LISTO', eh:'LISTO', th:'LISTO', esperado:true,
      caso:'reenvio del mismo estado (idempotente)' },
    { h:'R3_Pedidos', e:'EN_PREPARACION', eh:'ENTREGADO', th:'LISTO', esperado:false,
      caso:'un dispositivo con datos viejos intenta REABRIR un pedido entregado' },
    { h:'R3_Pedidos', e:'', eh:'LISTO', th:'LISTO', esperado:true,
      caso:'la fila no trae estado: no mueve el expediente' },
    { h:'R2_Detalle', e:'', eh:'LISTO', th:'LISTO', esperado:false,
      caso:'reescribir la PREPARACION de un pedido cerrado' },
    { h:'R2_Preparacion', e:'', eh:'EN_PREPARACION', th:'DESPACHAR', esperado:true,
      caso:'preparacion de un pedido todavia abierto' },
    { h:'R4_Entregas', e:'', eh:'LISTO', th:'LISTO', esperado:true,
      caso:'R4 no es asunto de esta regla (tiene la suya)' }
  ];
  casosExp.forEach(function(c){
    var r = colaPuedeEscribirExpediente_(c.h, c.e, c.eh, c.th);
    var ok = (r === c.esperado);
    if(!ok) fallos++;
    L('   ' + (ok ? 'OK  ' : 'FALLA') + ' · ' + (r ? 'se permite' : 'se bloquea') + ' · ' + c.caso);
  });
  L('');

  L('--- 2 · ninguna columna de documento del navegador sin proteger ---');
  var sinProteger = COLS_R4_NAVEGADOR_.filter(function(c){
    return /^Doc_|^Forma_pago$|^Medio_pago$|^Plazo_dias$|^Vencimiento$|^Alegra_|^CUFE$|^Estado_DIAN$|^Emitido_en$/.test(c)
           && COLS_DOC_SERVIDOR_.indexOf(c) < 0;
  });
  if(sinProteger.length){ fallos++; L('   FALLA · sin proteger: ' + sinProteger.join(', ')); }
  else L('   OK   · las ' + COLS_R4_NAVEGADOR_.filter(function(c){ return COLS_DOC_SERVIDOR_.indexOf(c) >= 0; }).length +
         ' columnas de documento que el navegador proyecta estan protegidas');
  var noProyectadas = COLS_DOC_SERVIDOR_.filter(function(c){ return COLS_R4_NAVEGADOR_.indexOf(c) < 0; });
  L('   (protegidas de mas, que el navegador no manda: ' + (noProyectadas.join(', ') || 'ninguna') +
    ' · son las de Alegra y Doc_vendedor, y protegerlas no estorba)');
  L('');

  L('--- 3 · la fila de R4 tiene que existir y ser localizable por P_num ---');
  var shv = hoja(H.entregas), idxv = indices(shv);
  var hue = 0, ult = shv.getLastRow();
  if(ult > 1 && idxv['P_num'] !== undefined){
    var colP = shv.getRange(2, 1, ult - 1, Math.max(idxv['P_num'] + 1, 1)).getValues();
    for(var i = 0; i < colP.length; i++) if(!txt(colP[i][0])) hue++;
  }
  if(hue){ fallos++; L('   FALLA · ' + hue + ' fila(s) de R4 con la primera columna vacia: invisibles para todo el sistema'); }
  else L('   OK   · ninguna fila invisible en R4_Entregas');
  L('');

  L(fallos === 0 ? '===== 0 FALLOS =====' : '===== ' + fallos + ' FALLO(S) · no publique con esto en rojo =====');
  return { ok:fallos === 0, fallos:fallos };
}

function apiGuardar_(datos){
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    var n = 0, bloqueadas = [], rechazadas = [], rechazadas_cierre = [], saltar_ = {};

    /* Ninguna escritura del lote se adelanta a un conflicto de cierre. */
    /* v5.3 · RENDIMIENTO · este buscarEn(filas(H.pedidos)) estaba DENTRO del
       bucle: con un lote de 12 filas eran 12 lecturas completas e identicas
       de R3_Pedidos para responder la misma pregunta. Ahora se lee una vez,
       y solo si el lote toca alguna hoja del expediente. */
    var cabsCierre_ = null;
    /* v5.5 · se lee UNA vez y solo si el lote trae alguna fila de R4, igual
       criterio que cabsCierre_: ver el comentario de la regla del documento
       mas abajo, en el bucle de escritura. */
    var entActuales_ = null;
    /* =================================================================
       v5.5.2 · BUG_023 · SE RECHAZA LA FILA, NO EL LOTE
       =================================================================
       Esto lanzaba una EXCEPCION que botaba el lote COMPLETO, hasta 20
       filas, por una sola que no cuadrara. Y es justo lo contrario del
       principio que este mismo archivo declara doce lineas mas abajo:
       «si una esta mal, se rechaza solo ella, no el lote entero. Rechazar
       todo haria que un error de una linea botara el trabajo de un dia».
       La validacion de lineas lo cumplia; esta guarda no.

       PEOR TODAVIA, y es lo que colapso la aplicacion: el navegador tenia
       que ADIVINAR cual fila sobraba leyendo el numero de pedido DENTRO
       del texto del mensaje de error. Cuando su filtro no acertaba,
       descartaba 0 filas y volvia a mandar el MISMO lote, que volvia a
       fallar: un bucle infinito con un aviso cada pocos segundos. Hacer
       que el cliente deduzca de una cadena de texto cual dato rechazo el
       servidor es fragil por construccion.

       AHORA el servidor dice EXACTAMENTE que filas no escribio y por que,
       en un campo de datos (rechazadas_cierre), no en un mensaje. El
       navegador las saca por identidad -- hoja y clave -- sin interpretar
       texto. Lo demas del lote SI se escribe.
       ================================================================= */
    (datos || []).forEach(function(d, i){
      if(!d || [H.pedidos, H.prep, H.prepDet].indexOf(d.hoja) < 0) return;
      var pidCierre = txt((d.claves && d.claves[0] && d.claves[0].valor) || (d.fila || {}).P_num);
      if(pidCierre && !cabsCierre_) cabsCierre_ = indicePor_(filas(H.pedidos), 'P_num');
      var cabCierre = pidCierre ? (cabsCierre_[pidCierre] || null) : null;
      if(!cabCierre) return;
      if(colaPuedeEscribirExpediente_(d.hoja, (d.fila || {}).Estado,
                                      cabCierre.Estado, cabCierre.Etapa_preparacion)) return;
      saltar_[i] = true;
      rechazadas_cierre.push({
        hoja: d.hoja, id: pidCierre,
        clave: (d.claves || []).map(function(c){ return txt(c.columna) + '=' + txt(c.valor); }).join(' · '),
        motivo: (d.hoja === H.pedidos)
          ? (pidCierre + ' esta en ' + (txt(cabCierre.Estado) || '(vacio)') + ' en la hoja y llega como ' +
             (txt((d.fila || {}).Estado) || '(vacio)') + ': el expediente no retrocede.')
          : (pidCierre + ' ya esta cerrado: la preparacion no se reescribe. Entrega y documento siguen habilitados.')
      });
    });

    /* primero se validan TODAS las lineas del lote: si una esta mal, se
       rechaza solo ella, no el lote entero. Rechazar todo haria que un error
       de una linea botara el trabajo de un dia. */
    var lineas = (datos || []).filter(function(d){ return d && d.hoja === H.prepDet; })
                              .map(function(d){ return d.fila || {}; });
    var errores = validarLineas(lineas);
    var malas = {};
    errores.forEach(function(e){
      var ref = String(e).split(':')[0];
      malas[ref] = (malas[ref] ? malas[ref] + ' · ' : '') + e;
    });

    for(var i = 0; i < datos.length; i++){
      var d = datos[i];
      if(saltar_[i]) continue;          /* v5.5.2 · rechazada por la regla del expediente */
      if(d && d.hoja === H.prepDet){
        var ref = txt((d.fila || {})['Referencia']);
        if(malas[ref]){ rechazadas.push(malas[ref]); continue; }
      }
      /* =================================================================
         v5.4 · BUG_004 · EL ESCRITOR LATERAL YA NO PUEDE DESALINEAR EL PAR
         =================================================================
         packPedido() sube la cabecera de R3 con la lista de columnas de
         sheetData(3), que NO incluye Etapa_preparacion. Por eso un flujo
         como registrar la entrega podia mover Estado a ENTREGADO dejando
         Etapa_preparacion en FINALIZAR, y el pedido entraba en la
         combinacion que lo atasca.
         Ahora, cuando una fila de R3 trae Estado, se completa con la Etapa
         que le corresponde a ese Estado. No se adivina nada: se usa la
         misma tabla de equivalencia del clasificador.
         ================================================================= */
      if(d && d.hoja === H.pedidos && d.fila && txt(d.fila.Estado)){
        var etq = etapaParaEstado_(txt(d.fila.Estado));
        if(etq && !txt(d.fila.Etapa_preparacion)){
          d.fila.Etapa_preparacion = etq;
          d.atomico = true;
        }
      }
      /* =================================================================
         v5.5 · BUG_014 · LA CORRECCION DE RAIZ: UN SOLO DUEÑO POR COLUMNA
         =================================================================
         EL DEFECTO, probado con los datos del libro: la fila 22 de
         R4_Entregas (P-021) tenia Doc_vendedor="Cristian" y las ocho
         columnas del documento VACIAS. Doc_vendedor la escribe UNICAMENTE
         apiDocumento_; el navegador solo la lee. Las otras ocho SI estan en
         la proyeccion de R4 del navegador. Y Estado_registro decia
         PENDIENTE, que el navegador escribe exactamente cuando su copia
         local del documento esta vacia.
         Es decir: el servidor emitio y escribio bien, y despues la cola del
         navegador reescribio la fila COMPLETA desde una copia local sin
         documento y la borro. Sobrevivio la unica columna que el navegador
         no sabe que existe. Esa es la huella que lo prueba.

         POR QUE PASA: dos escritores se reparten la misma fila sin ningun
         acuerdo sobre quien manda en cada columna. El navegador arma la
         fila de R4 con las 24 columnas desde su estado local, y ese estado
         puede estar viejo: hidratar() reconstruye DB.pedidos mientras la
         emision va en vuelo.

         POR QUE SE ARREGLA AQUI Y NO EN EL NAVEGADOR: porque el navegador
         vive en cache. Un dispositivo con la version anterior abierta
         seguiria borrando documentos despues de actualizar el Index. El
         servidor es el unico sitio donde esta regla se puede GARANTIZAR.
         Arreglarlo solo en el navegador seria confiar en que todos los
         dispositivos esten al dia, y eso no se puede confiar.

         QUE SE COMPROBO ANTES DE PONERLO (el cruce de informacion):
           · index.html:4555 A.enSave, al registrar la entrega, sube la fila
             de R4 con estas columnas copiadas de su estado local. Con esto
             deja de poder borrar la remision de un pedido al entregarlo:
             era el MISMO defecto esperando en la seccion 6.
           · index.html:11226-11227 mostrador pone p.doc=null y sube la fila
             para «deshacer» cuando la emision falla. Ya no hace falta: si
             apiDocumento devolvio error, el servidor no escribio nada. Y en
             el callback de fallo (11227) la respuesta pudo perderse con el
             documento YA emitido, y entonces ese «deshacer» borraba un
             documento real. Tambien queda cerrado.
           · apiAlegraEmitir y apiAlegraEstado escriben estas columnas
             directamente con escribirFila, no por apiGuardar_: no pasan por
             aqui y no se ven afectadas.
         Ninguna escritura legitima del navegador necesita estas columnas.
         ================================================================= */
      /* -----------------------------------------------------------------
         LA REGLA EXACTA, y es importante que sea esta y no «prohibido»:

            la cola PUEDE poner un documento donde no hay ninguno
            la cola NUNCA puede borrar ni cambiar uno que ya existe

         POR QUE NO SE PROHIBE DEL TODO: porque el camino SIN CONEXION
         necesita poder subir el documento. Si la emision ocurrio en el
         celular sin señal, la cola es la UNICA via por la que ese documento
         llega a la hoja (index.html, rama !ONLINE de A.facEjecutar, y
         CFG_Config.doc_offline = REMISION, que existe justo para eso).
         Una prohibicion total habria hecho que las remisiones emitidas sin
         señal no se guardaran NUNCA. Lo comprobe antes de dejarlo asi: es
         la razon por la que esta regla tiene dos mitades y no una.

         Con las dos mitades, el caso destructivo es imposible -- una fila
         que llega con las columnas en blanco no puede vaciar un documento
         emitido -- y el caso legitimo sigue funcionando.
         ----------------------------------------------------------------- */
      if(d && d.hoja === H.entregas && d.fila){
        var pidEnt_ = txt((d.claves && d.claves[0] && d.claves[0].valor) || d.fila.P_num);
        if(entActuales_ === null) entActuales_ = indicePor_(filas(H.entregas), 'P_num');
        var filaHoy_ = pidEnt_ ? (entActuales_[pidEnt_] || null) : null;
        var yaTieneDoc_ = !!(filaHoy_ && txt(filaHoy_['Doc_tipo']));
        var traeDoc_ = txt(d.fila['Doc_tipo']);
        if(!colaPuedeEscribirDocumento_(traeDoc_, yaTieneDoc_)){
          COLS_DOC_SERVIDOR_.forEach(function(c){ if(d.fila[c] !== undefined) delete d.fila[c]; });
          /* si al quitarlas no queda nada que escribir, la fila entera sobra */
          var algo_ = false, kk_;
          for(kk_ in d.fila){ algo_ = true; break; }
          if(!algo_) continue;
        }
      }
      var r = escribirFila(d);
      if(r.bloqueada) bloqueadas.push(r.id || d.hoja);
      else if(r.escrita) n++;
    }
    return { ok:true, escritas:n, bloqueadas:bloqueadas, rechazadas:rechazadas,
             rechazadas_cierre:rechazadas_cierre };
  } finally { lock.releaseLock(); }
}

function indices(sh){
  var ancho = Math.max(sh.getLastColumn(), 1);
  var cols = sh.getRange(1, 1, 1, ancho).getValues()[0], idx = {};
  for(var c = 0; c < cols.length; c++) idx[txt(cols[c])] = c;
  idx.__ancho = ancho;
  return idx;
}

/* =====================================================================
   v5.3 · RENDIMIENTO · LA CAUSA PRINCIPAL DE LOS 20 SEGUNDOS
   =====================================================================
   LO QUE MEDI: escribirFila() llama a buscarFila() para localizar la fila,
   y buscarFila leia TODAS las filas y TODAS las columnas de la hoja para
   encontrar una. Es decir: UNA LECTURA COMPLETA DE HOJA POR CADA FILA QUE
   SE ESCRIBE. Guardar el expediente de un pedido de 8 referencias son 12
   filas (R3 + 2 de R2_Preparacion + 8 de R2_Detalle + R4), y ademas
   apiGuardar_ releia R3_Pedidos una vez por fila del lote: 24 lecturas
   completas de hoja en una sola operacion.

   LO QUE CAMBIA: primero se busca con createTextFinder, que busca en el
   servidor de Sheets y solo devuelve las coincidencias. El patron ya
   estaba en este archivo, probado, en preparacionResultadoPrevio_ y en la
   idempotencia de mostrador; lo que faltaba era usarlo aqui.

   LO QUE NO CAMBIA, Y ES DELIBERADO: si el buscador NO encuentra nada, se
   lee la hoja igual que antes antes de dar el «no existe». Esto no es
   desconfianza decorativa: createTextFinder compara la celda tal como se
   ve, sin recortar espacios, mientras que la comparacion de siempre usa
   low(), que si recorta. Un «P-001 » con un espacio al final no lo
   encontraria el buscador, y un falso «no existe» haria que escribirFila
   AGREGUE UNA FILA DUPLICADA en vez de actualizar la que ya hay. Eso seria
   perder trazabilidad por ganar medio segundo.

   RESULTADO: el caso frecuente -- actualizar una fila que ya existe -- pasa
   de una lectura completa a una busqueda indexada. El caso de fila nueva
   cuesta lo mismo que antes. Ninguna ruta devuelve algo distinto de lo que
   devolvia: el contrato sigue siendo «numero de fila real o null».
   ===================================================================== */
function buscarFila(sh, idx, claves){
  var ultima = sh.getLastRow();
  if(!claves.length || ultima < 2) return null;
  var r = buscarFilaIndexada_(sh, idx, claves, ultima);
  if(r) return r;
  return buscarFilaLeyendo_(sh, idx, claves, ultima);
}

/** Busca del lado de Sheets por la primera clave y confirma las demas. */
function buscarFilaIndexada_(sh, idx, claves, ultima){
  var ci0 = idx[claves[0].columna];
  if(ci0 === undefined) return null;
  var v0 = txt(claves[0].valor);
  if(!v0) return null;
  var hall;
  try{
    hall = sh.getRange(2, ci0 + 1, ultima - 1, 1)
             .createTextFinder(v0).matchEntireCell(true).findAll();
  }catch(e){ return null; }
  if(!hall || !hall.length) return null;
  if(claves.length === 1) return hall[0].getRow();

  /* con mas de una clave hay varias candidatas (las lineas del mismo
     pedido). Se leen de una sola vez, en el tramo que las contiene. */
  var min = hall[0].getRow(), max = min, i;
  for(i = 1; i < hall.length; i++){
    var f = hall[i].getRow();
    if(f < min) min = f;
    if(f > max) max = f;
  }
  var bloque = sh.getRange(min, 1, max - min + 1, idx.__ancho).getValues();
  for(i = 0; i < hall.length; i++){
    var fila = hall[i].getRow(), ok = true;
    for(var k = 1; k < claves.length; k++){
      var ci = idx[claves[k].columna];
      if(ci === undefined || low(bloque[fila - min][ci]) !== low(claves[k].valor)){ ok = false; break; }
    }
    if(ok) return fila;
  }
  return null;
}

/** El recorrido de siempre. Es la red de seguridad, no el camino normal. */
function buscarFilaLeyendo_(sh, idx, claves, ultima){
  ultima = ultima || sh.getLastRow();
  if(ultima < 2) return null;
  var bloque = sh.getRange(2, 1, ultima - 1, idx.__ancho).getValues();
  for(var r = 0; r < bloque.length; r++){
    var ok = true;
    for(var k = 0; k < claves.length; k++){
      var ci = idx[claves[k].columna];
      if(ci === undefined || low(bloque[r][ci]) !== low(claves[k].valor)){ ok = false; break; }
    }
    if(ok) return r + 2;
  }
  return null;
}

/**
 * Escribe una fila. Devuelve {escrita, fila, nueva, bloqueada}. NUNCA toca una fila ANULADA.
 *
 * v5.0 · RENDIMIENTO. Antes esta funcion escribia celda por celda: una fila de
 * R4 con 24 columnas eran 24 llamadas a la hoja, y cada llamada cruza la red.
 * Guardar un pedido completo (R3 + 2 de R2 + R4 + sus lineas) podia pasar del
 * medio minuto.
 *
 * Ahora agrupa las celdas tocadas en TRAMOS CONTIGUOS y escribe cada tramo con
 * un solo setValues(). El resultado es identico celda por celda -- lo que no se
 * toca sigue sin tocarse, que es lo que protege cualquier formula que el usuario
 * haya puesto en la hoja -- pero en 1 o 2 llamadas en vez de 24.
 */
function escribirFila(d){
  var sh = hoja(d.hoja), idx = indices(sh);
  var claves = d.claves || (d.clave ? [d.clave] : []);
  var fila = buscarFila(sh, idx, claves);
  var nueva = (fila === null);
  if(nueva) fila = Math.max(sh.getLastRow() + 1, 2);
  var ancho = idx.__ancho;

  /* UNA sola lectura de la fila completa, en vez de una por celda consultada */
  var actual = [];
  if(nueva){ for(var z = 0; z < ancho; z++) actual.push(''); }
  else actual = sh.getRange(fila, 1, 1, ancho).getValues()[0];

  /* CANDADO: una fila anulada es inmodificable, venga de donde venga */
  if(!nueva && idx[COL_EST] !== undefined
     && txt(actual[idx[COL_EST]]).toUpperCase() === E_ANU)
    return { escrita:false, bloqueada:true, fila:fila, id:(claves[0] ? claves[0].valor : '') };

  var marca = {}, escrito = false;
  function poner(cc, v){
    if(cc === undefined) return;                   /* columna que no existe: se ignora, no se rompe */
    actual[cc] = v; marca[cc] = 1; escrito = true;
  }
  for(var nombre in d.fila) poner(idx[nombre], d.fila[nombre]);
  if(!escrito) return { escrita:false, fila:fila };

  /* =====================================================================
     v5.5 · BUG_010 · UNA FILA NUEVA SIN SU CLAVE ES UNA FILA INVISIBLE
     =====================================================================
     Esta funcion escribia UNICAMENTE lo que viniera en d.fila. Las columnas
     CLAVE -- las de `claves`, por las que se busca la fila -- no se
     escribian nunca. Mientras el llamador repitiera la clave dentro de
     d.fila no pasaba nada, y casi todos lo hacen. apiDocumento_ NO lo
     hacia: su filaDoc no llevaba P_num.
     CONSECUENCIA si buscarFila no encuentra la fila: se agrega una fila en
     lastRow+1 con el documento escrito y SIN P_num. Y filas() descarta toda
     fila cuya primera columna este vacia, asi que esa fila es invisible
     para el consecutivo de remision, para docDePedido_ y para las dos
     clasificaciones de seccion. Un documento emitido que nadie puede ver.
     En el libro de hoy no hay ninguna fila asi -- lo comprobe con
     heralsaDiagnosticarDocumento, que conto 0 invisibles -- pero el agujero
     estaba abierto para cualquier llamador, presente o futuro.
     SOLO en filas nuevas: en una fila que ya existe la clave ya coincide
     (por eso se encontro), y reescribirla seria tocar una celda sin motivo.
     ===================================================================== */
  if(nueva) for(var ck = 0; ck < claves.length; ck++)
    if(d.fila[claves[ck].columna] === undefined) poner(idx[claves[ck].columna], claves[ck].valor);

  if(idx['Registrado_en'] !== undefined && d.fila['Registrado_en'] === undefined
     && !d.noSello && (!d.selloSoloNueva || nueva)) poner(idx['Registrado_en'], ahora());
  if(idx[COL_EST] !== undefined && !txt(actual[idx[COL_EST]])) poner(idx[COL_EST], E_VIG);

  /* escribe por tramos contiguos: solo lo tocado, en el menor numero de llamadas */
  var cols = [];
  for(var c = 0; c < ancho; c++) if(marca[c]) cols.push(c);

  /* =====================================================================
     v5.4 · BUG_004 · ESCRITURA ATOMICA PARA LA CABECERA DEL PEDIDO
     =====================================================================
     POR QUE HACE FALTA, medido: en R3_Pedidos la columna Estado es la 15 y
     Etapa_preparacion la 26, con Registrado_en, Finalizado_en y Revision en
     medio. La escritura por tramos contiguos las parte en CINCO llamadas
     setValues separadas. Si la ejecucion se corta entre dos de ellas --
     tiempo de espera de Apps Script, cuota, el candado liberado en el
     finally -- la cabecera queda con Estado de un cierre y Etapa del paso
     anterior. Eso es EXACTAMENTE lo que atasco a P-020: la tarjeta lo
     contaba en Finalizar, su lista no lo encontraba y el servidor rechazaba
     toda accion.

     Con atomico:true se escribe UN solo setValues desde la primera columna
     tocada hasta la ultima. Las celdas intermedias se reescriben con el
     valor que ya tenian (se leyeron en `actual` tres lineas arriba), asi
     que el resultado es identico celda por celda.

     POR QUE NO SE PONE ATOMICO EN TODAS LAS HOJAS: reescribir una celda
     intermedia con su propio valor convierte una formula en su resultado.
     Las hojas de registro las escribe solo la app, pero el usuario puede
     haber puesto una formula en cualquier otra. Asi que esto se activa
     unicamente donde la atomicidad del par importa: la cabecera de
     R3_Pedidos. Una optimizacion que pueda destruir una formula del usuario
     no se aplica «por si acaso»: se aplica donde se necesita y se dice.
     ===================================================================== */
  if(d.atomico && cols.length > 1){
    var cA = cols[0], cZ = cols[cols.length - 1];
    sh.getRange(fila, cA + 1, 1, cZ - cA + 1).setValues([actual.slice(cA, cZ + 1)]);
    return { escrita:true, fila:fila, nueva:nueva, atomica:true };
  }

  var i = 0;
  while(i < cols.length){
    var j = i;
    while(j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
    sh.getRange(fila, cols[i] + 1, 1, cols[j] - cols[i] + 1)
      .setValues([actual.slice(cols[i], cols[j] + 1)]);
    i = j + 1;
  }
  return { escrita:true, fila:fila, nueva:nueva };
}

/* ===================== ANULAR / REACTIVAR ===================== */
function apiAnular_(tipo, id, motivo, operador){
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{ return marcar(tipo, id, E_ANU, motivo, operador); }
  finally{ lock.releaseLock(); }
}
function apiReactivar_(tipo, id, operador){
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{ return marcar(tipo, id, '', '', operador); }
  finally{ lock.releaseLock(); }
}

/**
 * estado = ANULADO marca todo el expediente. estado = '' reactiva y RECONSTRUYE
 * el estado natural de cada fila por lo que tiene escrito, para no dejar basura.
 */
/* =====================================================================
   v5.1 · D-27 · LA ANULACION TIENE QUE ALCANZAR EL KARDEX Y LA CAJA
   =====================================================================
   Esta funcion comparaba la PRIMERA columna de cada hoja. En R1..R4 la
   primera columna es el numero del documento, asi que funcionaba. En
   MOV_Inventario la primera columna es Mov_num, en MOV_Caja es Caja_num, y
   la referencia al documento vive en Origen_doc. Por eso las dos quedaban
   fuera del recorrido y no se anulaban nunca.

   CONSECUENCIA DE DEJARLAS FUERA: al anular un pedido, su salida de bodega
   seguia descontando. El saldo quedaba bajo por una venta que ya no existe
   y el kardex dejaba de explicar el inventario.

   CRITERIO QUE SE APLICA: se anula TODO lo que el documento genero,
   incluida la ENTRADA_FABRICACION. Si fisicamente se fabricaron unidades y
   siguen en bodega, su razon de existir ya no es una venta anulada: entran
   con un AJUSTE_CONTEO, que es la forma honesta de decir "estas unidades
   estan aqui porque las contamos". Dejar la entrada colgada de un pedido
   anulado seria un saldo sin explicacion. Y es reversible: apiReactivar_
   pasa estado='' y estadoNatural las devuelve a VIGENTE.
   ===================================================================== */
function marcar(tipo, id, estado, motivo, operador){
  var porColumna0  = tipo === 'C' ? [H.compras, H.detalle]
                                  : [H.pedidos, H.prep, H.prepDet, H.entregas];
  var porOrigenDoc = [H.mov, 'MOV_Caja'];   /* aqui la referencia vive en Origen_doc */
  var tocadas = 0, detalle = {};

  function marcaHoja(nombreHoja, campoRef){
    var sh = libro().getSheetByName(nombreHoja);
    if(!sh || sh.getLastRow() < 2) return;
    var idx = indices(sh);
    if(idx[COL_EST] === undefined) return;
    var col = campoRef === null ? 0 : idx[campoRef];
    if(col === undefined) return;            /* la hoja no tiene esa columna: se salta */
    var bloque = sh.getRange(2, 1, sh.getLastRow() - 1, idx.__ancho).getValues();
    var n = 0;
    for(var r = 0; r < bloque.length; r++){
      if(txt(bloque[r][col]) !== txt(id)) continue;
      var est = estado || estadoNatural(nombreHoja, idx, bloque[r]);
      sh.getRange(r + 2, idx[COL_EST] + 1).setValue(est);
      if(idx[COL_MOT] !== undefined) sh.getRange(r + 2, idx[COL_MOT] + 1).setValue(estado === E_ANU ? (motivo || '') : '');
      if(idx[COL_POR] !== undefined) sh.getRange(r + 2, idx[COL_POR] + 1).setValue(estado === E_ANU ? (operador || '') : '');
      if(idx[COL_CUA] !== undefined) sh.getRange(r + 2, idx[COL_CUA] + 1).setValue(estado === E_ANU ? ahora() : '');
      n++; tocadas++;
    }
    if(n) detalle[nombreHoja] = n;
  }

  porColumna0.forEach(function(h){ marcaHoja(h, null); });
  porOrigenDoc.forEach(function(h){ marcaHoja(h, 'Origen_doc'); });

  return { ok:true, filas:tocadas, por_hoja:detalle, estado:estado || 'RECONSTRUIDO' };
}

/** Que estado le corresponde a una fila por lo que TIENE escrito. */
function estadoNatural(nombreHoja, idx, fila){
  function val(c){ var i = idx[c]; return i === undefined ? '' : txt(fila[i]); }
  if(nombreHoja === H.prep)     return (val('tc') || val('tl') || val('Surtido_inventario')) ? E_VIG : E_PEND;
  if(nombreHoja === H.entregas) return val('te') ? E_VIG : E_PEND;
  if(nombreHoja === H.prepDet)  return val('Referencia') ? E_VIG : E_PEND;
  /* v5.1 · D-27 · un movimiento de kardex o de caja no tiene estados
     intermedios: o paso, o se anulo. Al reactivar vuelve a VIGENTE, nunca a
     PENDIENTE, porque un movimiento pendiente no significa nada. */
  if(nombreHoja === H.mov || nombreHoja === 'MOV_Caja') return E_VIG;
  return E_VIG;
}


/* ===================== PREPARACION EN SEIS SECCIONES =====================
   Organizar -> Despachar -> Finalizar, sin cambiar el expediente nativo.
   El borrador vive en R3 + las dos R2 + R4 + R2_Detalle. No hay hojas espejo.
   Revision es un control de concurrencia: una sesion atrasada no pisa otra. */
function preparacionProductos_(){
  var out = {};
  filas(H.productos).forEach(function(r){
    if(txt(r.Estado_registro).toUpperCase() === E_ANU) return;
    out[low(r.Codigo)] = r;
  });
  return out;
}
function preparacionLineas_(pid){
  return filas(H.prepDet).filter(function(r){
    return txt(r.P_num) === txt(pid) && txt(r.Estado_registro).toUpperCase() !== E_ANU;
  });
}
function preparacionTipoParte_(linea){
  var t = txt(linea.tipo || linea.Tipo_trabajo).toUpperCase();
  if(['F','R','M'].indexOf(t) < 0) throw new Error('Clasifica el producto como F, R o M antes de agregarlo.');
  if(t === 'M'){
    var o = txt(linea.origenM || linea.Origen_M).toUpperCase();
    if(o === 'COMPRA') o = 'R';
    if(o === 'FABRICA') o = 'F';
    if(o !== 'F' && o !== 'R') throw new Error('El producto M necesita origen F o R para este pedido.');
    return { catalogo:t, parte:o, origen:o };
  }
  return { catalogo:t, parte:t, origen:'' };
}
function preparacionConfig_(clave){
  var r = buscarEn(filas(H.cfg), 'Clave', clave);
  return r ? txt(r.Valor) : '';
}
function preparacionHoras_(a,b){
  if(!txt(a)||!txt(b))return '';
  var d1=new Date(txt(a).replace(' ','T')+':00'),d2=new Date(txt(b).replace(' ','T')+':00');
  var h=(d2.getTime()-d1.getTime())/3600000;return isFinite(h)?h:'';
}
function preparacionPartes_(pid, lineas){
  var tipos = {},cab=buscarEn(filas(H.pedidos),'P_num',pid)||{};
  var congelar=txt(cab.Etapa_preparacion).toUpperCase()==='FINALIZAR'||txt(cab.Etapa_preparacion).toUpperCase()==='LISTO';
  var anteriores=filas(H.prep).filter(function(r){return txt(r.P_num)===pid;});
  lineas.forEach(function(l){ if(txt(l.Estado_registro).toUpperCase() !== E_ANU) tipos[txt(l.Tipo).toUpperCase()] = true; });
  var marca = ahora(), out = [];
  ['F','R'].forEach(function(t){
    var lin=lineas.filter(function(l){return txt(l.Tipo).toUpperCase()===t&&txt(l.Estado_registro).toUpperCase()!==E_ANU;});
    var antes=anteriores.filter(function(r){return txt(r.Tipo).toUpperCase()===t;})[0]||{};
    var f={P_num:pid,Tipo:t,Estado_registro:lin.length?E_VIG:E_NA};
    if(lin.length){
      f.Organizado_en=txt(antes.Organizado_en)||marca;
      var completas=lin.every(function(l){return txt(l.Como_se_suple).toUpperCase()==='INVENTARIO'&&numero(l.Cant_despachada)===numero(l.Cant_solicitada);});
      if(lin.every(function(l){return txt(l.Estado_validacion).toUpperCase()==='VALIDADA';})){
        f.Surtido_inventario=congelar&&txt(antes.Surtido_inventario)?txt(antes.Surtido_inventario):(completas?'S':'N');
        var pend=lin.filter(function(l){return txt(l.Como_se_suple).toUpperCase()!=='INVENTARIO';});
        if(t==='F'&&pend.length){
          f.Hay_MP=pend.some(function(l){return txt(l.Como_se_suple).toUpperCase()==='ESPERA_MP';})?'N':'S';
          var mp=[];pend.forEach(function(l){partirLista(l.Materias_faltantes).forEach(function(m){if(mp.indexOf(m)<0)mp.push(m);});});
          f.Materia_prima_faltante=mp.join(' - ');
        }
      }
    }
    out.push({hoja:H.prep,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:t}],fila:f});
  });
  return out;
}
function preparacionGuardarLinea_(pid, entrada, actual, productos, canal, etapa){
  var cod = txt(entrada.cod || entrada.Referencia).toUpperCase();
  var prod = productos[low(cod)];
  if(!prod) throw new Error(cod + ': no existe o esta inhabilitado en CAT_Productos.');
  var n = numero(entrada.n !== undefined ? entrada.n : entrada.Cant_solicitada);
  if(!(n > 0) || Math.floor(n) !== n) throw new Error(cod + ': la cantidad solicitada debe ser un entero mayor que cero.');
  var tp = preparacionTipoParte_({tipo:entrada.tipo || prod.Tipo_trabajo,origenM:entrada.origenM || entrada.Origen_M || (actual && actual.Origen_M)});
  var cambio = !!actual && (numero(actual.Cant_solicitada) !== n || txt(actual.Tipo).toUpperCase() !== tp.parte || txt(actual.Origen_M).toUpperCase() !== tp.origen);
  var precio = actual && txt(actual.Precio_unitario) !== '' ? numero(actual.Precio_unitario) : numero(canal === 'R' ? prod.Precio_minorista : prod.Precio_mayorista);
  if(!(precio >= 0)) throw new Error(cod + ': precio invalido.');
  var origen=actual?txt(actual.Origen)||'ORGANIZAR':(etapa||'ORGANIZAR');
  if(actual&&cambio&&etapa==='FINALIZAR')origen='FINALIZAR';
  var f={P_num:pid,Tipo:tp.parte,Referencia:txt(prod.Codigo),Codigo:txt(prod.Codigo),Descripcion:txt(prod.Descripcion),
    Cant_solicitada:n,Precio_unitario:precio,
    Descuento_pct:Math.max(0,Math.min(100,numero(entrada.dpct!==undefined?entrada.dpct:(actual&&actual.Descuento_pct)||0))),
    IVA_pct:numero(prod.IVA),Costo_unitario:numero(prod.Costo),Origen_M:tp.origen,Origen:origen,Estado_registro:E_VIG};
  if(actual){
    f.Cant_despachada=actual.Cant_despachada;f.Como_se_suple=actual.Como_se_suple;f.Se_suplio=actual.Se_suplio;
    f.Estado_validacion=cambio?'PENDIENTE':txt(actual.Estado_validacion)||'PENDIENTE';
    f.Validado_en=cambio?'':actual.Validado_en;f.Validado_por=cambio?'':actual.Validado_por;
    f.Motivo_novedad=actual.Motivo_novedad;f.Materias_faltantes=cambio?'':actual.Materias_faltantes;
    if(cambio){f.Cant_despachada='';f.Como_se_suple='';f.Se_suplio='';if(etapa==='FINALIZAR')f.Motivo_novedad='Modificado en Finalizar por solicitud del cliente';}
  }else{
    f.Cant_despachada='';f.Como_se_suple='';f.Se_suplio='';f.Estado_validacion='PENDIENTE';
    f.Motivo_novedad=etapa==='FINALIZAR'?'Agregado en Finalizar por solicitud del cliente':'Agregado en preparacion';
  }
  if(actual&&txt(actual.Estado_registro).toUpperCase()===E_ANU){
    var sh=hoja(H.prepDet),ix=indices(sh);sh.getRange(actual.__fila,ix[COL_EST]+1).setValue(E_VIG);
    if(ix[COL_MOT]!==undefined)sh.getRange(actual.__fila,ix[COL_MOT]+1).setValue('');
  }
  if(actual&&txt(actual.Tipo).toUpperCase()!==tp.parte){
    escribirFila({hoja:H.prepDet,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:actual.Tipo},{columna:'Referencia',valor:actual.Referencia}],fila:{Estado_registro:E_ANU,Motivo_anulacion:'Cambio de parte durante preparacion'}});
    f.Estado_validacion='PENDIENTE';f.Cant_despachada='';f.Como_se_suple='';
  }
  escribirFila({hoja:H.prepDet,selloSoloNueva:true,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:tp.parte},{columna:'Referencia',valor:txt(prod.Codigo)}],fila:f});
  return f;
}
/* Una acción repetida conserva su identificador en la cola del dispositivo.
   El comprobante queda en LOG_Cambios (tabla nativa): si Apps Script escribió
   pero la respuesta se perdió, el reintento devuelve el mismo resultado y no
   vuelve a aplicar tiempos, cantidades ni revisiones. No crea hojas ni columnas. */
function preparacionResultadoPrevio_(pid, solicitud){
  if(!solicitud)return null;
  var registro=pid+' / '+solicitud;
  /* =====================================================================
     v5.1 · C3 · BUSCAR DEL LADO DE SHEETS, NO TRAER LA HOJA ENTERA
     =====================================================================
     Esto leia LOG_Cambios COMPLETA en cada accion de preparacion, y el log
     crece una fila por interaccion: un solo pedido genero 12 revisiones en
     6 minutos. A los pocos miles de filas, cada toque en la pantalla de
     preparacion arrastraba el log entero.
     createTextFinder busca en el servidor de Sheets y solo devuelve las
     coincidencias. Cubre TODO el historico, no una ventana de las ultimas
     N filas: si se recortara la busqueda, un reintento viejo no encontraria
     su comprobante y volveria a escribir, que es precisamente lo que la
     idempotencia existe para evitar.
     matchEntireCell(true) porque el registro es la celda completa.
     ===================================================================== */
  var sh=libro().getSheetByName(H.log);
  if(!sh||sh.getLastRow()<2)return null;
  var ix=indices(sh);
  if(ix.Registro===undefined||ix.Campo===undefined||ix.Valor_despues===undefined)return null;
  var hallados=sh.getRange(2,ix.Registro+1,sh.getLastRow()-1,1)
                 .createTextFinder(registro).matchEntireCell(true).findAll();
  if(!hallados||!hallados.length)return null;
  for(var i=0;i<hallados.length;i++){
    var f=hallados[i].getRow();
    if(txt(sh.getRange(f,ix.Campo+1).getValue())!=='Preparacion_solicitud')continue;
    try{
      var resultado=JSON.parse(txt(sh.getRange(f,ix.Valor_despues+1).getValue()));
      resultado.idempotente=true;
      return resultado;
    }catch(e){throw new Error('El comprobante de la acción '+solicitud+' está dañado; no se repitió la escritura.');}
  }
  return null;
}
function preparacionGuardarComprobante_(pid,solicitud,accion,resultado,operador){
  if(!solicitud)return;
  asegurarHoja(H.log);
  var n=nuevoConsecutivo(H.log,'L',4);
  anexarBloque(H.log,HOJAS_F2['LOG_Cambios'],[{Log_num:n,Fecha:ahora(),Tabla:H.pedidos,
    Registro:pid+' / '+solicitud,Campo:'Preparacion_solicitud',Valor_antes:'',Valor_despues:JSON.stringify(resultado),
    Operador:operador,Motivo:'Comprobante de '+accion+'; permite reintentar sin duplicar'}]);
}
function apiPreparacion_(pid, accion, datos, operador){
  pid = txt(pid); accion = txt(accion).toUpperCase(); datos = datos || {};
  var solicitud=txt(datos.solicitud).substr(0,120);
  var lock = LockService.getScriptLock(); lock.waitLock(30000);
  try{
    var cab = buscarEn(filas(H.pedidos), 'P_num', pid);
    if(!cab) throw new Error('El pedido ' + pid + ' no existe.');
    var previo=preparacionResultadoPrevio_(pid,solicitud);
    if(previo)return previo;
    if(txt(cab.Estado_registro).toUpperCase() === E_ANU) throw new Error(pid + ' esta anulado.');

    /* =====================================================================
       v5.4 · BUG_004 · PRIMERO SE SANA LA CABECERA, DESPUES SE TRABAJA
       =====================================================================
       Si Estado y Etapa_preparacion se contradicen, se corrigen AQUI, con
       los hechos como juez, y queda el rastro en LOG_Cambios. Asi un pedido
       que quedo atascado por una escritura cortada se desatasca solo en
       cuanto alguien lo toca, sin tener que editar la hoja a mano y sin que
       el operador tenga que entender nada.
       Es idempotente: si el par ya es coherente no escribe nada.
       ===================================================================== */
    var norm = normalizarCabecera_(pid, cab, operador, 'Saneado al ' + accion);
    if(norm.cambio) cab = norm.cab;

    var etapa = etapaDeCabecera_(cab);
    var revision = numero(cab.Revision) || 1;
    var estadoCab = txt(cab.Estado).toUpperCase();

    /* el atajo idempotente del cierre exige que las DOS columnas digan
       cerrado. Antes miraba solo Estado y devolvia «ok» sin escribir la
       etapa: el reintento confirmaba el cierre al dispositivo y dejaba la
       hoja a medias, que es como se perpetuaba el atasco. */
    if(accion === 'CERRAR' && estadoCab === 'LISTO' && etapa === 'LISTO')
      return {ok:true, id:pid, etapa:'LISTO', revision:revision, idempotente:true};

    /* QUIEN PUEDE TRABAJARSE: el pedido tiene que estar en una de las tres
       secciones de preparacion (2 Organizar, 3 Despachar, 4 Finalizar), y la
       seccion la decide la MISMA cascada que usa la pantalla. Antes esto se
       decidia con dos condiciones propias que no coincidian con el carril. */
    var sec = seccionDePedido_(cab, docDePedido_(pid));
    if(sec === 0) throw new Error(pid + ' esta inhabilitado.');
    if([2,3,4].indexOf(sec) < 0)
      throw new Error(pid + ' ya esta cerrado: esta en ' + nombreSeccion_(sec) +
        '. La preparacion no se puede modificar, pero ' +
        (sec === 5 ? 'si se puede facturar.' : sec === 6 ? 'si se puede registrar la entrega.' : 'el pedido ya se entrego.'));
    if(numero(datos.revision) !== revision)
      throw new Error('CONFLICTO_REVISION: otro dispositivo cambio ' + pid + '. Actualiza antes de continuar; no se sobrescribio su trabajo.');
    var actualesTodas = filas(H.prepDet).filter(function(r){return txt(r.P_num) === pid;});
    var actuales = actualesTodas.filter(function(r){return txt(r.Estado_registro).toUpperCase() !== E_ANU;});
    var productos = preparacionProductos_(), canal = txt(cab.Canal).toUpperCase() === 'R' ? 'R' : 'M';
    var marca = ahora(), nuevaEtapa = etapa;
    /* v5.5.7 · BUG_034 · canal para las discrepancias que NO bloquean */
    var avisosPrep_ = [];

    if(accion === 'GUARDAR'){
      if(!Array.isArray(datos.lineas)) throw new Error('La lista de productos no es valida.');
      var vistos = {};
      datos.lineas.forEach(function(l){
        var cod = txt(l.cod || l.Referencia).toUpperCase();
        if(vistos[low(cod)]) throw new Error(cod + ' esta repetido en el pedido.');
        vistos[low(cod)] = true;
        var actual = actualesTodas.filter(function(r){return low(r.Referencia) === low(cod);})[0];
        preparacionGuardarLinea_(pid, l, actual, productos, canal, etapa);
      });
      actuales.forEach(function(r){
        if(!vistos[low(r.Referencia)]) escribirFila({hoja:H.prepDet,
          claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:r.Tipo},{columna:'Referencia',valor:r.Referencia}],
          fila:{Estado_registro:E_ANU,Motivo_anulacion:'Retirado durante preparacion por ' + operador,Anulado_por:operador,Anulado_en:marca}});
      });
    }else if(accion === 'DESPACHAR'){
      if(etapa !== 'ORGANIZAR') throw new Error('Este pedido ya salio de Organizar.');
      if(!actuales.length) throw new Error('Agrega al menos un producto antes de despachar.');
      nuevaEtapa = 'DESPACHAR';
      escribirFila({hoja:H.pedidos,claves:[{columna:'P_num',valor:pid}],fila:{P_num:pid,Estado:'EN_PREPARACION'}});
    }else if(accion === 'INICIAR'){
      if(etapa !== 'DESPACHAR') throw new Error('El inicio de despacho se hace desde Despachar.');
      if(txt(cab.tc)) throw new Error('El despacho ya fue iniciado; no se reinicia el tiempo.');
      escribirFila({hoja:H.pedidos,claves:[{columna:'P_num',valor:pid}],fila:{P_num:pid,tc:marca,Despacho_iniciado_en:marca}});
      ['F','R'].forEach(function(t){
        escribirFila({hoja:H.prep,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:t}],fila:{P_num:pid,Tipo:t,tc:marca,Estado_registro:actuales.some(function(l){return txt(l.Tipo).toUpperCase()===t;})?E_VIG:E_NA}});
      });
    }else if(accion === 'VALIDAR'){
      if(['DESPACHAR','FINALIZAR'].indexOf(etapa) < 0) throw new Error('Primero envia el pedido de Organizar a Despachar.');
      if(!txt(cab.tc)) throw new Error('Primero pulsa INICIAR DESPACHO para tomar el tiempo inicial.');
      var l = datos.linea || {}, codV = txt(l.cod || l.Referencia).toUpperCase();
      var actualV = actuales.filter(function(r){return low(r.Referencia) === low(codV);})[0];
      if(!actualV) throw new Error(codV + ': primero guarda la cantidad solicitada en Organizar o en Agregar producto.');
      var nV = numero(actualV.Cant_solicitada), wV = numero(l.w);
      if(txt(l.w) === '' || wV < 0 || wV > nV || Math.floor(wV) !== wV) throw new Error(codV + ': despachadas debe estar entre 0 y ' + nV + '.');
      /* =================================================================
         v5.5.7 · BUG_034 · EL CODIGO HACIA LO CONTRARIO DE SU PROPIA REGLA
         =================================================================
         AQUI HABIA UN throw: si el saldo no alcanzaba, el despacho se
         caia. Y el invariante I-19 de este mismo sistema, escrito en tres
         sitios del Index, dice literalmente lo contrario:

           «nunca se bloquea una venta por falta de stock. Se registra la
            discrepancia y el producto queda marcado como no confiable.
            Un sistema de inventario no debe tener autoridad para cancelar
            una venta: el saldo probablemente este mal, y el dato malo se
            corrige, la venta no se pierde. LA APP ANTERIOR DE LA EMPRESA
            HACIA LO CONTRARIO Y POR ESO UNA VENTA REAL SE CAIA POR CULPA
            DE UN INVENTARIO DESACTUALIZADO.»

         Es decir: el defecto que la regla nombra como el motivo de haber
         cambiado de aplicacion estaba otra vez dentro del codigo. Y la
         opcion que deberia gobernarlo, permitir_venta_sin_stock, estaba
         DECLARADA Y VALIDADA PERO NUNCA LEIDA: configuracion muerta que la
         pantalla le mostraba al operador como si decidiera algo. La app
         decia «si se permite vender sin stock» y el servidor lo prohibia.

         AHORA la discrepancia se REGISTRA y no bloquea:
           · se devuelve como aviso al operador, en el momento
           · queda en LOG_Cambios, que es el registro permanente que pide
             el invariante
           · apiMover_ ya devuelve los codigos que quedan en negativo y la
             app ya los muestra: la cadena de abajo existia, lo unico que
             habia era esta puerta cerrada antes de llegar a ella.

         LO QUE NO HAGO Y DIGO POR QUE: «marcar el producto como no
         confiable» necesita una columna propia. Reutilizar
         Requiere_revision seria mezclarlo con la revision de CALIDAD, que
         es otra cosa y vive al lado de Observacion_calidad. Inventar un
         significado nuevo para una columna existente es como se crean las
         incoherencias que llevamos semanas sacando. Queda pendiente de
         decidir donde vive esa marca.
         ================================================================= */
      if(preparacionConfig_('inventario_modo') === 'SHEETS'){
        var saldoInfo = apiSaldos_();
        var saldo = numero(saldoInfo.saldos[codV]);
        if(wV > Math.max(saldo,0)){
          var falta_ = wV - Math.max(saldo,0);
          avisosPrep_.push(codV + ': el inventario dice ' + saldo + ' y se despacharon ' + wV +
            ' (' + falta_ + ' mas de lo que hay). No se bloqueo la venta: el saldo probablemente este mal. ' +
            'Revise el inventario de ' + codV + '.');
          apiLogCambio_([{ Tabla:'MOV_Inventario', Registro:codV, Campo:'Saldo_vs_despacho',
            Valor_antes:'saldo ' + saldo, Valor_despues:'despachadas ' + wV + ' en ' + pid,
            Motivo:'I-19 · discrepancia de inventario registrada, la venta NO se bloqueo' }], operador);
        }
      }
      var parteV = txt(actualV.Tipo).toUpperCase();
      var origenAnterior=txt(actualV.Como_se_suple).toUpperCase();
      var comoV=etapa==='FINALIZAR'&&origenAnterior?origenAnterior:(wV===nV&&wV>0?'INVENTARIO':parteV==='R'?'PEDIR_PRODUCTO':l.hayMP===false?'ESPERA_MP':'FABRICAR');
      if(comoV === 'ESPERA_MP' && !partirLista(l.mpFalta).length) throw new Error(codV + ': indica que materia prima falta.');
      var tpV = preparacionTipoParte_({tipo:l.tipo || productos[low(codV)].Tipo_trabajo,origenM:l.origenM || actualV.Origen_M});
      if(tpV.parte !== parteV) throw new Error(codV + ': cambio de parte; guarda la linea de nuevo antes de validar.');
      escribirFila({hoja:H.prepDet,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:parteV},{columna:'Referencia',valor:actualV.Referencia}],
        fila:{P_num:pid,Tipo:parteV,Referencia:actualV.Referencia,Cant_despachada:wV,Como_se_suple:comoV,
          Materias_faltantes:comoV === 'ESPERA_MP' ? partirLista(l.mpFalta).join(' - ') : '',
          Estado_validacion:'VALIDADA',Validado_en:marca,Validado_por:operador,
          Se_suplio:etapa==='FINALIZAR'&&comoV!=='INVENTARIO'?(wV>=nV?'S':'N'):''}});
    }else if(accion === 'FINALIZAR'){
      if(etapa !== 'DESPACHAR') throw new Error('El pedido no esta en Despachar.');
      if(!actuales.length || actuales.some(function(r){return txt(r.Estado_validacion).toUpperCase() !== 'VALIDADA';}))
        throw new Error('No puedes pasar a Finalizar: hay lineas pendientes de validar.');
      nuevaEtapa = 'FINALIZAR';
      ['F','R'].forEach(function(t){if(actuales.some(function(l){return txt(l.Tipo).toUpperCase() === t;}))
        escribirFila({hoja:H.prep,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:t}],fila:{P_num:pid,Tipo:t,td:marca}});});
    }else if(accion === 'ESPERAR'){
      if(etapa !== 'DESPACHAR') throw new Error('Esperar se decide en Despachar; en Finalizar el pedido se cierra.');
      if(!actuales.length || actuales.some(function(r){return txt(r.Estado_validacion).toUpperCase() !== 'VALIDADA';}))
        throw new Error('No puedes decidir esperar: hay lineas pendientes de validar.');
      nuevaEtapa = 'FINALIZAR';
      ['F','R'].forEach(function(t){if(actuales.some(function(l){return txt(l.Tipo).toUpperCase() === t;}))
        escribirFila({hoja:H.prep,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:t}],fila:{P_num:pid,Tipo:t,td:marca}});});
    }else if(accion === 'CERRAR'){
      if(etapa !== 'FINALIZAR') throw new Error('El cierre se hace desde Finalizar.');
      if(!actuales.length || actuales.some(function(r){return txt(r.Estado_validacion).toUpperCase() !== 'VALIDADA';}))
        throw new Error('No se puede cerrar: una linea nueva o modificada esta pendiente de validacion.');
      var salida = txt(datos.salida).toUpperCase();
      var repro=datos.reprocesos;
      if(!repro||typeof repro!=='object')throw new Error('Indica si hubo reproceso en cada parte F/R antes de finalizar.');
      ['F','R'].forEach(function(t){
        if(!actuales.some(function(r){return txt(r.Tipo).toUpperCase()===t;}))return;
        var q=repro[t];if(!q||typeof q.reproceso!=='boolean')throw new Error('Indica si hubo reproceso en la parte '+t+'.');
        if(q.reproceso&&!txt(q.defecto))throw new Error('Indica el tipo de defecto de la parte '+t+'.');
      });
      var faltas = actuales.filter(function(r){return numero(r.Cant_despachada) < numero(r.Cant_solicitada);});
      var totalW = actuales.reduce(function(sum,r){return sum + numero(r.Cant_despachada);},0);
      if(salida === 'LISTO' && faltas.length) throw new Error('No puede quedar LISTO completo: faltan unidades. Elige enviar incompleto o esperar.');
      if(salida === 'INCOMPLETO' && (!faltas.length || !(totalW > 0))) throw new Error('Enviar incompleto exige un faltante real y al menos una unidad despachada.');
      /* =================================================================
         v5.5.4 · BUG_030 · EL HUECO QUE TODAVIA PODIA CREAR UN «P-001»
         =================================================================
         La salida INCOMPLETO si exigia al menos una unidad despachada
         (totalW > 0). La salida LISTO no: solo exigia que no faltara nada,
         y «no falta nada» es cierto tambien cuando todas las lineas piden
         0 y entregan 0. Por ahi se podia cerrar un pedido LISTO con CERO
         unidades, que es exactamente la forma de P-001 en el libro: LISTO,
         sin unidades despachadas, imposible de facturar y de entregar.
         Como el usuario quiere limpiar la base y empezar de cero, esto era
         lo que haria volver el mismo dato malo. La guarda va AQUI, en el
         punto donde el cierre se convierte en un hecho, y no depende de
         como se llego a tener lineas en cero.
         ================================================================= */
      if(!(totalW > 0)) throw new Error('No se puede cerrar ' + pid + ' sin ninguna unidad despachada. ' +
        'Un pedido cerrado con cero unidades no se puede facturar ni entregar, y queda atascado. ' +
        'Registre las cantidades en Despachar, o inhabilite el pedido si no se va a surtir.');
      if(['LISTO','INCOMPLETO'].indexOf(salida) < 0) throw new Error('Salida de cierre desconocida.');
      nuevaEtapa = 'LISTO';
      actuales.forEach(function(r){
        if(txt(r.Como_se_suple).toUpperCase() !== 'INVENTARIO')
          escribirFila({hoja:H.prepDet,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:r.Tipo},{columna:'Referencia',valor:r.Referencia}],
            fila:{P_num:pid,Tipo:r.Tipo,Referencia:r.Referencia,Se_suplio:numero(r.Cant_despachada) >= numero(r.Cant_solicitada) ? 'S' : 'N'}});
      });
      ['F','R'].forEach(function(t){
        var lin = actuales.filter(function(r){return txt(r.Tipo).toUpperCase() === t;});
        var fal = lin.filter(function(r){return numero(r.Cant_despachada) < numero(r.Cant_solicitada);});
        var rp=lin.length?repro[t]:{reproceso:false,defecto:''};
        var tcParte=txt(cab.tc);
        escribirFila({hoja:H.prep,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:t}],fila:{
          P_num:pid,Tipo:t,Estado_registro:lin.length ? E_VIG : E_NA,tl:lin.length ? marca : '',
          Ciclo_h:lin.length?preparacionHoras_(tcParte,marca):'',Despacho_h:lin.length?preparacionHoras_(tcParte,(filas(H.prep).filter(function(x){return txt(x.P_num)===pid&&txt(x.Tipo).toUpperCase()===t;})[0]||{}).td):'',
          Completo:lin.length ? (fal.length ? 'N' : 'S') : '',Reproceso:lin.length ? (rp.reproceso?'S':'N') : '',
          Tipo_defecto:lin.length&&rp.reproceso?txt(rp.defecto):'',Operador:operador,
          Faltante:fal.map(function(r){return r.Referencia;}).join(' - ')}});
      });
      escribirFila({hoja:H.entregas,claves:[{columna:'P_num',valor:pid}],fila:{P_num:pid,tl:marca}});
    }else throw new Error('Accion de preparacion desconocida: ' + accion);

    var despues = preparacionLineas_(pid);
    preparacionPartes_(pid, despues).forEach(escribirFila);
    var tipos = {}; despues.forEach(function(l){tipos[txt(l.Tipo).toUpperCase()] = true;});
    var tipoPed = Object.keys(tipos).length > 1 ? 'MIXTO' : (Object.keys(tipos)[0] || '');
    var f3 = {P_num:pid,Tipo_pedido:tipoPed,Etapa_preparacion:nuevaEtapa,Revision:revision + 1};
    if(nuevaEtapa === 'LISTO'){
      var faltan3 = despues.filter(function(r){return numero(r.Cant_despachada) < numero(r.Cant_solicitada);});
      f3.Estado = 'LISTO'; f3.Fecha_real_listo = marca; f3.Finalizado_en = marca;
      f3.Pedido_completo = faltan3.length ? 'N' : 'S';
      f3.Referencia_faltante = faltan3.map(function(r){return r.Referencia;}).join(' - ');
      var insumo=despues.filter(function(r){return /^PEDIR|ESPERA_MP/.test(txt(r.Como_se_suple).toUpperCase());});
      f3.Atrasado_por_insumo=insumo.length&&txt(cab.Fecha_compromiso)&&txt(cab.Fecha_compromiso)<marca.substr(0,10)?'S':'N';
      var partesListo=filas(H.prep).filter(function(r){return txt(r.P_num)===pid&&txt(r.Estado_registro)===E_VIG;});
      /* v5.1 · A2 · Corchetes OBLIGATORIOS: el nombre de la columna lleva '%', que
         no es un caracter valido en un identificador. Con notacion de punto,
         f3.TSI_pedido_%=X se lee como el operador %= y escribe NaN en una
         propiedad que nadie usa, y la columna queda vacia para siempre. */
      f3['TSI_pedido_%']=partesListo.length?partesListo.reduce(function(sum,r){return sum+(txt(r.Surtido_inventario)==='S'?100:0);},0)/partesListo.length:0;
      f3.Listo_a_tiempo = txt(cab.Fecha_compromiso) && txt(cab.Fecha_compromiso) < marca.substr(0,10) ? 'N' : 'S';
    }else if(nuevaEtapa !== 'ORGANIZAR') f3.Estado = 'EN_PREPARACION';
    /* v5.4 · BUG_004 · atomico: Estado y Etapa_preparacion viajan en la
       MISMA escritura. Es la unica forma de que no puedan quedar
       desalineados por un corte a mitad de camino. */
    escribirFila({hoja:H.pedidos,atomico:true,claves:[{columna:'P_num',valor:pid}],fila:f3});
    var resultado={ok:true,id:pid,etapa:nuevaEtapa,revision:revision + 1,lineas:despues.length};
    if(avisosPrep_.length) resultado.avisos = avisosPrep_;   /* v5.5.7 · BUG_034 */
    preparacionGuardarComprobante_(pid,solicitud,accion,resultado,operador);
    return resultado;
  }finally{lock.releaseLock();}
}

function apiEditarFactura_(pid,datos,operador){
  /* =====================================================================
     v5.4 · BUG_005 · EL MOTIVO SE PIDE CUANDO CAMBIA UN PRECIO
     =====================================================================
     Antes se exigia para cualquier correccion, incluso para mover un
     descuento. El usuario pidio que la pregunta aparezca «solo y unicamente
     si el operador cambia el precio del producto».
     La exigencia se traslada al sitio donde se sabe si un precio cambio de
     verdad: dentro del recorrido de las lineas, comparando contra la hoja.
     Lo que NO cambia es el registro: todo queda en LOG_Cambios, con motivo
     escrito por el operador o con el motivo por omision del sistema. Se
     quita la friccion, no la trazabilidad.
     ===================================================================== */
  pid=txt(pid);datos=datos||{};var motivo=txt(datos.motivo);
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    var p=buscarEn(filas(H.pedidos),'P_num',pid);if(!p)throw new Error('El pedido no existe.');
    if(txt(p.Estado_registro)===E_ANU)throw new Error('El pedido está anulado.');
    if(['LISTO','ENTREGADO'].indexOf(txt(p.Estado).toUpperCase())<0)throw new Error('La edición documental se hace después de Finalizar.');
    var ent=buscarEn(filas(H.entregas),'P_num',pid)||{};
    if(txt(ent.Doc_estado).toUpperCase()==='FACTURADO')throw new Error('El documento ya fue facturado; se corrige con nota crédito.');
    /* las columnas que se escriben aqui, Precio_unitario y Descuento_pct,
       son de la plantilla original de R2_Detalle: existen desde Fase 2. Si
       faltaran, el pedido no tendria ni precios, y eso lo detecta antes
       heralsaVerificarIntegridad(). */
    var logs=[],cambios=0;
    /* v5.1 · C1 · UNA lectura de R2_Detalle, no una por cada linea editada.
       preparacionLineas_(pid) estaba DENTRO del forEach: con 5 lineas eran 5
       lecturas completas de la hoja para buscar 5 filas que ya estaban ahi. */
    var lineasDelPedido=preparacionLineas_(pid);
    (datos.lineas||[]).forEach(function(x){
      var cod=txt(x.cod||x.Referencia).toUpperCase();
      var l=lineasDelPedido.filter(function(r){return low(r.Referencia)===low(cod);})[0];
      if(!l)throw new Error(cod+': no pertenece al pedido.');
      var precio=numero(x.precio),desc=numero(x.dpct);
      if(!(precio>=0))throw new Error(cod+': precio inválido.');
      if(!(desc>=0&&desc<=100))throw new Error(cod+': el descuento debe estar entre 0 y 100.');
      var f={};
      /* PUNTO 4 · el precio NUEVO queda en la linea del pedido: el pedido
         se vendio a ese valor y su total tiene que decirlo. El registro
         deja constancia de que el catalogo NO se tocó, que es la parte que
         de verdad hay que proteger: el producto sigue valiendo lo que vale
         para el siguiente pedido. */
      if(numero(l.Precio_unitario)!==precio){
        /* v5.4 · BUG_005 · un PRECIO si exige explicacion del operador */
        if(!motivo) throw new Error('Para cambiar el precio de ' + l.Referencia +
          ' hay que explicar por qué. Un descuento no lo necesita; un precio sí.');
        logs.push({Tabla:'R2_Detalle',Registro:pid+' / '+l.Referencia,Campo:'Precio_unitario',
          Valor_antes:numero(l.Precio_unitario),Valor_despues:precio,
          Motivo:motivo+' · precio de ESTA venta; CAT_Productos no se modificó'});
        f.Precio_unitario=precio;cambios++;
      }
      if(numero(l.Descuento_pct)!==desc){
        logs.push({Tabla:'R2_Detalle',Registro:pid+' / '+l.Referencia,Campo:'Descuento_pct',
          Valor_antes:numero(l.Descuento_pct),Valor_despues:desc,
          Motivo:(motivo||'Descuento aplicado al facturar')+' · descuento de ESTA venta; CAT_Productos no se modificó'});
        f.Descuento_pct=desc;cambios++;
      }
      if(Object.keys(f).length){
        escribirFila({hoja:H.prepDet,claves:[{columna:'P_num',valor:pid},{columna:'Tipo',valor:l.Tipo},{columna:'Referencia',valor:l.Referencia}],fila:f});
        /* v5.1 · al no releer la hoja en cada vuelta, la copia en memoria hay
           que dejarla al dia, por si la misma referencia llega dos veces. */
        Object.keys(f).forEach(function(c){l[c]=f[c];});
      }
    });
    if(datos.descGlobal!==undefined&&numero(p.Descuento_global_pct)!==numero(datos.descGlobal)){
      var dg=numero(datos.descGlobal);if(!(dg>=0&&dg<=100))throw new Error('El descuento global debe estar entre 0 y 100.');
      logs.push({Tabla:'R3_Pedidos',Registro:pid,Campo:'Descuento_global_pct',Valor_antes:numero(p.Descuento_global_pct),Valor_despues:dg,Motivo:(motivo||'Descuento global aplicado al facturar')});
      escribirFila({hoja:H.pedidos,claves:[{columna:'P_num',valor:pid}],fila:{Descuento_global_pct:dg}});cambios++;
    }
    if(!cambios)return {ok:true,cambios:0};
    apiLogCambio_(logs,operador);return {ok:true,cambios:cambios,total:apiFactura_(pid).total};
  }finally{lock.releaseLock();}
}

/* ===================== CATALOGOS ===================== */
function apiAgregarCatalogo_(cat, valor, extra){
  var nombreHoja = H[cat];
  if(!nombreHoja) throw new Error('Catalogo desconocido: ' + cat);
  var nuevo = txt(valor).replace(/\s+/g, ' ');
  if(!nuevo) throw new Error('Valor vacio');
  if(cat === 'productos' || cat === 'materias'){
    nuevo = nuevo.toUpperCase();
    if(!/^[A-Z0-9][A-Z0-9 ._\-\/]{1,24}$/.test(nuevo))
      throw new Error('"' + nuevo + '" no parece un codigo. Maximo 25 caracteres, sin comas ni frases.');
  }
  var ya = buscarIgual(nombreHoja, nuevo);
  if(ya) return { ok:true, valor:ya, nuevo:false };
  if(cat === 'productos' || cat === 'materias'){
    var otro = cat === 'productos' ? H.materias : H.productos;
    var cruce = buscarIgual(otro, nuevo);
    if(cruce) throw new Error('"' + nuevo + '" ya existe en ' + otro);
  }
  var sh = hoja(nombreHoja), idx = indices(sh);
  var fila = Math.max(sh.getLastRow() + 1, 2);
  var campoValor = nombreHoja === H.clientes ? 'Cliente' : nombreHoja === H.proveedores ? 'Proveedor' : 'Codigo';
  var ciValor = idx[campoValor] !== undefined ? idx[campoValor] : 0;
  sh.getRange(fila, ciValor + 1).setValue(nuevo);
  if(cat === 'clientes' && idx['Cliente_id'] !== undefined && !txt(sh.getRange(fila, idx['Cliente_id'] + 1).getValue()))
    sh.getRange(fila, idx['Cliente_id'] + 1).setValue(nuevoConsecutivo(nombreHoja, 'CLI', 4));
  if(cat === 'proveedores' && idx['Proveedor_id'] !== undefined && !txt(sh.getRange(fila, idx['Proveedor_id'] + 1).getValue()))
    sh.getRange(fila, idx['Proveedor_id'] + 1).setValue(nuevoConsecutivo(nombreHoja, 'PRO', 4));
  /* =====================================================================
     v5.1 · TANDA 3 · ALTA COMPLETA, NO SOLO EL NOMBRE
     =====================================================================
     Antes esta funcion solo sabia escribir tres campos: descripcion, tipo
     y clase. Crear un producto dejaba costo, precios, IVA y codigo de
     barras VACIOS, y despues habia que abrir la hoja a mano. Eso es
     justo lo que la aplicacion existe para evitar, y es tambien la causa
     de que 394 de 853 productos tengan costo 0.

     COMO SE ESCRIBE: lista blanca explicita por catalogo. Solo se escriben
     columnas que existen en la hoja y que estan en la lista. Un campo que
     llegue y no este en la lista se IGNORA, no se escribe donde caiga.

     LO QUE NO HACE: no edita. Si el valor ya existe, devuelve nuevo:false
     y no toca nada, igual que antes. La edicion de productos tiene su
     propia ruta con motivo y registro en LOG_Cambios, porque cambiar un
     precio de catalogo no puede ser un efecto colateral de un alta.
     ===================================================================== */
  extra = extra || {};

  var PERMITIDO = {
    productos: {
      descripcion:'Descripcion', tipo:'Tipo_trabajo', unidad:'Unidad',
      reorden:'Punto_reorden', activo:'Activo', barras:'Codigo_barras', iva:'IVA',
      pmay:'Precio_mayorista', pmin:'Precio_minorista', costo:'Costo',
      categoria:'Categoria', inventariable:'Inventariable', revision:'Requiere_revision',
      observacion:'Observacion_calidad'
    },
    materias: { descripcion:'Descripcion', unidad:'Unidad', reorden:'Punto_reorden', activo:'Activo' },
    clientes: {
      canal:'Canal_habitual', contacto:'Contacto', activo:'Activo',
      tipoId:'Tipo_identificacion', numId:'Numero_identificacion', dv:'Digito_verificacion',
      forma:'Forma_pago', medio:'Medio_pago', plazo:'Plazo_dias', vendedor:'Vendedor',
      correo:'Correo', telefono:'Telefono', direccion:'Direccion',
      municipio:'Municipio', departamento:'Departamento', lista:'Lista_precios'
    },
    proveedores: {
      clase:'Clase', contacto:'Contacto', lead:'Lead_time_pactado_d', activo:'Activo',
      tipoId:'Tipo_identificacion', numId:'Numero_identificacion',
      forma:'Forma_pago', medio:'Medio_pago', plazo:'Plazo_dias'
    }
  };
  var NUMERICOS = {Punto_reorden:1, IVA:1, Precio_mayorista:1, Precio_minorista:1,
                   Costo:1, Plazo_dias:1, Lead_time_pactado_d:1, Digito_verificacion:1};
  var MAYUSCULAS = {Tipo_trabajo:1, Clase:1, Activo:1, Inventariable:1, Requiere_revision:1};

  var mapa = PERMITIDO[cat] || {};
  var escritos = [];
  Object.keys(mapa).forEach(function(k){
    if(extra[k] === undefined || extra[k] === null || extra[k] === '') return;
    var col = mapa[k];
    if(idx[col] === undefined) return;          /* la hoja no tiene esa columna: se salta */
    var v = extra[k];
    if(NUMERICOS[col]){
      v = numero(v);
      if(!(v >= 0)) throw new Error(col + ': debe ser un numero mayor o igual que cero.');
    }else{
      v = txt(v);
      if(MAYUSCULAS[col]) v = v.toUpperCase();
    }
    sh.getRange(fila, idx[col] + 1).setValue(v);
    escritos.push(col);
  });

  /* Coherencia minima del producto, para no crear datos que rompan calculos */
  if(cat === 'productos'){
    var pmay = numero(extra.pmay), pmin = numero(extra.pmin), cos = numero(extra.costo);
    if(pmay && cos && cos > pmay)
      throw new Error('El costo (' + cos + ') es mayor que el precio mayorista (' + pmay + '). Revise: asi toda venta daria perdida.');
    if(pmin && cos && cos > pmin)
      throw new Error('El costo (' + cos + ') es mayor que el precio minorista (' + pmin + '). Revise: asi toda venta daria perdida.');
    /* Activo e Inventariable por omision en S: un producto nuevo se vende y
       se cuenta, salvo que digan lo contrario. Vacio significaba «no» en
       algunos filtros, y un producto nuevo invisible es un error que cuesta
       encontrar. */
    ['Activo','Inventariable'].forEach(function(c){
      if(idx[c] !== undefined && escritos.indexOf(c) < 0){ sh.getRange(fila, idx[c] + 1).setValue('S'); escritos.push(c); }
    });
  }
  if(cat === 'clientes' || cat === 'proveedores'){
    if(idx['Activo'] !== undefined && escritos.indexOf('Activo') < 0){ sh.getRange(fila, idx['Activo'] + 1).setValue('S'); escritos.push('Activo'); }
  }
  /* El codigo de producto se escribe como TEXTO. D-26: si queda como numero,
     apiExcelAlegra_ puede emitir «1035010.0» y Alegra rechaza el archivo. */
  if((cat === 'productos' || cat === 'materias') && idx[campoValor] !== undefined)
    sh.getRange(fila, idx[campoValor] + 1).setNumberFormat('@');

  return { ok:true, valor:nuevo, nuevo:true, campos:escritos };
}
function buscarIgual(nombreHoja, valor){
  var l = columna(nombreHoja), b = low(valor);
  for(var i = 0; i < l.length; i++) if(low(l[i]) === b) return l[i];
  return null;
}

/* =====================================================================
   MIGRACION 1 · LINEA BASE DE NUMERACION  (ya se corrio el 19-10-2026)
   Se deja en el archivo con su candado: si se corre otra vez, no hace nada.
   ===================================================================== */
var MIGRA_PEDIDOS = {
  'P-10':'P-001', 'P-11':'P-002', 'P-12':'P-003', 'P-13':'P-004',
  'P-14':'P-005', 'P-15':'P-006', 'P-16':'P-007', 'P-17':'P-008',
  'P-18':'P-009', 'P-19':'P-010', 'P-20':'P-011', 'P-21':'P-012'
};
var MIGRA_COMPRAS = { 'C-01':'C-001' };
var MIGRA_BORRAR_LINEAS = [{ compra:'C-01', codigo:'Etiqueta adhesiva' }];
var MIGRA_CODIGOS = { 'to4025':'TC4025', 'tv9004':'TV9004', 'tc4025':'TC4025' };
var MIGRA_MOVER_A_PRODUCTOS = [];
var NUM_COLS = {
  'R1_Compras':['Pp','Pc','Pi','Pf','Lead_interno_d','Lead_proveedor_d','Lead_total_d','TCR_compra_%'],
  'R1_Detalle':['Cant_pedida'],
  'R2_Preparacion':['Ciclo_h'],
  'R3_Pedidos':['Dias_prometidos','TSI_pedido_%'],
  'R4_Entregas':['Ciclo_entrega_d','Gasto_entrega']
};

function simularMigracion_(){ return correrMigracion(true); }
function migrar_(){ return correrMigracion(false); }

function correrMigracion(soloSimular){
  var ss = libro(), log = [];
  function L(t){ log.push(t); Logger.log(t); }
  L(soloSimular ? '=== SIMULACION (no se escribe nada) ===' : '=== MIGRACION REAL ===');

  var ped = filas(H.pedidos), par = filas(H.prep), ent = filas(H.entregas),
      com = filas(H.compras), det = filas(H.detalle);

  var conserva = [], borra = [];
  ped.forEach(function(p){
    var id = txt(p['P_num']);
    if(MIGRA_PEDIDOS[id]) conserva.push(id); else borra.push(id);
  });
  L('Pedidos en la hoja: ' + ped.length);
  L('Se BORRAN (' + borra.length + '): ' + borra.join(', '));
  L('Se CONSERVAN (' + conserva.length + '): ' + conserva.map(function(i){ return i + '->' + MIGRA_PEDIDOS[i]; }).join(', '));

  if(ped.length && !conserva.length){
    L('');
    L('*** NO SE HIZO NADA. La hoja ya esta migrada. ***');
    L('En la hoja hay: ' + ped.slice(0, 5).map(function(p){ return p['P_num']; }).join(', ') + (ped.length > 5 ? '...' : ''));
    L('El mapa esperaba P-10 ... P-21. Si de verdad necesitas volver a migrar_,');
    L('restaura primero desde las pestanas ZZ_antes_...');
    return log.join('\n');
  }
  if(!ped.length){ L('*** NO SE HIZO NADA: R3_Pedidos esta vacia. ***'); return log.join('\n'); }

  var orden = conserva.slice().sort(function(a, b){ return MIGRA_PEDIDOS[a] < MIGRA_PEDIDOS[b] ? -1 : 1; });
  var plan = orden.map(function(viejo){
    var p = buscarEn(ped, 'P_num', viejo);
    var ps = par.filter(function(x){ return txt(x['P_num']) === viejo; });
    var pF = ps.filter(function(x){ return txt(x['Tipo']).toUpperCase() === 'F'; })[0] || null;
    var pR = ps.filter(function(x){ return txt(x['Tipo']).toUpperCase() === 'R'; })[0] || null;
    var tls = [];
    if(pF && txt(pF['tl'])) tls.push(txt(pF['tl']));
    if(pR && txt(pR['tl'])) tls.push(txt(pR['tl']));
    var napl = ((pF && aplica(pF)) ? 1 : 0) + ((pR && aplica(pR)) ? 1 : 0);
    var tl = (tls.length && tls.length === napl) ? tls.sort()[tls.length - 1] : '';
    return { viejo:viejo, nuevo:MIGRA_PEDIDOS[viejo], p:p, pF:pF, pR:pR, e:buscarEn(ent, 'P_num', viejo), tl:tl };
  });
  plan.forEach(function(x){
    var tipos = (x.pF && aplica(x.pF) ? 'F' : '') + (x.pR && aplica(x.pR) ? 'R' : '');
    L('  ' + x.nuevo + '  (' + x.viejo + ')  ' + txt(x.p['Cliente']) + '  partes=' + (tipos || 'ninguna') +
      '  tl=' + (x.tl || '-') + '  entrega=' + (x.e && txt(x.e['te']) ? txt(x.e['te']) : 'no'));
  });
  var lineasBorrar = det.filter(function(d){
    return MIGRA_BORRAR_LINEAS.some(function(b){ return txt(d['C_num']) === b.compra && txt(d['Codigo']) === b.codigo; });
  });
  com.forEach(function(c){ L('Compra ' + txt(c['C_num']) + ' -> ' + (MIGRA_COMPRAS[txt(c['C_num'])] || 'SE BORRA')); });
  L('Lineas de R1_Detalle que se borran: ' + lineasBorrar.length);

  if(soloSimular){ L('=== FIN DE LA SIMULACION · no se escribio nada ==='); return log.join('\n'); }

  [H.compras, H.detalle, H.prep, H.pedidos, H.entregas].forEach(function(n){
    var destino = 'ZZ_antes_' + n;
    if(!ss.getSheetByName(destino)){
      ss.getSheetByName(n).copyTo(ss).setName(destino);
      L('Respaldo creado: ' + destino);
    } else L('Respaldo ya existia: ' + destino);
  });

  escribirBloque(H.pedidos, plan.map(function(x){
    var f = copia(x.p);
    f['P_num'] = x.nuevo; f['Fecha_real_listo'] = x.tl;
    f[COL_EST] = E_VIG; f[COL_MOT] = ''; f[COL_POR] = ''; f[COL_CUA] = '';
    return f;
  }), L);

  var filasR2 = [];
  plan.forEach(function(x){
    ['F', 'R'].forEach(function(t){
      var orig = t === 'F' ? x.pF : x.pR, f = {};
      if(orig && aplica(orig)){ f = copia(orig); f['tl'] = x.tl; f[COL_EST] = E_VIG; }
      else { f[COL_EST] = (x.pF || x.pR) ? E_NA : E_PEND; }
      f['P_num'] = x.nuevo; f['Tipo'] = t;
      f[COL_MOT] = ''; f[COL_POR] = ''; f[COL_CUA] = '';
      filasR2.push(f);
    });
  });
  escribirBloque(H.prep, filasR2, L);

  escribirBloque(H.entregas, plan.map(function(x){
    var tiene = x.e && txt(x.e['te']);
    var f = tiene ? copia(x.e) : {};
    f['P_num'] = x.nuevo; f['Cliente'] = txt(x.p['Cliente']); f['Canal'] = txt(x.p['Canal']); f['tl'] = x.tl;
    f[COL_EST] = tiene ? E_VIG : E_PEND;
    f[COL_MOT] = ''; f[COL_POR] = ''; f[COL_CUA] = '';
    return f;
  }), L);

  escribirBloque(H.compras, com.filter(function(c){ return MIGRA_COMPRAS[txt(c['C_num'])]; }).map(function(c){
    var f = copia(c);
    var lineas = det.filter(function(d){ return txt(d['C_num']) === txt(c['C_num']) && lineasBorrar.indexOf(d) < 0; });
    var cuenta = function(e){ return lineas.filter(function(d){ return txt(d['Estado_recepcion']).toUpperCase() === e; }).length; };
    f['C_num'] = MIGRA_COMPRAS[txt(c['C_num'])];
    f['Pp'] = lineas.length; f['Pc'] = cuenta('COMPLETA'); f['Pi'] = cuenta('INCOMPLETA'); f['Pf'] = cuenta('AUSENTE');
    f['Faltantes'] = lineas.filter(function(d){
        var e = txt(d['Estado_recepcion']).toUpperCase();
        return e === 'INCOMPLETA' || e === 'AUSENTE';
      }).map(function(d){ return txt(d['Codigo']); }).join(' · ');
    f['TCR_compra_%'] = lineas.length ? f['Pc'] / lineas.length * 100 : '';
    f[COL_EST] = E_VIG; f[COL_MOT] = ''; f[COL_POR] = ''; f[COL_CUA] = '';
    return f;
  }), L);

  escribirBloque(H.detalle, det.filter(function(d){
      return MIGRA_COMPRAS[txt(d['C_num'])] && lineasBorrar.indexOf(d) < 0;
    }).map(function(d){
      var f = copia(d);
      f['C_num'] = MIGRA_COMPRAS[txt(d['C_num'])];
      f['Codigo'] = codigoBueno(txt(d['Codigo']));
      return f;
    }), L);

  arreglarCatalogos(L);
  L('=== MIGRACION TERMINADA ===');
  return log.join('\n');
}

/* =====================================================================
   MIGRACION 2 · REPARTO DE REFERENCIAS
   Toma lo que hoy esta metido en las celdas Por_pedir y Faltante de
   R2_Preparacion y lo reparte:
     - lo que sea PRODUCTO  -> una fila por referencia en R2_Detalle
     - lo que sea MATERIA PRIMA -> columna Materia_prima_faltante
     - lo que no este en ningun catalogo -> se REPORTA, no se inventa
   Es re-ejecutable: se salta los pedidos que ya tienen filas en R2_Detalle.
   ===================================================================== */
function simularReparto_(){ return correrReparto(true); }
function repartir_(){ return correrReparto(false); }

function correrReparto(soloSimular){
  var log = [];
  function L(t){ log.push(t); Logger.log(t); }
  L(soloSimular ? '=== SIMULACION DEL REPARTO (no se escribe nada) ===' : '=== REPARTO REAL ===');

  var prod = {}, mat = {};
  catalogo(H.productos, 'Descripcion').forEach(function(o){ prod[o.v.toLowerCase()] = o; });
  catalogo(H.materias, 'Descripcion').forEach(function(o){ mat[o.v.toLowerCase()] = o; });

  var yaHay = {};
  filas(H.prepDet).forEach(function(r){ yaHay[txt(r['P_num']) + '|' + txt(r['Tipo']).toUpperCase()] = 1; });

  var par = filas(H.prep), escribir = [], mpPorFila = [], raras = [], saltadas = 0;

  par.forEach(function(r){
    var pid = txt(r['P_num']), tipo = txt(r['Tipo']).toUpperCase();
    if(!pid || (tipo !== 'F' && tipo !== 'R')) return;
    var pend = partirLista(r['Por_pedir']), falt = partirLista(r['Faltante']);
    if(!pend.length && !falt.length) return;
    if(yaHay[pid + '|' + tipo]){ saltadas++; L('  ' + pid + '/' + tipo + ': ya tiene filas en R2_Detalle, se salta.'); return; }

    var ruta = txt(r['Ruta']).toUpperCase(), cerrada = !!txt(r['tl']);
    var comoP = ruta.indexOf('PEDIR_PRODUCTO') === 0 ? 'PEDIR_PRODUCTO'
              : ruta.indexOf('PEDIR_MP') === 0 ? 'ESPERA_MP'
              : ruta.indexOf('FABRIC') === 0 ? 'FABRICAR'
              : (tipo === 'R' ? 'PEDIR_PRODUCTO' : 'FABRICAR');
    if(!ruta) raras.push(pid + '/' + tipo + ': la linea no tenia Ruta. Se deduce del tipo: ' + comoP);
    var faltLow = falt.map(function(x){ return x.toLowerCase(); });
    var todas = pend.slice();
    falt.forEach(function(x){ if(todas.map(function(y){ return y.toLowerCase(); }).indexOf(x.toLowerCase()) < 0) todas.push(x); });
    var mps = [];

    todas.forEach(function(ref){
      var k = ref.toLowerCase();
      if(prod[k]){
        escribir.push({ P_num:pid, Tipo:tipo, Referencia:prod[k].v, Descripcion:prod[k].d || '',
          Como_se_suple:comoP, Origen:'PASO_2',
          Se_suplio: faltLow.indexOf(k) >= 0 ? 'N' : (cerrada ? 'S' : ''),
          Estado_registro:E_VIG });
      } else if(mat[k]){
        mps.push(mat[k].v);
      } else {
        raras.push(pid + '/' + tipo + ': "' + ref + '"');
        if(comoP === 'ESPERA_MP') mps.push(ref);
        else escribir.push({ P_num:pid, Tipo:tipo, Referencia:ref, Descripcion:'(no esta en el catalogo)',
          Como_se_suple:comoP, Origen:'PASO_2',
          Se_suplio: faltLow.indexOf(k) >= 0 ? 'N' : (cerrada ? 'S' : ''),
          Estado_registro:E_VIG });
      }
    });
    if(mps.length) mpPorFila.push({ fila:r.__fila, pid:pid, tipo:tipo, mp:mps.join(' - ') });
  });

  L('Filas nuevas para R2_Detalle: ' + escribir.length);
  escribir.forEach(function(e){
    L('  ' + e.P_num + '/' + e.Tipo + '  ' + e.Referencia + '  ' + e.Como_se_suple +
      '  se_suplio=' + (e.Se_suplio || 'en proceso') + '  ' + (e.Descripcion || ''));
  });
  L('Materia prima que pasa a su columna: ' + mpPorFila.length);
  mpPorFila.forEach(function(m){ L('  ' + m.pid + '/' + m.tipo + ' -> ' + m.mp); });
  if(raras.length){
    L('');
    L('!! REVISAR: ' + raras.length + ' referencia(s) no estan en ningun catalogo.');
    raras.forEach(function(x){ L('   ' + x); });
    L('   No las invento: las dejo donde dice la Ruta de la linea y te las reporto.');
  }
  if(saltadas) L('Lineas saltadas por tener ya su detalle: ' + saltadas);

  if(soloSimular){ L('=== FIN DE LA SIMULACION · no se escribio nada ==='); return log.join('\n'); }

  var sh = hoja(H.prep), idx = indices(sh);
  mpPorFila.forEach(function(m){
    if(idx['Materia_prima_faltante'] !== undefined) sh.getRange(m.fila, idx['Materia_prima_faltante'] + 1).setValue(m.mp);
  });
  escribir.forEach(function(e){
    escribirFila({ hoja:H.prepDet, selloSoloNueva:true,
      claves:[{ columna:'P_num', valor:e.P_num }, { columna:'Tipo', valor:e.Tipo }, { columna:'Referencia', valor:e.Referencia }],
      fila:e });
  });
  L('=== REPARTO TERMINADO · ' + escribir.length + ' filas en R2_Detalle ===');
  L('Ahora si puedes eliminar las columnas Por_pedir y Faltante de R2_Preparacion.');
  return log.join('\n');
}
function partirLista(v){
  return txt(v).split(/\s+-\s+|\s+·\s+/).map(function(x){ return x.trim(); }).filter(function(x){ return !!x; });
}

/* ---------- utilidades compartidas por las migraciones ---------- */
function aplica(fila){
  var e = txt(fila[COL_EST]).toUpperCase();
  if(e === E_NA || e === E_PEND) return false;
  return !!(txt(fila['tc']) || txt(fila['tl']) || txt(fila['Surtido_inventario']));
}
function buscarEn(lista, col, valor){
  for(var i = 0; i < lista.length; i++) if(txt(lista[i][col]) === valor) return lista[i];
  return null;
}
function copia(o){ var r = {}; for(var k in o) if(k !== '__fila') r[k] = o[k]; return r; }
function codigoBueno(c){
  var l = low(c);
  if(MIGRA_CODIGOS[l]) return MIGRA_CODIGOS[l];
  return /^[a-z]{2,4}\d{3,4}$/.test(l) ? String(c).toUpperCase() : c;
}
function numero(v){
  if(typeof v === 'number') return v;
  var s = txt(v).replace(/[^\d.,-]/g, '');
  if(!s) return '';
  if(s.indexOf('.') >= 0 && s.indexOf(',') >= 0) s = s.replace(/\./g, '').replace(',', '.');
  else if(s.indexOf(',') >= 0) s = s.replace(',', '.');
  else if(/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  var n = Number(s);
  return isNaN(n) ? '' : n;
}
function escribirBloque(nombreHoja, listaObjetos, L){
  var sh = hoja(nombreHoja), idx = indices(sh);
  var cols = sh.getRange(1, 1, 1, idx.__ancho).getValues()[0].map(function(c){ return txt(c); });
  if(sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, idx.__ancho).clearContent();
  if(!listaObjetos.length){ L(nombreHoja + ': 0 filas'); return; }
  var nums = NUM_COLS[nombreHoja] || [];
  var matriz = listaObjetos.map(function(o){
    return cols.map(function(c){
      var v = o[c];
      if(v === undefined || v === null) return '';
      if(nums.indexOf(c) >= 0) return numero(v);
      if(c === 'Por_pedir' || c === 'Faltante' || c === 'Referencia_faltante' || c === 'Materia_prima_faltante')
        return String(v).split(' - ').map(function(x){ return codigoBueno(x.trim()); }).join(' - ');
      return v;
    });
  });
  sh.getRange(2, 1, matriz.length, cols.length).setValues(matriz);
  L(nombreHoja + ': ' + matriz.length + ' filas escritas');
}
function arreglarCatalogos(L){
  [H.productos, H.materias].forEach(function(n){
    var sh = libro().getSheetByName(n);
    if(!sh || sh.getLastRow() < 2) return;
    var r = sh.getRange(2, 1, sh.getLastRow() - 1, 1), v = r.getValues();
    for(var i = 0; i < v.length; i++) if(v[i][0]) v[i][0] = codigoBueno(txt(v[i][0]));
    r.setValues(v);
  });
  MIGRA_MOVER_A_PRODUCTOS.forEach(function(nombre){
    var mat = hoja(H.materias);
    if(mat.getLastRow() < 2) return;
    var v = mat.getRange(2, 1, mat.getLastRow() - 1, 1).getValues();
    for(var i = 0; i < v.length; i++){
      if(low(v[i][0]) === low(nombre)){
        mat.deleteRow(i + 2);
        if(!buscarIgual(H.productos, nombre)) hoja(H.productos).appendRow([nombre]);
        L('Catalogo: "' + nombre + '" paso de materias primas a productos');
        return;
      }
    }
  });
}

/* =====================================================================
   REPARACION DE R2_Preparacion
   La columna Materia_prima_faltante SOLO admite materias primas del catalogo.
   Si trae un valor de ruta (PEDIR_MP / PEDIR_PRODUCTO / FABRICAR) o cualquier
   cosa que no este en CAT_MateriasPrimas, es que se escribio a mano o se copio
   de otra columna: se reporta y se limpia. NO se inventa nada en su lugar.
   La columna Ruta ya no se usa: la app deduce la ruta de las respuestas.
   ===================================================================== */
var RUTAS = ['PEDIR_MP', 'PEDIR_PRODUCTO', 'FABRICAR'];

function simularReparacionR2_(){ return repararR2_(true); }
/* v5.1 · A1.1 · El editor de Apps Script ejecuta SIN argumentos. Por omision se
   SIMULA. Para escribir de verdad hay que llamar repararR2_(false) a proposito. */
function repararR2_(soloSimular){
  if(soloSimular === undefined) soloSimular = true;
  var log = [];
  function L(t){ log.push(t); Logger.log(t); }
  L(soloSimular ? '=== SIMULACION DE LA REPARACION (no escribe nada) ===' : '=== REPARACION DE R2 ===');

  var mats = {};
  catalogo(H.materias).forEach(function(o){ mats[o.v.toLowerCase()] = o.v; });
  L('Materias primas validas en el catalogo: ' + Object.keys(mats).length);

  var sh = hoja(H.prep), idx = indices(sh);
  var iMP = idx['Materia_prima_faltante'], iRu = idx['Ruta'];
  if(iMP === undefined){ L('No existe la columna Materia_prima_faltante.'); return log.join('\n'); }

  var limpiar = [], rutas = [], ok = 0;
  filas(H.prep).forEach(function(r){
    var v = txt(r['Materia_prima_faltante']);
    if(v){
      var partes = v.split(/\s+-\s+/).map(function(x){ return x.trim(); }).filter(function(x){ return !!x; });
      var buenas = [], malas = [];
      partes.forEach(function(x){ if(mats[x.toLowerCase()]) buenas.push(mats[x.toLowerCase()]); else malas.push(x); });
      if(malas.length){
        limpiar.push({ fila:r.__fila, id:txt(r['P_num']), t:txt(r['Tipo']), malas:malas, buenas:buenas,
          esRuta:malas.some(function(x){ return RUTAS.indexOf(x.toUpperCase()) >= 0; }) });
      } else ok++;
    }
    if(iRu !== undefined){
      var rr = txt(r['Ruta']);
      var s2 = txt(r['Surtido_inventario']).toUpperCase(), h2 = txt(r['Hay_MP']).toUpperCase(), t2 = txt(r['Tipo']).toUpperCase();
      var esp = s2 === 'S' ? '' : (t2 === 'R' ? 'PEDIR_PRODUCTO' : (h2 === 'S' ? 'FABRICAR' : 'PEDIR_MP'));
      if(s2 && rr !== esp) rutas.push(txt(r['P_num']) + '/' + t2 + ': dice "' + rr + '" y por las respuestas deberia ser "' + esp + '"');
    }
  });

  L('Celdas de materia prima correctas: ' + ok);
  L('Celdas que hay que limpiar: ' + limpiar.length);
  limpiar.forEach(function(c){
    L('  fila ' + c.fila + '  ' + c.id + '/' + c.t + '  se borra: ' + c.malas.join(' | ') +
      (c.esRuta ? '   <- es un valor de la columna Ruta, no una materia prima' : '   <- no esta en el catalogo') +
      (c.buenas.length ? '   (se conserva: ' + c.buenas.join(' - ') + ')' : ''));
  });
  if(rutas.length){
    L('');
    L('La columna Ruta tiene ' + rutas.length + ' valor(es) que no corresponden a las respuestas:');
    rutas.forEach(function(x){ L('   ' + x); });
    L('   Esa columna ya no se usa: puedes ELIMINARLA. La app deduce la ruta sola.');
  }
  if(!limpiar.length && !rutas.length) L('Nada que reparar.');

  if(soloSimular){ L('=== FIN DE LA SIMULACION · no se escribio nada ==='); return log.join('\n'); }
  limpiar.forEach(function(c){ sh.getRange(c.fila, iMP + 1).setValue(c.buenas.join(' - ')); });
  L('=== REPARACION TERMINADA · ' + limpiar.length + ' celda(s) limpiadas ===');
  L('Si de verdad falta un insumo en esos pedidos, registralo desde la app.');
  return log.join('\n');
}

/* =====================================================================
   REPARACION DEL EXPEDIENTE
   Si se borran filas de R2_Preparacion a mano, el expediente queda incompleto
   y desalineado. Esta funcion lo reconstruye: deja SIEMPRE 2 filas por pedido
   (F y R), en el orden de R3, conservando lo que exista y reponiendo lo que
   falte CON LA EVIDENCIA QUE QUEDA EN LA HOJA:
       - el tipo de trabajo y las fechas, de R3_Pedidos
       - si la linea aplicaba y como se suplia, de R2_Detalle
       - lo que declaro el operador en la version vieja, de ZZ_antes_R2_Preparacion
   Nada se inventa: cada valor repuesto se reporta con su origen.
   ===================================================================== */
function simularReparacionExpediente_(){ return repararExpediente_(true); }
/* v5.1 · A1.2 · Igual que repararR2_: por omision SIMULA. Esta funcion reescribe
   R2_Preparacion completa, asi que no puede escribir por descuido. */
function repararExpediente_(soloSimular){
  if(soloSimular === undefined) soloSimular = true;
  var log = [];
  function L(t){ log.push(t); Logger.log(t); }
  L(soloSimular ? '=== SIMULACION (no escribe nada) ===' : '=== REPARACION DEL EXPEDIENTE ===');

  var ped = filas(H.pedidos), par = filas(H.prep), det = filas(H.prepDet);
  if(!ped.length){ L('R3_Pedidos esta vacia: no hay nada que reconstruir.'); return log.join('\n'); }

  /* indice de lo que existe */
  var hay = {}, usadas = 0;
  par.forEach(function(r){ hay[txt(r['P_num']) + '|' + txt(r['Tipo']).toUpperCase()] = r; });
  /* referencias por pedido+tipo */
  var refs = {};
  det.forEach(function(r){
    var k = txt(r['P_num']) + '|' + txt(r['Tipo']).toUpperCase();
    (refs[k] = refs[k] || []).push(r);
  });
  /* respaldo de la version vieja, por si hay que recuperar lo que declaro el operador */
  var viejo = {}, inv = {};
  for(var k2 in MIGRA_PEDIDOS) inv[MIGRA_PEDIDOS[k2]] = k2;
  var shZZ = libro().getSheetByName('ZZ_antes_' + H.prep);
  if(shZZ) filas('ZZ_antes_' + H.prep).forEach(function(r){
    viejo[txt(r['P_num']) + '|' + txt(r['Tipo']).toUpperCase()] = r;
  });

  var bloque = [], repuestas = [], huecos = [];
  ped.forEach(function(p){
    var id = txt(p['P_num']), tipoPed = txt(p['Tipo_pedido']).toUpperCase();
    ['F', 'R'].forEach(function(t){
      var k = id + '|' + t;
      if(hay[k]){ bloque.push(copia(hay[k])); usadas++; return; }

      /* hay que reponerla: se mira que dice el resto de la hoja */
      var misRefs = refs[k] || [];
      var aplica = misRefs.length > 0 || tipoPed === 'MIXTO' || tipoPed === t;
      var f = { P_num:id, Tipo:t };
      var de = [];
      if(!aplica){
        f[COL_EST] = tipoPed ? E_NA : E_PEND;
        de.push(tipoPed ? 'el pedido es tipo ' + tipoPed + ', esta parte no aplica' : 'el pedido no ha definido tipo');
      } else {
        var tsi = numero(p['TSI_pedido_%']);
        f['Surtido_inventario'] = (tsi === 100) ? 'S' : 'N';
        de.push('surtido: TSI del pedido = ' + (tsi === '' ? 'vacio' : tsi));
        if(txt(p['tc'])){ f['tc'] = p['tc']; de.push('tc: de R3'); }
        if(txt(p['Fecha_real_listo'])){ f['tl'] = p['Fecha_real_listo']; de.push('tl: de R3'); }
        if(txt(p['tc']) && txt(p['Fecha_real_listo'])){
          var h1 = new Date(String(p['tc']).replace(' ', 'T')), h2 = new Date(String(p['Fecha_real_listo']).replace(' ', 'T'));
          if(!isNaN(h1) && !isNaN(h2)){ f['Ciclo_h'] = (h2 - h1) / 3600000; de.push('Ciclo_h: calculado de tc y tl'); }
        }
        if(txt(p['Pedido_completo'])){ f['Completo'] = p['Pedido_completo']; de.push('Completo: de R3'); }
        /* si hay referencias, ellas dicen si habia materia prima */
        var como = misRefs.length ? txt(misRefs[0]['Como_se_suple']).toUpperCase() : '';
        if(t === 'F'){
          if(como === 'FABRICAR'){ f['Hay_MP'] = 'S'; de.push('Hay_MP: las referencias dicen FABRICAR'); }
          else if(como === 'ESPERA_MP'){ f['Hay_MP'] = 'N'; de.push('Hay_MP: las referencias dicen ESPERA_MP'); }
          else if(viejo[inv[id] + '|' + t]){
            var rv = txt(viejo[inv[id] + '|' + t]['Ruta']).toUpperCase();
            if(rv === 'FABRICAR'){ f['Hay_MP'] = 'S'; de.push('Hay_MP: del respaldo ZZ_antes'); }
            else if(rv === 'PEDIR_MP'){ f['Hay_MP'] = 'N'; de.push('Hay_MP: del respaldo ZZ_antes'); }
          }
        }
        if(txt(p['Operador'])){ f['Operador'] = p['Operador']; de.push('Operador: de R3'); }
        f[COL_EST] = E_VIG;
        if(!misRefs.length) huecos.push(id + '/' + t);
      }
      if(txt(p[COL_EST]).toUpperCase() === E_ANU){
        f[COL_EST] = E_ANU; f[COL_MOT] = p[COL_MOT] || ''; f[COL_POR] = p[COL_POR] || ''; f[COL_CUA] = p[COL_CUA] || '';
        de.push('el pedido esta ANULADO');
      }
      bloque.push(f);
      repuestas.push({ id:id, t:t, de:de, est:f[COL_EST] });
    });
  });

  L('Pedidos en R3: ' + ped.length + '  ->  R2 debe tener ' + (ped.length * 2) + ' filas');
  L('Filas que ya existian y se conservan: ' + usadas);
  L('Filas que hay que reponer: ' + repuestas.length);
  repuestas.forEach(function(r){
    L('  ' + r.id + '/' + r.t + '  (' + r.est + ')');
    r.de.forEach(function(d){ L('      · ' + d); });
  });
  if(huecos.length){
    L('');
    L('OJO: estas lineas quedan sin referencias pendientes (es el hueco de la version vieja):');
    huecos.forEach(function(h){ L('   ' + h); });
    L('   La app va a seguir avisando de ellas hasta que se registren sus productos.');
  }

  if(soloSimular){ L('=== FIN DE LA SIMULACION · no se escribio nada ==='); return log.join('\n'); }
  escribirBloque(H.prep, bloque, L);
  L('=== EXPEDIENTE RECONSTRUIDO · ' + bloque.length + ' filas, alineadas con R3 ===');
  return log.join('\n');
}

/* =====================================================================
   CERRAR EL HUECO DE LA VERSION VIEJA
   Las lineas que la version vieja dejo sin referencias se pueden cerrar con
   lo que el operador escribio en ese momento, que esta en ZZ_antes_R2_Preparacion.
   Queda marcado Origen = MIGRACION para que nunca se confunda con un registro
   normal, y con la descripcion diciendo que no es un codigo del catalogo.
   ===================================================================== */
function cerrarHuecosMigracion(soloSimular){
  if(soloSimular === undefined) soloSimular = true;
  var log = [];
  function L(t){ log.push(t); Logger.log(t); }
  L(soloSimular ? '=== SIMULACION (no escribe nada) ===' : '=== CIERRE DE HUECOS ===');
  if(!libro().getSheetByName('ZZ_antes_' + H.prep)){
    L('No existe el respaldo ZZ_antes_' + H.prep + ': no hay de donde sacar el dato. No se hace nada.');
    return log.join('\n');
  }
  var inv = {}; for(var k in MIGRA_PEDIDOS) inv[MIGRA_PEDIDOS[k]] = k;
  var viejo = {};
  filas('ZZ_antes_' + H.prep).forEach(function(r){ viejo[txt(r['P_num']) + '|' + txt(r['Tipo']).toUpperCase()] = r; });
  var refs = {};
  filas(H.prepDet).forEach(function(r){ refs[txt(r['P_num']) + '|' + txt(r['Tipo']).toUpperCase()] = 1; });
  var prod = {}; catalogo(H.productos, 'Descripcion').forEach(function(o){ prod[o.v.toLowerCase()] = o; });

  var nuevas = [], sinDato = [];
  filas(H.prep).forEach(function(r){
    var id = txt(r['P_num']), t = txt(r['Tipo']).toUpperCase(), k = id + '|' + t;
    if(txt(r['Surtido_inventario']).toUpperCase() !== 'N') return;   /* solo las que no salieron de inventario */
    if(refs[k]) return;                                              /* ya tiene referencias */
    var v = viejo[inv[id] + '|' + t];
    var lista = v ? partirLista(v['Por_pedir']) : [];
    if(!lista.length){ sinDato.push(k); return; }
    lista.forEach(function(ref){
      var c = prod[ref.toLowerCase()];
      nuevas.push({ P_num:id, Tipo:t, Referencia:(c ? c.v : ref),
        Descripcion:(c ? (c.d || '') : '(de la version vieja · no es un codigo del catalogo)'),
        Como_se_suple:(txt(r['Hay_MP']).toUpperCase() === 'S' ? 'FABRICAR' : (t === 'R' ? 'PEDIR_PRODUCTO' : 'ESPERA_MP')),
        Origen:'MIGRACION', Motivo_novedad:'',
        Se_suplio:(txt(r['Completo']).toUpperCase() === 'S' ? 'S' : (txt(r['tl']) ? 'N' : '')),
        Estado_registro:txt(r[COL_EST]).toUpperCase() === E_ANU ? E_ANU : E_VIG });
    });
  });
  L('Referencias que se pueden recuperar del respaldo: ' + nuevas.length);
  nuevas.forEach(function(n){
    L('  ' + n.P_num + '/' + n.Tipo + '  ' + n.Referencia + '  ' + n.Como_se_suple + '  se_suplio=' + (n.Se_suplio || 'en proceso'));
    L('      ' + n.Descripcion);
  });
  if(sinDato.length){
    L('');
    L('Sin dato en el respaldo (se crearon despues de la migracion): ' + sinDato.join(', '));
    L('   Esas hay que registrarlas desde la app: inhabilita el pedido y vuelvelo a crear,');
    L('   o escribe su fila a mano en R2_Detalle.');
  }
  if(soloSimular){ L('=== FIN DE LA SIMULACION · no se escribio nada ==='); return log.join('\n'); }
  nuevas.forEach(function(n){
    escribirFila({ hoja:H.prepDet, selloSoloNueva:true,
      claves:[{ columna:'P_num', valor:n.P_num }, { columna:'Tipo', valor:n.Tipo }, { columna:'Referencia', valor:n.Referencia }],
      fila:n });
  });
  L('=== CIERRE TERMINADO · ' + nuevas.length + ' referencia(s) recuperadas ===');
  return log.join('\n');
}

/* ===================== PRUEBA Y DIAGNOSTICO ===================== */
var VERSION_BACKEND = 'v5.5.7';

/**
 * Lee el archivo Index.html REAL del proyecto y dice si quedo bien pegado.
 * Es la forma de saber, sin adivinar, si el frontend se actualizo o quedo cortado.
 */
function verificarIndex_(){
  var t;
  try{ t = HtmlService.createHtmlOutputFromFile('Index').getContent(); }
  catch(e){
    Logger.log('NO EXISTE el archivo Index. Debe llamarse exactamente "Index" (con I mayuscula).');
    return;
  }
  var fin = t.replace(/\s+$/, '').slice(-7);
  var ver = (t.match(/VERSION_APP\s*=\s*'([^']+)'/) || [])[1];
  Logger.log('--- VERIFICACION DEL FRONTEND ---');
  Logger.log('Tamano: ' + t.length + ' caracteres' +
    (t.length < 240000 ? '  *** QUEDO CORTADO: el completo de v5.0 pasa de 250.000 ***' : '  (completo)'));
  Logger.log('Termina en: "' + fin + '"   -> ' + (fin === '</html>' ? 'BIEN' : 'MAL: el pegado quedo CORTADO'));
  Logger.log('Version del Index: ' + (ver || 'NO ENCONTRADA -> es un Index viejo o incompleto'));
  Logger.log('Version del Codigo.gs: ' + VERSION_BACKEND);
  Logger.log('Bloques <script> cerrados: ' +
    ((t.split('<script>').length - 1) === (t.split('</script>').length - 1) ? 'SI' : 'NO: falta cerrar alguno'));
  Logger.log('Coinciden las dos versiones: ' +
    (ver === VERSION_BACKEND ? 'SI, estan parejas' : 'NO -> vuelve a pegar el archivo que falte'));
}

function prueba_(){
  Logger.log('Backend ' + VERSION_BACKEND);
  var p = apiPing_();
  Logger.log('Hoja: ' + p.hoja + ' (' + p.pestanas + ' pestanas)');
  var e = apiEstado_();
  Logger.log('Compras: ' + e.compras.length + ' · Detalle: ' + e.detalle.length +
             ' · Partes: ' + e.partes.length + ' · Referencias: ' + e.refs.length +
             ' · Pedidos: ' + e.pedidos.length + ' · Entregas: ' + e.entregas.length);
  Logger.log('Siguiente pedido: ' + nuevoId('P') + ' · Siguiente compra: ' + nuevoId('C'));
  Logger.log('Catalogos: ' + e.catalogos.productos.length + ' productos · ' +
             e.catalogos.materias.length + ' materias primas · ' +
             e.catalogos.clientes.length + ' clientes · ' + e.catalogos.proveedores.length + ' proveedores');
  var conDesc = e.catalogos.productos.filter(function(o){ return !!o.d; }).length;
  Logger.log('Productos con descripcion: ' + conDesc + ' de ' + e.catalogos.productos.length);
  Logger.log('Alineacion R3/R4: ' + (e.pedidos.length === e.entregas.length
    ? 'OK (' + e.pedidos.length + ' = ' + e.entregas.length + ')'
    : 'DESALINEADA: R3=' + e.pedidos.length + ' R4=' + e.entregas.length));
  Logger.log('Alineacion R2: ' + (e.partes.length === e.pedidos.length * 2
    ? 'OK (' + e.partes.length + ' = 2 x ' + e.pedidos.length + ')'
    : 'DESALINEADA: R2=' + e.partes.length + ' deberia ser ' + (e.pedidos.length * 2)));
  var ix = indices(hoja(H.prep));
  var sobra = ['Por_pedir', 'Faltante', 'Ruta'].filter(function(c){ return ix[c] !== undefined; });
  Logger.log('Columnas que ya no se usan en R2: ' + (sobra.length ? sobra.join(', ') + '  <- puedes eliminarlas' : 'ninguna, correcto'));
  var malas = 0;
  var mats = {}; catalogo(H.materias).forEach(function(o){ mats[o.v.toLowerCase()] = 1; });
  filas(H.prep).forEach(function(r){
    txt(r['Materia_prima_faltante']).split(/\s+-\s+/).forEach(function(x){ if(x.trim() && !mats[x.trim().toLowerCase()]) malas++; });
  });
  Logger.log('Materia_prima_faltante con valores invalidos: ' + (malas ? malas + '  <- corre simularReparacionR2_()' : 'ninguno, correcto'));
}

/* =====================================================================
   =====================================================================
   F A S E   2   ·   F A C T U R A C I O N   E   I N V E N T A R I O
   =====================================================================
   =====================================================================

   NINGUNA TABLA TRANSACCIONAL NUEVA. Eso es lo que hace que Fase 2 no
   rompa Fase 1. Lo que hay es:

     - columnas nuevas en R2_Detalle (cantidades y dinero), en R3
       (descuento global) y en R4 (el documento)
     - columnas nuevas en CAT_Productos (codigo de barras, IVA, precios)
       y en CAT_Clientes (los datos fiscales)
     - tres hojas nuevas, las tres de REGISTRO puro:
         MOV_Inventario  el kardex
         LOG_Cambios     lo que escribe el lapiz de edicion
         CFG_Config      el engranaje

   LA FACTURA NO SE GUARDA, SE COMPONE. Es una proyeccion de
   R2_Detalle + R3 + R4. Es el mismo principio con el que en Fase 1 se
   eliminaron las columnas Ruta, Faltante y Por_pedir: un dato que se
   puede calcular no se almacena, porque almacenarlo crea una segunda
   version de la verdad que tarde o temprano se desincroniza.

   CON UN MATIZ, aplicado con criterio: se almacena el HECHO, nunca el
   CALCULO. El precio unitario SI se congela en la linea, porque no es
   calculable: es un hecho historico. Si se leyera del catalogo, un
   cambio de precio hoy reescribiria las facturas del ano pasado.
   El total de la linea, en cambio, es multiplicacion: no se guarda.

   INVARIANTES QUE ESTE CODIGO HACE CUMPLIR
     I-17  N >= W siempre. Nunca se despacha mas de lo solicitado.
     I-18  El saldo de inventario no se almacena: se suma del kardex.
     I-19  Nunca se bloquea una venta por falta de stock.
     I-20  El consecutivo FISCAL lo pone Alegra. La app solo pone P-###
           y la remision interna R-###.
     I-21  Sin conexion se emite REMISION, nunca factura electronica.
     I-22  El dinero se redondea por LINEA y TOTAL = suma de lineas.
   ===================================================================== */

var VERSION_FASE2 = 'f2.2';

/* Las columnas que Fase 2 agrega a las hojas que ya existian.
   Se agregan al FINAL de la fila de titulos: como todo el acceso es por
   NOMBRE de columna y no por posicion, el orden es indiferente para el
   codigo, y agregar al final no mueve ni un dato de lo que ya habia. */
var COLS_F2 = {
  /* Inv_confiable NO esta: la confiabilidad del saldo se CALCULA del
     historial de conteos del kardex. Almacenarla iria contra la regla del
     proyecto (no se guarda lo que se puede calcular) y, peor, diria que el
     inventario de un producto "no cuenta", cuando el inventario cuenta
     siempre: entra con las compras y sale con los despachos. */
  'CAT_Productos':  ['Codigo_barras', 'IVA', 'Precio_mayorista',
                     'Precio_minorista', 'Costo'],
  'CAT_Clientes':   ['Tipo_identificacion', 'Numero_identificacion',
                     'Forma_pago', 'Medio_pago', 'Vendedor'],
  'R1_Detalle':     ['Cant_recibida', 'Fecha_recepcion'],
  'R2_Detalle':     ['Cant_solicitada', 'Cant_despachada', 'Precio_unitario',
                     'Descuento_pct', 'IVA_pct', 'Origen_M'],
  'R3_Pedidos':     ['Descuento_global_pct'],
  /* Los datos de pago viven en R4 y no en CAT_Clientes porque son del
     DOCUMENTO, no del cliente: el mismo cliente puede comprar de contado hoy
     y a credito la semana entrante. CAT_Clientes guarda lo habitual, y R4
     guarda lo que de verdad se pacto en esta venta. */
  'R4_Entregas':    ['Doc_tipo', 'Doc_numero', 'Doc_fecha', 'Doc_estado',
                     'Forma_pago', 'Medio_pago', 'Plazo_dias', 'Vencimiento',
                     /* v5.3 · el vendedor que firma ESTE documento (punto 3) */
                     'Doc_vendedor']
};

/* Las hojas nuevas, con sus titulos. Las tres llevan las 4 columnas de
   control al final, igual que R1..R4, menos LOG_Cambios y CFG_Config:
   un log no se anula, se lee. */
var HOJAS_F2 = {
  'MOV_Inventario': ['Mov_num', 'Fecha', 'Codigo', 'Descripcion', 'Tipo_mov',
                     'Cantidad', 'Origen_doc', 'Operador', 'Observacion',
                     COL_EST, COL_MOT, COL_POR, COL_CUA],
  'LOG_Cambios':    ['Log_num', 'Fecha', 'Tabla', 'Registro', 'Campo',
                     'Valor_antes', 'Valor_despues', 'Operador', 'Motivo'],
  'CFG_Config':     ['Clave', 'Valor', 'Descripcion']
};

/* Los tipos de movimiento del kardex. Lista cerrada a proposito: si
   cualquiera pudiera inventar un tipo, el saldo dejaria de ser auditable. */
var MOVS = ['ENTRADA_COMPRA', 'ENTRADA_FABRICACION', 'SALIDA_DESPACHO',
            'AJUSTE_CONTEO', 'AJUSTE_DISCREPANCIA', 'SALIDA_BAJA'];


/* =====================================================================
   DINERO  ·  el mismo algoritmo que corre en el navegador y en Python
   =====================================================================
   Los tres tienen que dar EXACTAMENTE el mismo peso. Por eso el
   redondeo se escribe aqui explicito en vez de usar la funcion de turno
   de cada lenguaje: Math.round() de JavaScript hace floor(x+0.5) y
   round() de Python hace redondeo bancario. Son distintos en los
   empates, y un empate de medio peso descuadra la factura. */

function pesoCO(x){
  var n = Number(x);
  if(!isFinite(n)) return 0;
  return Math.floor(n + 0.5);
}

/**
 * Calcula la factura de un pedido. REGLA I-22.
 *
 * lineas = [{codigo, precio_unitario, cant_despachada, descuento_pct, iva_pct}]
 *
 * Solo entran las lineas con cantidad despachada > 0: se factura lo que
 * SALIO, no lo que se pidio. Un producto que todavia no salio de la
 * bodega no se le puede cobrar a nadie.
 */
function calcularFactura(lineas, descuentoGlobalPct){
  var activas = (lineas || []).filter(function(l){ return Number(l.cant_despachada) > 0; });
  var bases = [], descs = [], netas = [], i;

  for(i = 0; i < activas.length; i++){
    var b = Number(activas[i].precio_unitario) * Number(activas[i].cant_despachada);
    var d = pesoCO(b * Number(activas[i].descuento_pct || 0) / 100);
    bases.push(b); descs.push(d); netas.push(b - d);
  }

  /* --- reparto del descuento global ---------------------------------
     El error clasico: repartir_ con redondeo linea por linea y que la
     suma de los pedazos no de el descuento total, con lo que la factura
     queda descuadrada por uno o dos pesos. Aqui el residuo se le asigna
     COMPLETO a la linea de mayor valor, de modo que la suma de los
     pedazos es exactamente el descuento global. Es la unica forma de que
     TOTAL = suma de lineas. */
  var pct = Number(descuentoGlobalPct || 0), total = 0, pedazos = [], objetivo = 0;
  for(i = 0; i < netas.length; i++) total += netas[i];
  for(i = 0; i < netas.length; i++) pedazos.push(0);
  if(pct > 0 && total > 0){
    objetivo = pesoCO(total * pct / 100);
    var suma = 0, mayor = 0;
    for(i = 0; i < netas.length; i++){
      pedazos[i] = pesoCO(objetivo * netas[i] / total);
      suma += pedazos[i];
      if(netas[i] > netas[mayor]) mayor = i;
    }
    pedazos[mayor] += objetivo - suma;        /* el residuo, completo, a la linea mayor */
  }

  var det = [], subtotal = 0, iva = 0, descLineas = 0;
  for(i = 0; i < activas.length; i++){
    var st = pesoCO(bases[i] - descs[i] - pedazos[i]);
    var iv = pesoCO(st * Number(activas[i].iva_pct || 0) / 100);
    subtotal += st; iva += iv; descLineas += descs[i];
    det.push({
      codigo: activas[i].codigo,
      cant_despachada: Number(activas[i].cant_despachada),
      precio_unitario: Number(activas[i].precio_unitario),
      descuento_pct: Number(activas[i].descuento_pct || 0),
      iva_pct: Number(activas[i].iva_pct || 0),
      base: pesoCO(bases[i]),
      descuento_linea: descs[i],
      descuento_global_linea: pedazos[i],
      subtotal: st, iva: iv, total_linea: st + iv,
      /* el descuento EFECTIVO de la linea: lo propio mas el pedazo del
         global. Es lo que hay que mandarle a Alegra, porque su plantilla
         tiene un solo campo de descuento por linea y no sabe nada de
         descuentos globales. */
      descuento_efectivo_pct: bases[i] > 0
        ? (descs[i] + pedazos[i]) / bases[i] * 100 : 0
    });
  }
  return { lineas:det, descuento_lineas:descLineas, descuento_global:objetivo,
           subtotal:subtotal, iva:iva, total:subtotal + iva };
}

/** La factura de un pedido que ya esta en la hoja. */
/* =====================================================================
   v5.1 · C1 · DOS AYUDANTES PARA NO LEER LA MISMA HOJA EN UN BUCLE
   =====================================================================
   indicePor_ devuelve {llave: primera fila}, agrupaPor_ devuelve
   {llave: [todas las filas]}. Con ellos, una funcion lee cada hoja UNA
   vez al principio y despues consulta en memoria. No cambian ningun
   calculo: solo cambian de donde sale el dato.
   ===================================================================== */
function indicePor_(lista,campo){
  var out={};
  (lista||[]).forEach(function(r){var k=txt(r[campo]);if(k&&out[k]===undefined)out[k]=r;});
  return out;
}
function agrupaPor_(lista,campo){
  var out={};
  (lista||[]).forEach(function(r){var k=txt(r[campo]);if(!k)return;(out[k]=out[k]||[]).push(r);});
  return out;
}

/* v5.1 · C1 · apiFactura_ acepta un contexto OPCIONAL con las hojas ya
   leidas. Sin contexto se comporta exactamente como antes, asi que todas
   las llamadas que existen hoy siguen siendo validas sin tocarlas.
   El calculo es el mismo: calcularFactura sobre las mismas lineas. */
function apiFactura_(pid, ctx){
  var det, ped;
  if(ctx && ctx.detPorPedido){
    det = (ctx.detPorPedido[txt(pid)] || []).filter(function(r){
      return txt(r[COL_EST]).toUpperCase() !== E_ANU;
    });
    ped = ctx.pedPorNum ? ctx.pedPorNum[txt(pid)] : buscarEn(filas(H.pedidos), 'P_num', txt(pid));
  }else{
    det = filas(H.prepDet).filter(function(r){
      return txt(r['P_num']) === txt(pid) && txt(r[COL_EST]).toUpperCase() !== E_ANU;
    });
    ped = buscarEn(filas(H.pedidos), 'P_num', txt(pid));
  }
  /* =====================================================================
     PUNTO 4 · LA FACTURA ES UNA PROYECCION DE R2_Detalle
     =====================================================================
     El precio con el que se cobra es el de la LINEA DEL PEDIDO. Si el
     operador lo corrigio en Facturacion, la linea dice ese precio y el
     total del pedido se calcula con ese precio: se vendio a ese valor y
     asi tiene que quedar registrado.

     LO QUE NO SE TOCA DESDE AQUI, NUNCA, POR NINGUNA RUTA, es
     CAT_Productos. Si el producto vale 35.000 en el catalogo y esta venta
     se hizo a 300, el catalogo sigue diciendo 35.000 y el siguiente pedido
     sale a 35.000. El unico sitio que edita el catalogo es
     apiEditarProducto_, que exige motivo y deja registro aparte.
     heralsaRevisarLogica() comprueba que esto se cumpla.
     ===================================================================== */
  var lineas = det.map(function(r){
    return { codigo:txt(r['Referencia']), precio_unitario:numero(r['Precio_unitario']) || 0,
             cant_despachada:numero(r['Cant_despachada']) || 0,
             descuento_pct:numero(r['Descuento_pct']) || 0,
             iva_pct:numero(r['IVA_pct']) || 0 };
  });
  var f = calcularFactura(lineas, ped ? numero(ped['Descuento_global_pct']) || 0 : 0);
  f.pedido = txt(pid);
  f.cliente = ped ? txt(ped['Cliente']) : '';
  f.canal = ped ? txt(ped['Canal']) : '';
  return f;
}


/* =====================================================================
   VALIDACION DE LAS LINEAS  ·  I-17 y I-19
   =====================================================================
   El servidor NO confia en el celular. Aunque la app impida escribir
   W > N en el teclado, aqui se vuelve a comprobar: un celular con una
   version vieja, o una peticion repetida, no pueden meter una linea
   imposible en la hoja. */

function validarLineas(lineas){
  var errores = [];
  (lineas || []).forEach(function(l, i){
    var n = numero(l['Cant_solicitada']);
    var w = numero(l['Cant_despachada']);
    var ref = txt(l['Referencia']) || ('linea ' + (i + 1));
    if(n === '' || n === null) n = 0;
    if(w === '' || w === null) w = 0;

    /* I-17 */
    if(w > n) errores.push(ref + ': se despacharon ' + w + ' y solo se pidieron ' + n +
                           '. No se puede entregar mas de lo que el cliente pidio.');
    if(n < 0 || w < 0) errores.push(ref + ': las cantidades no pueden ser negativas.');

    /* INVENTARIO exige W == N: si falta algo, la linea NO salio de bodega */
    var como = txt(l['Como_se_suple']).toUpperCase();
    if(como === 'INVENTARIO' && w !== n)
      errores.push(ref + ': dice que salio de inventario pero se despacharon ' + w +
                   ' de ' + n + '. Si falto algo, la linea no salio de bodega: ' +
                   'tiene que decir como se va a suplir.');
    if(como && como !== 'INVENTARIO' && ['FABRICAR', 'ESPERA_MP', 'PEDIR_PRODUCTO'].indexOf(como) < 0)
      errores.push(ref + ': "' + como + '" no es una forma valida de suplir.');

    /* el dinero tiene que ser dinero */
    var p = numero(l['Precio_unitario']);
    if(p !== '' && p < 0) errores.push(ref + ': el precio no puede ser negativo.');
    var d = numero(l['Descuento_pct']);
    if(d !== '' && (d < 0 || d > 100)) errores.push(ref + ': el descuento tiene que estar entre 0 y 100 %.');
  });
  return errores;
}


/* =====================================================================
   CREAR EL PEDIDO CON SUS LINEAS  ·  todo en una operacion bloqueada
   =====================================================================
   Extiende apiCrearPedido_() sin tocarlo: crea el expediente igual que en
   Fase 1 (R3 + 2 de R2 + R4) y ADEMAS escribe las lineas de R2_Detalle.
   Una sola llamada, un solo candado: no hay forma de que quede un pedido
   con numero y sin lineas, ni lineas sin pedido. */

function apiCrearPedidoF2_(fila3, lineas, filasPrep){
  var errores = validarLineas(lineas);
  if(errores.length) return { ok:false, errores:errores };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    var id = nuevoId('P'), f = {}, k;
    for(k in (fila3 || {})) f[k] = fila3[k];
    f['P_num'] = id;
    f[COL_EST] = E_VIG;
    var r3 = escribirFila({ hoja:H.pedidos, claves:[{ columna:'P_num', valor:id }], fila:f });

    /* las 2 filas de R2 y la de R4 nacen con el pedido, igual que en Fase 1 */
    var cli = f['Cliente'] || '', can = f['Canal'] || '';
    var porTipo = {};
    (filasPrep || []).forEach(function(p){ porTipo[txt(p['Tipo']).toUpperCase()] = p; });

    var filasR2 = {};
    ['F', 'R'].forEach(function(t){
      var base = { P_num:id, Tipo:t, Estado_registro:E_PEND };
      if(porTipo[t]){
        for(k in porTipo[t]) base[k] = porTipo[t][k];
        base['P_num'] = id; base['Tipo'] = t;
        if(!base[COL_EST]) base[COL_EST] = E_VIG;
      }
      var r = escribirFila({ hoja:H.prep, noSello:!porTipo[t],
        claves:[{ columna:'P_num', valor:id }, { columna:'Tipo', valor:t }], fila:base });
      filasR2[t] = r.fila;
    });

    var r4 = escribirFila({ hoja:H.entregas, noSello:true,
      claves:[{ columna:'P_num', valor:id }],
      fila:{ P_num:id, Cliente:cli, Canal:can, Estado_registro:E_PEND } });

    /* las lineas */
    var nl = 0;
    (lineas || []).forEach(function(l){
      var d = {}; for(var kk in l) d[kk] = l[kk];
      d['P_num'] = id;
      if(!d[COL_EST]) d[COL_EST] = E_VIG;
      if(!d['Origen']) d['Origen'] = 'PASO_2';
      escribirFila({ hoja:H.prepDet, selloSoloNueva:true,
        claves:[{ columna:'P_num', valor:id }, { columna:'Tipo', valor:d['Tipo'] },
                { columna:'Referencia', valor:d['Referencia'] }], fila:d });
      nl++;
    });

    return { ok:true, id:id, lineas:nl,
             filas:{ pedido:r3.fila, parteF:filasR2['F'], parteR:filasR2['R'], entrega:r4.fila } };
  } finally { lock.releaseLock(); }
}


/* =====================================================================
   KARDEX  ·  el saldo se SUMA, no se guarda  (I-18)
   ===================================================================== */

/** Consecutivo de una hoja cuya primera columna es un codigo PREFIJO-#### */
function nuevoConsecutivo(nombreHoja, prefijo, digitos){
  var sh = libro().getSheetByName(nombreHoja);
  if(!sh || sh.getLastRow() < 2) return prefijo + '-' + ceros2(1, digitos);
  var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues(), max = 0;
  for(var i = 0; i < ids.length; i++){
    var m = String(ids[i][0]).match(/-(\d+)\s*$/);
    if(m) max = Math.max(max, parseInt(m[1], 10));
  }
  return prefijo + '-' + ceros2(max + 1, digitos);
}
function ceros2(n, d){ var s = String(n); while(s.length < d) s = '0' + s; return s; }

/**
 * Registra uno o varios movimientos de inventario.
 *
 * I-19: esta funcion NUNCA rechaza un movimiento por dejar el saldo
 * negativo. Un sistema de inventario no debe tener autoridad para
 * cancelar una venta: el saldo probablemente este mal, y el dato malo se
 * corrige, la venta no se pierde. Lo que SI hace es devolver los
 * negativos que quedaron, para que la app los muestre y el producto
 * quede marcado como no confiable.
 */
function apiMover_(movs, operador){
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    asegurarHoja(H.mov);
    var n = nuevoConsecutivo(H.mov, 'M', 4);
    var num = parseInt(n.replace(/\D/g, ''), 10);
    var desc = {};
    catalogo(H.productos, 'Descripcion').forEach(function(o){ desc[o.v] = o.d || ''; });
    catalogo(H.materias, 'Descripcion').forEach(function(o){ desc[o.v] = o.d || ''; });

    var malos = [], buenos = [], repetidos = 0, huellas = {};
    function huellaMov_(x){
      return [txt(x.Fecha),txt(x.Codigo).toUpperCase(),txt(x.Tipo_mov).toUpperCase(),
        numero(x.Cantidad)||0,txt(x.Origen_doc),txt(x.Observacion)].join('|');
    }
    filas(H.mov).forEach(function(x){
      if(txt(x.Estado_registro).toUpperCase()!==E_ANU)huellas[huellaMov_(x)]=true;
    });
    (movs || []).forEach(function(m){
      var tipo = txt(m.Tipo_mov || m.tipo).toUpperCase();
      if(MOVS.indexOf(tipo) < 0){ malos.push('"' + tipo + '" no es un tipo de movimiento valido'); return; }
      var cod = txt(m.Codigo || m.codigo).toUpperCase();
      if(!cod){ malos.push('hay un movimiento sin codigo de producto'); return; }
      var candidato={
        Mov_num:'M-' + ceros2(num, 4),
        Fecha: txt(m.Fecha || m.fecha) || ahora(),
        Codigo: cod, Descripcion: desc[cod] || '',
        Tipo_mov: tipo, Cantidad: numero(m.Cantidad === undefined ? m.cantidad : m.Cantidad) || 0,
        Origen_doc: txt(m.Origen_doc || m.origen),
        Operador: txt(operador || m.Operador || m.operador),
        Observacion: txt(m.Observacion || m.obs),
        Estado_registro: E_VIG
      };
      var huella=huellaMov_(candidato);
      if(huellas[huella]){repetidos++;return;}
      huellas[huella]=true;num++;buenos.push(candidato);
    });

    if(buenos.length) anexarBloque(H.mov, HOJAS_F2['MOV_Inventario'], buenos);
    var s = apiSaldos_();
    var negativos = [];
    buenos.forEach(function(b){
      if(s.saldos[b.Codigo] < 0 && negativos.indexOf(b.Codigo) < 0) negativos.push(b.Codigo);
    });
    return { ok:true, escritos:buenos.length, repetidos:repetidos, rechazados:malos, negativos:negativos };
  } finally { lock.releaseLock(); }
}

/** El saldo de cada producto: la SUMA de su kardex. Nunca se almacena. */
function apiSaldos_(){
  var s = {}, porTipo = {}, ultimo = {};
  filas(H.mov).forEach(function(m){
    if(txt(m[COL_EST]).toUpperCase() === E_ANU) return;   /* lo anulado no cuenta */
    var c = txt(m['Codigo']).toUpperCase();
    if(!c) return;
    var q = numero(m['Cantidad']) || 0;
    s[c] = (s[c] || 0) + q;
    var t = txt(m['Tipo_mov']).toUpperCase();
    porTipo[t] = (porTipo[t] || 0) + q;
    var f = txt(m['Fecha']);
    if(!ultimo[c] || f > ultimo[c]) ultimo[c] = f;
  });
  var neg = [];
  for(var k in s) if(s[k] < 0) neg.push(k);
  return { saldos:s, porTipo:porTipo, ultimoMov:ultimo, negativos:neg,
           productos:Object.keys(s).length };
}


/* =====================================================================
   LOG DE CAMBIOS  ·  lo que hace seguro el lapiz de edicion
   =====================================================================
   Entregarle al operador un lapiz para corregir el precio o el tipo de
   un producto es comodo y es peligroso. Lo que lo vuelve seguro es que
   todo cambio queda escrito: que campo, de que valor a que valor, quien
   y cuando. Sin esto, el lapiz seria una forma de perder el rastro. */

function apiLogCambio_(cambios, operador){
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    asegurarHoja(H.log);
    var n = nuevoConsecutivo(H.log, 'L', 4);
    var num = parseInt(n.replace(/\D/g, ''), 10);
    var filasNuevas = (cambios || []).map(function(c){
      return {
        Log_num:'L-' + ceros2(num++, 4), Fecha: txt(c.Fecha) || ahora(),
        Tabla: txt(c.Tabla), Registro: txt(c.Registro), Campo: txt(c.Campo),
        Valor_antes: c.Valor_antes === undefined ? '' : c.Valor_antes,
        Valor_despues: c.Valor_despues === undefined ? '' : c.Valor_despues,
        Operador: txt(operador || c.Operador), Motivo: txt(c.Motivo)
      };
    });
    if(filasNuevas.length) anexarBloque(H.log, HOJAS_F2['LOG_Cambios'], filasNuevas);
    return { ok:true, escritos:filasNuevas.length };
  } finally { lock.releaseLock(); }
}

/**
 * Edita un dato del catalogo de productos Y lo deja logueado, en una sola
 * operacion. Si el log fallara, el cambio no se hace: no se admite un
 * cambio sin rastro.
 */
function apiEditarProducto_(codigo, campo, valor, operador, motivo){
  if(!txt(motivo)) return { ok:false, error:'Explica el motivo del cambio; sin motivo no se edita el producto.' };
  var permitidos = ['Descripcion', 'Tipo_trabajo', 'Unidad', 'Punto_reorden',
                    'Codigo_barras', 'IVA', 'Precio_mayorista', 'Precio_minorista',
                    'Costo', 'Activo'];
  if(permitidos.indexOf(campo) < 0)
    return { ok:false, error:'El campo "' + campo + '" no se puede editar desde la app.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    var sh = hoja(H.productos), idx = indices(sh);
    if(idx[campo] === undefined)
      return { ok:false, error:'La hoja CAT_Productos no tiene la columna "' + campo +
                               '". Corre migrarFase2_() primero.' };
    var fila = buscarFila(sh, idx, [{ columna:'Codigo', valor:codigo }]);
    if(!fila) return { ok:false, error:'El producto ' + codigo + ' no esta en el catalogo.' };

    var antes = sh.getRange(fila, idx[campo] + 1).getValue();
    if(txt(antes) === txt(valor)) return { ok:true, sinCambio:true };

    /* el tipo de trabajo solo admite F, R o M */
    if(campo === 'Tipo_trabajo' && txt(valor) && ['F', 'R', 'M'].indexOf(txt(valor).toUpperCase()) < 0)
      return { ok:false, error:'El tipo de trabajo solo puede ser F, R o M.' };
    /* el IVA solo admite las tasas que existen en Colombia */
    if(campo === 'IVA' && [0, 5, 19].indexOf(numero(valor)) < 0)
      return { ok:false, error:'El IVA solo puede ser 0 (excluido), 5 o 19.' };

    sh.getRange(fila, idx[campo] + 1).setValue(valor);
    apiLogCambio_([{ Tabla:'CAT_Productos', Registro:codigo, Campo:campo,
                    Valor_antes:antes, Valor_despues:valor, Motivo:motivo }], operador);
    return { ok:true, antes:antes, despues:valor };
  } finally { lock.releaseLock(); }
}


/* =====================================================================
   CONFIGURACION  ·  el engranaje
   =====================================================================
   El engranaje fija la POLITICA GENERAL (de donde sale la cantidad
   disponible W) cuando el saldo de la hoja y la bodega no coinciden.
   En los DOS modos el inventario se mueve igual: entra con las compras y sale
   con los despachos. Lo que el modo decide es a quien se le cree, no si el
   inventario existe. */

var CFG_DEF = {
  inventario_modo: 'SHEETS',
  mostrar_iva: 'S',
  permitir_venta_sin_stock: 'S',
  doc_offline: 'REMISION',
  prefijo_remision: 'R',
  canal_precio_M: 'Precio_mayorista',
  canal_precio_R: 'Precio_minorista'
};

function apiConfig_(){
  var c = {}, k;
  for(k in CFG_DEF) c[k] = CFG_DEF[k];
  filas(H.cfg).forEach(function(r){
    var clave = txt(r['Clave']);
    if(clave) c[clave] = txt(r['Valor']);
  });
  return c;
}

function apiGuardarConfig_(clave, valor, operador){
  var validos = {
    inventario_modo: ['SHEETS', 'OPERADOR'],
    mostrar_iva: ['S', 'N'],
    /* v5.5.7 · BUG_034 · solo 'S'. Antes admitia 'N' y NADIE leia el valor:
       se podia guardar «no permitir venta sin stock» y el sistema seguia
       permitiendola, porque el invariante I-19 dice que nunca se bloquea una
       venta por falta de stock. Una opcion que se puede cambiar y no cambia
       nada es una mentira guardada en la hoja. El navegador ya la muestra
       como no conmutable; ahora el servidor dice lo mismo. */
    permitir_venta_sin_stock: ['S'],
    doc_offline: ['REMISION']          /* I-21: no hay otra opcion posible */
  };
  if(validos[clave] && validos[clave].indexOf(txt(valor).toUpperCase()) < 0)
    return { ok:false, error:'"' + valor + '" no es un valor valido para ' + clave +
                             '. Admite: ' + validos[clave].join(' o ') + '.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    asegurarHoja(H.cfg);
    var antes = apiConfig_()[clave];
    escribirFila({ hoja:H.cfg, noSello:true, claves:[{ columna:'Clave', valor:clave }],
      fila:{ Clave:clave, Valor:valor } });
    apiLogCambio_([{ Tabla:'CFG_Config', Registro:clave, Campo:'Valor',
                    Valor_antes:antes, Valor_despues:valor,
                    Motivo:'Cambio de configuracion desde la app' }], operador);
    return { ok:true, clave:clave, valor:valor };
  } finally { lock.releaseLock(); }
}


/* =====================================================================
   DOCUMENTOS  ·  remision o factura electronica  (I-20, I-21)
   =====================================================================
   La app NUNCA inventa un numero fiscal. Pone el consecutivo interno de
   remision (R-###) y nada mas. El numero de la factura electronica lo
   pone Alegra cuando se sube el archivo, y por eso para una FE la app
   deja el numero VACIO y el estado POR_FACTURAR. */

/* =====================================================================
   v5.5 · BUG_012 · EL CANDADO ANIDADO QUE SE SOLTABA SOLO
   =====================================================================
   El ScriptLock de Apps Script es UNO y es GLOBAL, y NO es reentrante.
   apiDocumento_ tomaba el candado y, ya dentro de su seccion critica,
   llamaba a esta funcion, que volvia a pedir el MISMO candado y lo
   LIBERABA en su propio finally. Al volver de la llamada, el resto de la
   seccion critica de apiDocumento_ -- comprobar que no hay documento y
   escribir la fila -- seguia corriendo SIN candado.
   CONSECUENCIA: la pareja «comprobar duplicado» y «escribir» dejaba de ser
   atomica, asi que dos toques seguidos podian pasar los dos por la guarda y
   quemar dos numeros de remision. Y si Apps Script no reconcedia el
   candado, saltaba «Lock timeout» a los 20 segundos.
   LA SOLUCION no es un candado reentrante -- no existe aqui -- es no
   anidarlo: el calculo vive en una funcion SIN candado, para usarla dentro
   de una seccion critica que ya lo tiene, y la envoltura con candado queda
   para quien llame desde fuera.

   v5.5 · BUG_011 · Y SE CUENTA SOBRE LA HOJA CRUDA, NO SOBRE filas()
   =====================================================================
   El numero de remision no se guarda en ningun contador: se DEDUCE del
   maximo Doc_numero que haya en R4. Si se cuenta con filas(), que descarta
   las filas con la primera columna vacia, un numero ya entregado puede
   quedar escondido y el sistema lo repartiria OTRA VEZ a un pedido
   distinto. Dos remisiones con el mismo numero no se arreglan borrando:
   hay que anular. Asi que se lee la columna completa, incluidas las filas
   anuladas y cualquier fila sin clave: un numero usado NUNCA se reutiliza.
   ===================================================================== */
function nuevaRemisionSinLock_(){
  var pref = apiConfig_().prefijo_remision || 'R';
  var sh = hoja(H.entregas), idx = indices(sh), ultima = sh.getLastRow();
  var usados = 0;
  if(idx['Doc_numero'] !== undefined && ultima > 1){
    var col = sh.getRange(2, idx['Doc_numero'] + 1, ultima - 1, 1).getValues();
    var re = new RegExp('^' + pref + '-(\\d+)$');
    for(var i = 0; i < col.length; i++){
      var m = String(txt(col[i][0])).match(re);
      if(m) usados = Math.max(usados, parseInt(m[1], 10));
    }
  }
  return pref + '-' + ceros2(usados + 1, 3);
}
function apiNuevaRemision_(){
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{ return nuevaRemisionSinLock_(); }
  finally { lock.releaseLock(); }
}

/**
 * Marca el documento de una entrega. Es la decision que se toma en el
 * computador: remision o factura electronica.
 */
/* Las listas de Alegra. Si se manda un valor que no esta en su lista, Alegra
   rechaza el archivo COMPLETO, asi que se validan aqui y no se confia en que
   la app los mande bien. */
var AL_FORMA = ['Contado', 'Credito'];
var AL_MEDIO = ['Efectivo', 'Transferencia debito', 'Consignacion bancaria',
                'Credito ACH', 'Debito ACH', 'Instrumento no definido'];

function apiDocumento_(pid, tipo, operador, pago){
  tipo = txt(tipo).toUpperCase();
  if(['REMISION', 'FE'].indexOf(tipo) < 0)
    return { ok:false, error:'El documento solo puede ser REMISION o FE.' };

  /* --- la forma y el medio de pago tienen que ser de la lista de Alegra --- */
  pago = pago || {};
  var forma = txt(pago.forma) || 'Contado';
  var medio = txt(pago.medio) || 'Efectivo';
  if(AL_FORMA.indexOf(forma) < 0)
    return { ok:false, error:'"' + forma + '" no es una forma de pago valida. ' +
             'Alegra admite: ' + AL_FORMA.join(' o ') + '.' };
  if(AL_MEDIO.indexOf(medio) < 0)
    return { ok:false, error:'"' + medio + '" no es un medio de pago valido. ' +
             'Alegra admite: ' + AL_MEDIO.join(', ') + '.' };
  var plazo = numero(pago.plazo) || 0;
  var esCredito = forma.toUpperCase().indexOf('CRED') === 0;
  if(esCredito && plazo <= 0)
    return { ok:false, error:'Una venta a credito tiene que decir en cuantos dias se cobra.' };
  if(!esCredito && plazo > 0)
    return { ok:false, error:'Una venta de contado no puede tener plazo.' };

  var f = apiFactura_(pid);
  if(!f.lineas.length)
    return { ok:false, error:'El pedido ' + pid + ' no tiene ninguna linea despachada. ' +
                             'No se puede emitir un documento sin nada que cobrar.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    /* Si la hoja no esta migrada, escribirFila ignoraria estas columnas en
       silencio y la funcion diria que emitio un documento que no quedo escrito
       en ninguna parte. Peor: al no quedar escrito, el pedido se podria emitir
       otra vez. Mejor fallar fuerte y decir exactamente que hay que hacer. */
    var ixE = indices(hoja(H.entregas));
    var faltan = ['Doc_tipo', 'Doc_numero', 'Doc_fecha', 'Doc_estado']
      .filter(function(c){ return ixE[c] === undefined; });
    if(faltan.length)
      return { ok:false, error:'R4_Entregas no tiene la(s) columna(s) ' + faltan.join(', ')
               + '. Ejecuta instalarHeralsa() una vez y vuelve a intentar.' };

    var ya = buscarEn(filas(H.entregas), 'P_num', txt(pid));
    var cabDoc = buscarEn(filas(H.pedidos), 'P_num', txt(pid));
    /* =================================================================
       v5.5 · BUG_016 · UN MENSAJE POR CAUSA
       =================================================================
       Las tres condiciones de abajo estaban en un solo `if` con un solo
       mensaje: «todavia no esta LISTO. Primero termina Finalizar». Si la
       causa real era que faltaba la fila de R4, el operador iba a
       Finalizar, lo encontraba cerrado y no tenia nada que hacer: el
       mensaje lo mandaba a un sitio donde no estaba el problema. Un error
       que no dice que pasa no es un error, es un estorbo.
       ================================================================= */
    if(!cabDoc)
      return { ok:false, error:'El pedido ' + pid + ' no existe en R3_Pedidos. No se puede emitir un ' +
               'documento de un pedido que no esta registrado.' };
    if(!ya)
      return { ok:false, error:'El pedido ' + pid + ' no tiene fila en R4_Entregas, y ahi es donde vive el ' +
               'documento. Esa fila se crea con el pedido: si falta, ejecute heralsaRevisarLogica() y avise. ' +
               'No es algo que se arregle desde Finalizar.' };
    var estCab_ = txt(cabDoc.Estado).toUpperCase();
    if(estCab_ !== 'LISTO' && estCab_ !== 'ENTREGADO')
      return { ok:false, error:'El pedido ' + pid + ' esta en "' + (txt(cabDoc.Estado) || '(vacio)') +
               '" y para emitir tiene que estar LISTO. Termine el cierre en 4 Finalizar.' };
    /* =================================================================
       v5.5.1 · BUG_020 · ESTE «NO» TIENE QUE SER UTIL, NO SOLO CORRECTO
       =================================================================
       Negarse a emitir dos veces estaba bien. Lo que faltaba es DECIR que
       el documento ya existe de forma que el navegador pueda converger:
       si una emision sin señal se encola y la respuesta se pierde, el
       reintento llega aqui, y con un error pelado el navegador no sabe si
       fracaso o si ya estaba hecho. Con ya_emitido y el documento de la
       hoja, adopta el numero que YA existe en vez de intentarlo otra vez.
       Reintentar deja de poder duplicar, y la cola no se atasca.
       ================================================================= */
    if(txt(ya['Doc_tipo']) || txt(ya['Doc_numero']))
      return { ok:false, ya_emitido:true,
               doc:{ tipo:txt(ya['Doc_tipo']), numero:txt(ya['Doc_numero']),
                     fecha:txt(ya['Doc_fecha']), estado:txt(ya['Doc_estado']),
                     forma:txt(ya['Forma_pago']), medio:txt(ya['Medio_pago']),
                     plazo:numero(ya['Plazo_dias']) || 0, vence:txt(ya['Vencimiento']),
                     vendedor:txt(ya['Doc_vendedor']) },
               error:'El pedido ' + pid + ' ya tiene una decisión documental ' +
                               (txt(ya['Doc_tipo']) || txt(ya['Doc_numero'])) + '. Un pedido es una entrega y un ' +
                               'documento: no se puede emitir dos veces.' };

    /* v5.5 · BUG_012 · sin candado: ya estamos DENTRO del candado (linea de
       waitLock arriba). La version con candado es apiNuevaRemision_, para
       quien la llame desde fuera de una seccion critica. */
    var num = tipo === 'REMISION' ? nuevaRemisionSinLock_() : '';
    var estado = tipo === 'REMISION' ? 'EMITIDO' : 'POR_FACTURAR';
    var vence = esCredito ? (txt(pago.vence) || masDias(txt(ya['te']) || fechaHoy(),plazo)) : '';
    /* =================================================================
       v5.3 · PUNTO 3 · EL VENDEDOR ES DEL DOCUMENTO, NO DEL CLIENTE
       =================================================================
       Antes el vendedor salia de CAT_Clientes.Vendedor: el «habitual» del
       cliente. Por eso en una remision no se podia cambiar sin cambiarselo
       al cliente para siempre. Es el mismo criterio que ya se aplica a la
       forma y el medio de pago, y esta escrito en el comentario de COLS_F2:
       lo del documento vive en R4, lo habitual vive en el catalogo.
       Si no llega vendedor, se deja el que ya tenia la fila; si tampoco,
       queda vacio y el documento imprime el operador. Nunca se inventa.
       ================================================================= */
    var vendedorDoc = txt(pago.vendedor);
    var filaDoc = { P_num:txt(pid),
             Doc_tipo:tipo, Doc_numero:num, Doc_fecha:fechaHoy(), Doc_estado:estado,
             Forma_pago:forma, Medio_pago:medio,
             Plazo_dias: esCredito ? plazo : '',
             Vencimiento:vence,
             /* v5.5 · una fila de R4 con documento emitido es un registro de
                verdad, no el hueco que se crea con el pedido. El navegador ya
                aplicaba este mismo criterio en su proyeccion; el servidor no,
                y por eso la fila se quedaba en PENDIENTE. */
             Estado_registro:E_VIG };
    if(vendedorDoc && ixE['Doc_vendedor'] !== undefined) filaDoc.Doc_vendedor = vendedorDoc;
    var r = escribirFila({ hoja:H.entregas, noSello:true,
      claves:[{ columna:'P_num', valor:pid }],
      fila:filaDoc });
    if(r.bloqueada)
      return { ok:false, error:'El pedido ' + pid + ' esta anulado: no se le puede emitir documento.' };

    /* =================================================================
       v5.5 · BUG_009 · EL EXITO SE DEMUESTRA, NO SE SUPONE
       =================================================================
       Esta funcion devolvia ok:true con el numero de remision mirando
       UNICAMENTE r.bloqueada. escribirFila tambien puede devolver
       {escrita:false} sin bloqueada, y nadie lo comprobaba: el servidor
       confirmaba al operador un documento que podia no haber quedado en
       ninguna parte. Eso es exactamente lo que vio el usuario con P-021:
       la pantalla decia «Remision R-004» y la hoja estaba vacia.
       Ahora se vuelve a LEER la fila y se compara con lo que se quiso
       escribir. Si no coincide, se dice que NO se emitio, con la fila
       fisica para poder ir a verla. Releer cuesta una lectura de hoja; un
       documento fantasma cuesta una anulacion.
       flush() es obligatorio: sin el, la lectura puede responder con el
       estado anterior a la escritura y la comprobacion no valdria nada.
       ================================================================= */
    SpreadsheetApp.flush();
    var compro = buscarEn(filas(H.entregas), 'P_num', txt(pid));
    var okTipo = compro && txt(compro['Doc_tipo']).toUpperCase() === tipo;
    var okNum  = tipo !== 'REMISION' || (compro && txt(compro['Doc_numero']) === num);
    if(!okTipo || !okNum)
      return { ok:false, no_escrito:true,
               error:'NO SE EMITIO. La hoja acepto la orden pero la fila de ' + pid +
                 ' en R4_Entregas no quedo con el documento' +
                 (r.fila ? ' (fila ' + r.fila + ')' : '') + '. ' +
                 'Lo que quedo escrito: Doc_tipo="' + (compro ? txt(compro['Doc_tipo']) : '(no se encontro la fila)') +
                 '", Doc_numero="' + (compro ? txt(compro['Doc_numero']) : '') + '". ' +
                 'El numero ' + (num || '(sin numero)') + ' NO se considera usado. ' +
                 'Ejecute heralsaDiagnosticarDocumento() y avise.' };

    apiLogCambio_([{ Tabla:'R4_Entregas', Registro:pid, Campo:'Doc_tipo',
                    Valor_antes:(ya ? txt(ya['Doc_tipo']) : ''), Valor_despues:tipo,
                    Motivo:'Documento emitido · ' + forma
                      + (esCredito ? ' a ' + plazo + ' dias' : '') + ' · ' + medio }], operador);
    return { ok:true, tipo:tipo, numero:num, total:f.total, estado:estado,
             fecha:fechaHoy(), fila:r.fila,
             forma:forma, medio:medio, plazo:esCredito ? plazo : 0,
             vence:vence, vendedor:vendedorDoc,
             avisoColumna:(vendedorDoc && ixE['Doc_vendedor'] === undefined)
               ? 'R4_Entregas no tiene la columna Doc_vendedor: el vendedor no quedó guardado. Ejecute heralsaCrearColumnasV53().'
               : '' };
  } finally { lock.releaseLock(); }
}

function fechaHoy(){
  return Utilities.formatDate(new Date(), tzLibro_(), 'yyyy-MM-dd');
}


/* =====================================================================
   EXPORTACION A ALEGRA
   =====================================================================
   Los nombres internos de los campos fiscales se escogieron IGUALES a
   los de la plantilla de Alegra (invariante I-23). Por eso esto es una
   proyeccion directa y no una traduccion: menos codigo, y ningun sitio
   donde un nombre se pueda mapear mal.

   EL PUNTO DELICADO Y HONESTO: la plantilla de Alegra tiene UN solo
   campo de descuento por linea y no sabe nada de descuentos globales.
   Por eso se manda el descuento EFECTIVO de cada linea (lo propio mas
   el pedazo del global que le toco). Alegra recalcula el total a partir
   de ese porcentaje, asi que puede diferir del nuestro en algun peso por
   redondeo. Se devuelve tambien nuestro total calculado para que la
   primera subida real se pueda comparar numero contra numero. */

/* =====================================================================
   v5.1 · ENCABEZADOS Y VALORES EXACTOS DE LA PLANTILLA DE ALEGRA
   =====================================================================
   Comparados uno por uno contra la hoja «Plantilla COL» del archivo que
   entrego el usuario. Las diferencias que habia NO eran cosmeticas: si
   Alegra valida el encabezado o el valor de una lista, rechaza el archivo
   entero y el mensaje de error no dice cual columna fue.

   LO QUE ESTABA MAL, columna por columna:
     2  decia  'Fecha del documento*(dd/mm/aaaa)'
        debe   'Fecha del documento* (Formato dd/mm/aaaa)'
     4  decia  'Numeracion*'                 -> 'Numeración*'
     6  decia  'Tipo de identificacion*'     -> 'Tipo de identificación *'
        (la plantilla lleva un espacio ANTES del asterisco en esta columna)
     7  decia  'Numero de identificacion*'   -> 'Número de identificación*'
     8  decia  'Forma de pago'               -> 'Forma de pago*'  (faltaba el *)
     9  decia  'Vencimiento(dd/mm/aaaa)'     -> 'Vencimiento. (Formato dd/mm/aaaa)'
     11 decia  'Item*'                       -> 'Ítem*'
     22 decia  'Terminos y condiciones'      -> 'Términos y condiciones'

   Y en los valores: la plantilla escribe los impuestos con espacios
   alrededor del guion, «IVA - (19%)», y el codigo los emitia pegados,
   «IVA-(19%)». Tambien exige el tipo de identificacion COMPLETO,
   «NIT - Número de identificación tributaria», no solo «NIT».
   ===================================================================== */
var ALEGRA_COLS = ['Fila', 'Fecha del documento* (Formato dd/mm/aaaa)', 'Prefijo', 'Numeración*',
  'Contacto*', 'Tipo de identificación *', 'Número de identificación*', 'Forma de pago*',
  'Vencimiento. (Formato dd/mm/aaaa)', 'Medio de pago*', 'Ítem*', 'Cantidad*', 'Precio unitario*',
  'Impuestos', 'Descuento', 'Monto total', 'Centro de costo', 'Moneda', 'Tasa de cambio',
  'Vendedor', 'Notas', 'Términos y condiciones', 'Comentarios'];

/* Valores de la hoja «Listas» de la plantilla. Si no coinciden LETRA por
   LETRA, Alegra los toma por invalidos. */
function impuestoAlegra(pct){
  var p = numero(pct);
  if(p === 19) return 'IVA - (19%)';
  if(p === 5)  return 'IVA - (5%)';
  if(p === 0 || p === '') return 'IVA - (Excluido)';
  return 'Ninguno';
}

/** Tipo de identificacion: la plantilla pide codigo + guion + nombre completo. */
var ALEGRA_TIPO_ID = {
  'NIT':'NIT - Número de identificación tributaria',
  'CC':'CC - Cédula de ciudadanía',
  'DIE':'DIE - Documento de identificación extranjero',
  'PP':'PP - Pasaporte',
  'CE':'CE - Cédula de extranjería',
  'TE':'TE - Tarjeta de extranjería',
  'TI':'TI - Tarjeta de identidad',
  'RC':'RC - Registro civil',
  'NIT DE OTRO PAIS':'NIT de otro país - NIT de otro país',
  'NUIP':'NUIP - NUIP',
  'PEP':'PEP - Permiso especial de permanencia',
  'PPT':'PPT - Permiso de protección temporal'
};
function tipoIdAlegra(t){
  var k = txt(t).toUpperCase().replace(/\s+/g,' ').trim();
  if(ALEGRA_TIPO_ID[k]) return ALEGRA_TIPO_ID[k];
  /* si ya viene completo y es uno de los validos, se respeta */
  for(var x in ALEGRA_TIPO_ID) if(low(ALEGRA_TIPO_ID[x]) === low(t)) return ALEGRA_TIPO_ID[x];
  return '';   /* vacio, no inventado: Alegra avisa y el operador lo corrige */
}

/** Forma de pago: la plantilla solo admite «Contado» o «Crédito», con tilde. */
function formaAlegra(f){
  var u = txt(f).toUpperCase();
  if(u.indexOf('CRED') === 0 || u.indexOf('CRÉD') === 0) return 'Crédito';
  if(u.indexOf('CONTAD') === 0) return 'Contado';
  /* Contraentrega y Pago_al_recibir son condiciones de COMPRA, no de venta:
     no existen en la lista de Alegra. Se mandan como Contado, que es lo que
     son desde el punto de vista del cobro. */
  return 'Contado';
}

/** Medio de pago: la plantilla los lleva con tilde. */
var ALEGRA_MEDIO = {
  'EFECTIVO':'Efectivo',
  'TRANSFERENCIA DEBITO':'Transferencia débito',
  'TRANSFERENCIA DÉBITO':'Transferencia débito',
  'CONSIGNACION BANCARIA':'Consignación bancaria',
  'CONSIGNACIÓN BANCARIA':'Consignación bancaria',
  'CREDITO ACH':'Crédito ACH',
  'CRÉDITO ACH':'Crédito ACH',
  'TARJETA CREDITO':'Tarjeta crédito',
  'TARJETA CRÉDITO':'Tarjeta crédito',
  'TARJETA DEBITO':'Tarjeta débito',
  'TARJETA DÉBITO':'Tarjeta débito',
  'CHEQUE':'Cheque'
};
function medioAlegra(m){
  var k = txt(m).toUpperCase().replace(/\s+/g,' ').trim();
  return ALEGRA_MEDIO[k] || 'Instrumento no definido';   /* valor neutro de la lista */
}
function ddmmaaaa(iso){
  var s = txt(iso).substr(0, 10).split('-');
  return s.length === 3 ? s[2] + '/' + s[1] + '/' + s[0] : '';
}
function masDias(iso, d){
  var p = txt(iso).substr(0, 10).split('-');
  if(p.length !== 3) return '';
  /* Aritmética de calendario en UTC: sumar días no debe depender de que la
     zona horaria del proyecto coincida con la del libro. */
  var dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  dt.setUTCDate(dt.getUTCDate() + d);
  return Utilities.formatDate(dt, 'UTC', 'yyyy-MM-dd');
}

/**
 * Devuelve las filas de la plantilla de Alegra para los pedidos pedidos.
 * Solo los que estan marcados como FE: una remision no se factura.
 */
function apiAlegra_(pids){
  var cli = {};
  filas(H.clientes).forEach(function(r){ cli[txt(r['Cliente'])] = r; });
  var ent = {};
  filas(H.entregas).forEach(function(r){ ent[txt(r['P_num'])] = r; });
  var ped = {};
  filas(H.pedidos).forEach(function(r){ ped[txt(r['P_num'])] = r; });

  var rows = [], avisos = [], fila = 0, totales = {};

  (pids || []).forEach(function(pid){
    pid = txt(pid);
    var e = ent[pid], p = ped[pid];
    if(!e || !p){ avisos.push(pid + ': no esta en la hoja.'); return; }
    if(txt(e[COL_EST]).toUpperCase() === E_ANU){ avisos.push(pid + ': esta anulado.'); return; }
    if(txt(e['Doc_tipo']).toUpperCase() !== 'FE'){
      avisos.push(pid + ': esta marcado como ' + (txt(e['Doc_tipo']) || 'sin documento') +
                  '. Solo se exportan los de factura electronica.');
      return;
    }
    var c = cli[txt(p['Cliente'])] || {};
    var tipoId = txt(c['Tipo_identificacion']);
    var numId = txt(c['Numero_identificacion']);
    if(!tipoId || !numId){
      avisos.push(pid + ': el cliente "' + txt(p['Cliente']) + '" no tiene datos fiscales. ' +
                  'Sin tipo y numero de identificacion la DIAN rechaza la factura.');
      return;
    }
    var f = apiFactura_(pid);
    if(!f.lineas.length){ avisos.push(pid + ': no tiene lineas despachadas.'); return; }

    fila++;
    totales[pid] = f.total;
    /* La exportación debe respetar la decisión tomada al emitir, no sustituirla
       por el valor habitual del cliente ni por un plazo fijo de 30 días. */
    var forma = txt(e['Forma_pago']) || txt(c['Forma_pago']) || 'Contado';
    var plazoDoc = numero(e['Plazo_dias']) || numero(c['Plazo_dias']) || 30;
    var fechaDocumento = txt(e['Doc_fecha']) || txt(e['te']) || fechaHoy();
    var venc = forma.toUpperCase().indexOf('CRED') === 0
      ? ddmmaaaa(txt(e['Vencimiento']) || masDias(fechaDocumento,plazoDoc)) : '';

    f.lineas.forEach(function(l, i){
      rows.push([
        fila,                                     /* Fila: agrupa las lineas de una factura */
        ddmmaaaa(fechaDocumento),
        '',                                       /* Prefijo: lo pone Alegra (I-20) */
        '',                                       /* Numeracion: lo pone Alegra (I-20) */
        /* v5.1 · los tres valores pasan por su conversor: la plantilla exige
           el tipo de identificacion COMPLETO, la forma con tilde y el medio
           tal como figura en su hoja «Listas». Antes se mandaba lo que decia
           CAT_Clientes, que usa abreviaturas y va sin tildes. */
        txt(p['Cliente']), tipoIdAlegra(tipoId), numId, formaAlegra(forma), venc,
        medioAlegra(txt(e['Medio_pago']) || txt(c['Medio_pago']) || 'Efectivo'),
        l.codigo, l.cant_despachada, l.precio_unitario,
        impuestoAlegra(l.iva_pct),
        Math.round(l.descuento_efectivo_pct * 1000000) / 1000000,
        l.total_linea,
        '', 'COP', '', txt(c['Vendedor']),
        i === 0 ? ('Pedido ' + pid + ' · total calculado por la app: ' + f.total) : '',
        '', ''
      ]);
    });
  });

  return { ok:true, cols:ALEGRA_COLS, rows:rows, avisos:avisos,
           facturas:fila, lineas:rows.length, totales:totales };
}

/** Pedidos con decisión FE pendiente, antes o después de registrar la entrega. */
function apiPorFacturar_(){
  var out = [];
  filas(H.entregas).forEach(function(r){
    if(txt(r[COL_EST]).toUpperCase() === E_ANU) return;
    if(txt(r['Doc_tipo']).toUpperCase() !== 'FE') return;
    if(txt(r['Doc_estado']).toUpperCase() === 'FACTURADO') return;
    out.push(txt(r['P_num']));
  });
  return out;
}

/** Marca como FACTURADO lo que ya se subio a Alegra. */
function apiMarcarFacturado_(pids, operador){
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    var n = 0;
    (pids || []).forEach(function(pid){
      var r = escribirFila({ hoja:H.entregas, noSello:true,
        claves:[{ columna:'P_num', valor:pid }],
        fila:{ Doc_estado:'FACTURADO' } });
      if(r.escrita) n++;
    });
    return { ok:true, marcados:n };
  } finally { lock.releaseLock(); }
}


/* =====================================================================
   INFRAESTRUCTURA DE ESCRITURA RAPIDA
   =====================================================================
   El usuario pidio que todo corra rapido y sin demoras. Lo que hace
   lenta a una hoja de calculo no es el volumen de datos: es el numero de
   LLAMADAS. Escribir 190 filas celda por celda son miles de viajes a la
   red y se va en minutos. Escribirlas con un setValues() por hoja son 13
   viajes y se va en segundos. */

/** Crea la hoja si no existe, con sus titulos. Devuelve la hoja. */
function asegurarHoja(nombre){
  var ss = libro(), sh = ss.getSheetByName(nombre);
  if(sh) return sh;
  var titulos = HOJAS_F2[nombre];
  if(!titulos) throw new Error('No se sabe que columnas lleva la hoja "' + nombre + '"');
  sh = ss.insertSheet(nombre);
  sh.getRange(1, 1, 1, titulos.length).setValues([titulos]);
  sh.getRange(1, 1, 1, titulos.length).setFontWeight('bold')
    .setBackground('#15455e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  return sh;
}

/** Agrega filas al final de una hoja, TODAS en una sola llamada. */
function anexarBloque(nombre, titulos, objetos){
  if(!objetos || !objetos.length) return 0;
  var sh = asegurarHoja(nombre), idx = indices(sh);
  var cols = sh.getRange(1, 1, 1, idx.__ancho).getValues()[0].map(function(c){ return txt(c); });
  var matriz = objetos.map(function(o){
    return cols.map(function(c){ return o[c] === undefined ? '' : o[c]; });
  });
  sh.getRange(sh.getLastRow() + 1, 1, matriz.length, cols.length).setValues(matriz);
  return matriz.length;
}

/**
 * Reemplaza una hoja ENTERA: titulos y datos, en 2 llamadas.
 * Se usa solo para cargar la simulacion, que por definicion reemplaza todo.
 */
function escribirHojaCompleta(nombre, cols, rows){
  var ss = libro(), sh = ss.getSheetByName(nombre);
  if(!sh) sh = ss.insertSheet(nombre);
  sh.clear();
  sh.getRange(1, 1, 1, cols.length).setValues([cols]);
  sh.getRange(1, 1, 1, cols.length).setFontWeight('bold')
    .setBackground('#15455e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if(rows && rows.length)
    sh.getRange(2, 1, rows.length, cols.length).setValues(rows);
  /* las fechas se escriben como TEXTO para que la hoja no las reinterprete
     segun la configuracion regional y las vuelva mm/dd. Es el mismo criterio
     que ya usaba fechaTexto() al leer. */
  return rows ? rows.length : 0;
}


/* =====================================================================
   MIGRACION A FASE 2
   =====================================================================
   Agrega las columnas nuevas y crea las 3 hojas nuevas, SIN tocar ni un
   dato de lo que ya habia. Mismo patron que las migraciones de Fase 1:
   primero se simula y se lee el informe, despues se corre de verdad.
   Es re-ejecutable: lo que ya esta hecho se salta.

   Las columnas se agregan al FINAL de la fila de titulos. Como todo el
   acceso es por NOMBRE y nunca por posicion, el orden es indiferente
   para el codigo, y agregar al final garantiza que ninguna celda
   existente se mueva de sitio. */

function simularFase2_(){ return correrFase2(true); }
function migrarFase2_(){ return correrFase2(false); }

function correrFase2(soloSimular){
  var log = [];
  function L(t){ log.push(t); Logger.log(t); }
  L(soloSimular ? '=== SIMULACION DE LA MIGRACION A FASE 2 (no se escribe nada) ==='
                : '=== MIGRACION A FASE 2 ===');
  L('');

  var ss = libro(), totalCols = 0, totalHojas = 0;

  /* --- 1. columnas nuevas en las hojas que ya existen --- */
  L('COLUMNAS NUEVAS');
  for(var nombre in COLS_F2){
    var sh = ss.getSheetByName(nombre);
    if(!sh){ L('  ' + nombre + ': LA HOJA NO EXISTE. Se salta.'); continue; }
    var idx = indices(sh);
    var faltan = COLS_F2[nombre].filter(function(c){ return idx[c] === undefined; });
    if(!faltan.length){ L('  ' + nombre + ': ya tiene las ' + COLS_F2[nombre].length + ' columnas de Fase 2.'); continue; }
    L('  ' + nombre + ': faltan ' + faltan.length + ' -> ' + faltan.join(', '));
    totalCols += faltan.length;
    if(!soloSimular){
      var desde = idx.__ancho + 1;
      sh.getRange(1, desde, 1, faltan.length).setValues([faltan]);
      sh.getRange(1, desde, 1, faltan.length).setFontWeight('bold')
        .setBackground('#15455e').setFontColor('#ffffff');
    }
  }

  /* --- 2. las tres hojas nuevas --- */
  L('');
  L('HOJAS NUEVAS');
  for(var hn in HOJAS_F2){
    if(ss.getSheetByName(hn)){ L('  ' + hn + ': ya existe.'); continue; }
    L('  ' + hn + ': SE CREA con ' + HOJAS_F2[hn].length + ' columnas.');
    totalHojas++;
    if(!soloSimular) asegurarHoja(hn);
  }

  /* --- 3. la configuracion por defecto --- */
  L('');
  L('CONFIGURACION');
  var cfgAct = {};
  filas(H.cfg).forEach(function(r){ cfgAct[txt(r['Clave'])] = txt(r['Valor']); });
  var nuevas = 0;
  for(var k in CFG_DEF){
    if(cfgAct[k] !== undefined){ L('  ' + k + ' = ' + cfgAct[k] + ' (ya estaba)'); continue; }
    L('  ' + k + ' = ' + CFG_DEF[k] + '  <- se pone por defecto');
    nuevas++;
    if(!soloSimular)
      escribirFila({ hoja:H.cfg, noSello:true, claves:[{ columna:'Clave', valor:k }],
        fila:{ Clave:k, Valor:CFG_DEF[k], Descripcion:'' } });
  }

  /* --- 4. lo que queda pendiente de LLENAR a mano --- */
  L('');
  L('LO QUE QUEDA PENDIENTE (la migracion crea las columnas, no inventa los datos)');
  if(!soloSimular || ss.getSheetByName(H.productos)){
    var prods = filas(H.productos);
    var sinIva = prods.filter(function(r){ return txt(r['IVA']) === ''; }).length;
    var sinTipo = prods.filter(function(r){ return txt(r['Tipo_trabajo']) === ''; }).length;
    var sinBarras = prods.filter(function(r){ return txt(r['Codigo_barras']) === ''; }).length;
    var sinPrecio = prods.filter(function(r){ return txt(r['Precio_mayorista']) === ''; }).length;
    L('  CAT_Productos: ' + prods.length + ' productos');
    L('     sin IVA ............. ' + sinIva + '   <- sin esto no se puede facturar');
    L('     sin Tipo_trabajo .... ' + sinTipo + '   <- la app lo pregunta la primera vez que se venda');
    L('     sin Codigo_barras ... ' + sinBarras + '  <- sin esto no funciona el escaner');
    L('     sin Precio_mayorista  ' + sinPrecio + '   <- sin esto no hay factura');
    var cls = filas(H.clientes);
    var sinNit = cls.filter(function(r){ return txt(r['Numero_identificacion']) === ''; }).length;
    L('  CAT_Clientes: ' + cls.length + ' clientes, ' + sinNit + ' sin identificacion');
    L('     Un cliente sin tipo y numero de identificacion NO puede facturarse por FE:');
    L('     la DIAN la rechaza. Mientras no los tenga, solo se le puede hacer remision.');
  }

  L('');
  if(soloSimular){
    L('=== FIN DE LA SIMULACION · no se escribio nada ===');
    L('Resumen: ' + totalCols + ' columna(s) nuevas, ' + totalHojas + ' hoja(s) nuevas, '
      + nuevas + ' valor(es) de configuracion.');
    L('Si esto es lo que esperabas, corre migrarFase2_().');
  } else {
    L('=== MIGRACION TERMINADA ===');
    L(totalCols + ' columna(s) agregadas, ' + totalHojas + ' hoja(s) creadas, '
      + nuevas + ' valor(es) de configuracion.');
    L('No se modifico ni un dato de los que ya habia.');
  }
  return log.join('\n');
}


/* =====================================================================
   DATOS DE PRUEBA
   =====================================================================
   El usuario pidio: la primera vez que abra la app, un boton llena todo
   para la simulacion.

   De donde salen: de fase2/construir.py, que es el UNICO generador. De
   ahi salen a la vez el Excel, este cargador y el modo sin conexion de
   la app. Un solo generador con tres consumidores es lo que hace
   imposible que las tres copias de la simulacion se desincronicen.

   ATENCION: esto REEMPLAZA el contenido de las hojas. Es lo correcto
   para una simulacion -- tiene que quedar un estado limpio y conocido --
   pero por eso exige confirmacion explicita. */

function apiHayDatosPrueba_(){
  return (typeof DATOS_PRUEBA !== 'undefined' && DATOS_PRUEBA && DATOS_PRUEBA.hojas)
    ? { ok:true, generado:DATOS_PRUEBA.generado, version:DATOS_PRUEBA.version,
        resumen:DATOS_PRUEBA.resumen }
    : { ok:false, error:'Falta el archivo Datos.gs en el proyecto de Apps Script. ' +
                        'Es el que trae la simulacion.' };
}

/**
 * Desplaza todas las fechas para que la simulacion quede alrededor de HOY.
 * Asi la demo nunca envejece: cargada en marzo o en diciembre, los 12
 * pedidos siempre quedan situados en las ultimas semanas.
 * Reconoce AAAA-MM-DD y AAAA-MM-DD HH:MM y no toca nada mas: un codigo
 * como TEX1201 o un precio como 4000 no pueden confundirse con una fecha.
 */
function desplazarFechas(hojas, generado){
  var base = new Date(generado + 'T00:00:00');
  var hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  var delta = Math.round((hoy - base) / 86400000);
  if(!delta) return hojas;
  var re = /^(\d{4})-(\d{2})-(\d{2})( \d{2}:\d{2})?$/;
  function mover(v){
    var m = re.exec(String(v));
    if(!m) return v;
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    d.setDate(d.getDate() + delta);
    return Utilities.formatDate(d, libro().getSpreadsheetTimeZone(), 'yyyy-MM-dd') + (m[4] || '');
  }
  var out = {};
  for(var n in hojas){
    out[n] = { cols:hojas[n].cols,
      rows:hojas[n].rows.map(function(r){ return r.map(mover); }) };
  }
  return out;
}

function apiCargarDatosPrueba_(confirmacion){
  var hay = apiHayDatosPrueba_();
  if(!hay.ok) return hay;
  if(confirmacion !== 'SI_REEMPLAZAR')
    return { ok:false, error:'Esta operacion REEMPLAZA el contenido de las hojas. ' +
                             'Hay que confirmarla explicitamente.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(120000);
  var t0 = new Date().getTime();
  try{
    var hojas = desplazarFechas(DATOS_PRUEBA.hojas, DATOS_PRUEBA.generado);
    var orden = DATOS_PRUEBA.orden || Object.keys(hojas);
    var escritas = {}, total = 0;

    for(var i = 0; i < orden.length; i++){
      var n = orden[i], d = hojas[n];
      if(!d) continue;
      escritas[n] = escribirHojaCompleta(n, d.cols, d.rows);
      total += escritas[n];
    }

    /* las 3 hojas de Fase 2 que la simulacion no trae, se crean vacias */
    for(var hn in HOJAS_F2) if(!hojas[hn]) asegurarHoja(hn);

    var ms = new Date().getTime() - t0;
    return { ok:true, hojas:escritas, filas:total, ms:ms,
             generado:DATOS_PRUEBA.generado,
             resumen:DATOS_PRUEBA.resumen,
             indicadores:DATOS_PRUEBA.indicadores ? DATOS_PRUEBA.indicadores.todos : null };
  } finally { lock.releaseLock(); }
}

/**
 * Compara los indicadores que calcula la hoja real contra los que
 * calculo el generador en Python. Es LA verificacion de la simulacion:
 * dos implementaciones independientes que tienen que dar el mismo
 * numero. Si solo una los calculara, no habria nada verificado.
 */
function apiVerificarSimulacion_(){
  var hay = apiHayDatosPrueba_();
  if(!hay.ok) return hay;
  var esp = DATOS_PRUEBA.indicadores ? DATOS_PRUEBA.indicadores.todos : null;
  if(!esp) return { ok:false, error:'La simulacion no trae indicadores esperados.' };

  var e = apiEstado_();
  var out = { ok:true, filas:{
    pedidos:e.pedidos.length, partes:e.partes.length, lineas:e.refs.length,
    entregas:e.entregas.length, compras:e.compras.length,
    detalle:e.detalle.length, movimientos:e.movimientos.length
  }, esperado:{
    pedidos:DATOS_PRUEBA.resumen.pedidos, lineas:DATOS_PRUEBA.resumen.lineas_pedido,
    movimientos:DATOS_PRUEBA.resumen.movimientos
  }, saldos:apiSaldos_(), avisos:[] };

  if(out.filas.pedidos !== out.esperado.pedidos)
    out.avisos.push('La hoja tiene ' + out.filas.pedidos + ' pedidos y la simulacion trae '
      + out.esperado.pedidos + '.');
  if(out.filas.partes !== out.filas.pedidos * 2)
    out.avisos.push('R2_Preparacion deberia tener ' + (out.filas.pedidos * 2)
      + ' filas (2 por pedido) y tiene ' + out.filas.partes + '.');
  if(out.filas.entregas !== out.filas.pedidos)
    out.avisos.push('R4_Entregas deberia tener una fila por pedido.');
  if(out.saldos.negativos.length)
    out.avisos.push('Hay ' + out.saldos.negativos.length + ' producto(s) con saldo negativo: '
      + out.saldos.negativos.join(', '));

  /* la facturacion, pedido por pedido, contra lo que calculo Python */
  out.facturas = [];
  (DATOS_PRUEBA.facturacion || []).forEach(function(f){
    var mia = apiFactura_(f.pedido);
    var igual = (mia.subtotal === f.subtotal && mia.iva === f.iva && mia.total === f.total);
    out.facturas.push({ pedido:f.pedido, esperado:f.total, calculado:mia.total, igual:igual });
    if(!igual)
      out.avisos.push(f.pedido + ': la hoja da ' + mia.total + ' y el generador dio '
        + f.total + '. El motor de dinero del servidor y el de Python no coinciden.');
  });
  out.facturasOk = out.facturas.filter(function(x){ return x.igual; }).length;
  out.indicadoresEsperados = esp;
  return out;
}


/* =====================================================================
   EL ARCHIVO DE ALEGRA, EN EL DRIVE
   =====================================================================
   Por que un archivo en Drive y no una descarga directa: la app corre dentro
   del iframe sandbox de Apps Script, y ese iframe bloquea las descargas por
   blob. Crear la hoja en el Drive del usuario y devolver el enlace funciona
   siempre, y ademas deja el archivo guardado: si algo sale mal al subirlo a
   Alegra, el archivo sigue ahi.

   Se devuelven DOS enlaces: el de la hoja (para revisarla antes de subir) y
   el de exportacion directa a .xlsx (que es el formato que Alegra pide).
   ===================================================================== */

function apiExcelAlegra_(pids, operador){
  var a = apiAlegra_(pids);
  if(!a.rows.length)
    return { ok:false, error:'No hay nada que exportar. ' +
             (a.avisos.length ? a.avisos[0] : 'Revisa que los pedidos esten marcados como FE.'),
             avisos:a.avisos };

  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try{
    var nombre = 'HERALSA_Alegra_' +
      Utilities.formatDate(new Date(), libro().getSpreadsheetTimeZone(), 'yyyy-MM-dd_HHmm');
    var ss = SpreadsheetApp.create(nombre);
    var sh = ss.getSheets()[0];
    sh.setName('Plantilla COL');

    /* titulos + datos, en dos llamadas */
    sh.getRange(1, 1, 1, a.cols.length).setValues([a.cols]);
    sh.getRange(1, 1, 1, a.cols.length).setFontWeight('bold');
    sh.getRange(2, 1, a.rows.length, a.cols.length).setValues(a.rows);
    sh.setFrozenRows(1);

    /* las fechas van como TEXTO en dd/mm/aaaa: si se dejaran como fecha, la
       hoja las reinterpretaria segun la configuracion regional y el 11/10
       podria subir como 10 de noviembre. */
    var iF = a.cols.indexOf('Fecha del documento*(dd/mm/aaaa)') + 1;
    var iV = a.cols.indexOf('Vencimiento(dd/mm/aaaa)') + 1;
    [iF, iV].forEach(function(c){
      if(c > 0) sh.getRange(2, c, a.rows.length, 1).setNumberFormat('@');
    });

    /* una hoja de control, para poder comparar numero contra numero en la
       primera subida real. Alegra recalcula el total a partir del porcentaje
       de descuento, asi que puede diferir en algun peso por redondeo: si pasa,
       aqui se ve exactamente en cual factura y por cuanto. */
    var ctl = ss.insertSheet('CONTROL');
    var filas = [['Pedido', 'Total calculado por la app']];
    for(var k in a.totales) filas.push([k, a.totales[k]]);
    filas.push(['', '']);
    filas.push(['TOTAL', Object.keys(a.totales).reduce(function(s, k){ return s + a.totales[k]; }, 0)]);
    ctl.getRange(1, 1, filas.length, 2).setValues(filas);
    ctl.getRange(1, 1, 1, 2).setFontWeight('bold');
    ctl.getRange(filas.length, 1, 1, 2).setFontWeight('bold');
    ctl.getRange(1, 4).setValue(
      'El prefijo y la numeracion van VACIOS a proposito: esos los pone Alegra (I-20). ' +
      'El descuento de cada linea es el EFECTIVO (el propio mas el pedazo del descuento ' +
      'global que le toco), porque la plantilla de Alegra tiene un solo campo de ' +
      'descuento y no sabe de descuentos globales. Compara estos totales con los que ' +
      'muestre Alegra al importar: si hay diferencia, sera de uno o dos pesos por ' +
      'redondeo y aqui se ve en cual factura.');

    var id = ss.getId();
    apiLogCambio_([{ Tabla:'ALEGRA', Registro:nombre, Campo:'exportacion',
      Valor_antes:'', Valor_despues:a.facturas + ' facturas / ' + a.rows.length + ' lineas',
      Motivo:'Archivo generado para subir a Alegra' }], operador);

    return { ok:true, url:ss.getUrl(), id:id,
             xlsx:'https://docs.google.com/spreadsheets/d/' + id + '/export?format=xlsx',
             nombre:nombre, facturas:a.facturas, lineas:a.rows.length,
             pedidos:Object.keys(a.totales), totales:a.totales, avisos:a.avisos };
  } finally { lock.releaseLock(); }
}


/* =====================================================================
   DATOS FISCALES DEL CLIENTE
   =====================================================================
   Se llenan al facturar, que es el momento en que de verdad se necesitan y
   el unico momento en que alguien los tiene a mano. Antes no habia donde
   escribirlos: la app pedia el NIT para facturar y no ofrecia ningun sitio
   para ponerlo.

   Se guardan en CAT_Clientes para que la proxima factura de ese cliente ya
   los traiga, y el cambio queda en LOG_Cambios.
   ===================================================================== */

function apiGuardarCliente_(cliente, datos, operador){
  var permitidos = ['Tipo_identificacion', 'Numero_identificacion', 'Forma_pago',
                    'Medio_pago', 'Vendedor', 'Contacto', 'Canal_habitual'];
  var tipos = ['NIT', 'CC', 'CE', 'PP', 'TI', 'RC', 'NUIP', 'PEP', 'PPT',
               'DIE', 'TE', 'NIT de otro pais'];

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    var sh = hoja(H.clientes), idx = indices(sh);
    var faltan = permitidos.filter(function(c){ return idx[c] === undefined; });
    if(faltan.length === permitidos.length)
      return { ok:false, error:'CAT_Clientes no tiene las columnas fiscales. ' +
               'Ejecuta instalarHeralsa() una vez y vuelve a intentar.' };

    var fila = buscarFila(sh, idx, [{ columna:'Cliente', valor:cliente }]);
    if(!fila) return { ok:false, error:'El cliente "' + cliente + '" no esta en el catalogo.' };

    var tipoId = txt((datos || {})['Tipo_identificacion']);
    if(tipoId && tipos.indexOf(tipoId) < 0)
      return { ok:false, error:'"' + tipoId + '" no es un tipo de identificacion de la ' +
               'lista de Alegra.' };

    /* el digito de verificacion del NIT, comprobado aqui tambien.
       Un NIT con el DV equivocado lo rechaza la DIAN, y el rechazo llega
       cuando ya se subio el archivo: mejor no dejarlo entrar. */
    var numId = txt((datos || {})['Numero_identificacion']);
    if(tipoId === 'NIT' && numId.indexOf('-') > 0){
      var pz = numId.split('-');
      var esperado = dvNitDian(pz[0]);
      if(String(esperado) !== txt(pz[1]))
        return { ok:false, error:'El digito de verificacion no corresponde: para ' +
                 pz[0] + ' deberia ser ' + esperado + ' y dice ' + pz[1] + '. ' +
                 'La DIAN rechazaria la factura.' };
    }

    var cambios = [], f = {};
    permitidos.forEach(function(c){
      if(idx[c] === undefined) return;
      var v = (datos || {})[c];
      if(v === undefined) return;
      var antes = sh.getRange(fila, idx[c] + 1).getValue();
      if(txt(antes) === txt(v)) return;
      f[c] = v;
      cambios.push({ Tabla:'CAT_Clientes', Registro:cliente, Campo:c,
                     Valor_antes:antes, Valor_despues:v,
                     Motivo:'Llenado al facturar' });
    });

    if(!cambios.length) return { ok:true, sinCambio:true };
    escribirFila({ hoja:H.clientes, noSello:true,
      claves:[{ columna:'Cliente', valor:cliente }], fila:f });
    apiLogCambio_(cambios, operador);
    return { ok:true, cambios:cambios.length };
  } finally { lock.releaseLock(); }
}


/* =====================================================================
   v5.1 · apiGuardarProveedor_ · ESPEJO DE apiGuardarCliente_
   =====================================================================
   La hoja CAT_Proveedores existe y tiene sus 15 columnas. Lo que faltaba
   era esta funcion: habia apiGuardarCliente_ y no su equivalente para
   proveedores, asi que un proveedor solo se podia corregir abriendo la
   hoja a mano.

   SE COPIA EL PATRON DE CLIENTES, no se inventa otro:
     - lock, para que dos dispositivos no se pisen;
     - lista blanca de columnas editables;
     - se valida el tipo de identificacion y el digito de verificacion del
       NIT con dvNitDian(), porque un NIT mal puesto lo rechaza la DIAN
       cuando el archivo ya se subio;
     - solo se escribe lo que CAMBIA;
     - cada cambio queda en LOG_Cambios con antes, despues y operador.

   LO QUE NO SE TOCA: el nombre del proveedor es la llave con la que lo
   referencian R1_Compras y MOV_Caja. Renombrarlo aqui dejaria esas filas
   apuntando a un proveedor que ya no existe, asi que Proveedor NO esta en
   la lista de campos editables. Para cambiar el nombre hay que crear otro
   y anular el viejo, que es lo que conserva la trazabilidad.
   ===================================================================== */
function apiGuardarProveedor_(proveedor, datos, operador){
  var permitidos = ['Clase', 'Contacto', 'Lead_time_pactado_d', 'Activo',
                    'Tipo_identificacion', 'Numero_identificacion',
                    'Forma_pago', 'Medio_pago', 'Plazo_dias'];
  var tipos = ['NIT', 'CC', 'CE', 'PP', 'TI', 'RC', 'NUIP', 'PEP', 'PPT',
               'DIE', 'TE', 'NIT de otro pais'];
  var clases  = ['PRODUCTO', 'MP', 'MIXTO'];
  var formas  = ['Contado', 'Contraentrega', 'Pago_al_recibir', 'Credito'];
  var numericos = { Lead_time_pactado_d:1, Plazo_dias:1 };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    var sh = hoja(H.proveedores), idx = indices(sh);
    var faltan = permitidos.filter(function(c){ return idx[c] === undefined; });
    if(faltan.length === permitidos.length)
      return { ok:false, error:'CAT_Proveedores no tiene las columnas esperadas. ' +
               'Ejecuta instalarHeralsa() una vez y vuelve a intentar.' };

    var fila = buscarFila(sh, idx, [{ columna:'Proveedor', valor:proveedor }]);
    if(!fila) return { ok:false, error:'El proveedor "' + proveedor + '" no esta en el catalogo.' };

    datos = datos || {};

    var clase = txt(datos['Clase']).toUpperCase();
    if(clase && clases.indexOf(clase) < 0)
      return { ok:false, error:'"' + clase + '" no es una clase valida. Debe ser ' +
               clases.join(', ') + '. De esto depende en que compras aparece el proveedor.' };
    if(clase) datos['Clase'] = clase;

    var forma = txt(datos['Forma_pago']);
    if(forma && formas.indexOf(forma) < 0)
      return { ok:false, error:'"' + forma + '" no es una forma de pago de compra valida. ' +
               'Admitidas: ' + formas.join(', ') + '.' };

    var medio = txt(datos['Medio_pago']);
    if(medio && AL_MEDIO.indexOf(medio) < 0)
      return { ok:false, error:'"' + medio + '" no es un medio de pago valido.' };

    var tipoId = txt(datos['Tipo_identificacion']);
    if(tipoId && tipos.indexOf(tipoId) < 0)
      return { ok:false, error:'"' + tipoId + '" no es un tipo de identificacion de la lista de Alegra.' };

    /* mismo control que en clientes: el DV del NIT se comprueba aqui */
    var numId = txt(datos['Numero_identificacion']);
    if(tipoId === 'NIT' && numId.indexOf('-') > 0){
      var pz = numId.split('-');
      var esperado = dvNitDian(pz[0]);
      if(String(esperado) !== txt(pz[1]))
        return { ok:false, error:'El digito de verificacion no corresponde: para ' + pz[0] +
                 ' deberia ser ' + esperado + ' y dice ' + pz[1] + '.' };
    }

    permitidos.forEach(function(c){
      if(numericos[c] && datos[c] !== undefined && txt(datos[c]) !== ''){
        var n = numero(datos[c]);
        if(!(n >= 0)) throw new Error(c + ': debe ser un numero mayor o igual que cero.');
        datos[c] = n;
      }
    });
    if(txt(datos['Activo']) !== '') datos['Activo'] = txt(datos['Activo']).toUpperCase();

    var cambios = [], f = {};
    permitidos.forEach(function(c){
      if(idx[c] === undefined) return;
      var v = datos[c];
      if(v === undefined) return;
      var antes = sh.getRange(fila, idx[c] + 1).getValue();
      if(txt(antes) === txt(v)) return;
      f[c] = v;
      cambios.push({ Tabla:'CAT_Proveedores', Registro:proveedor, Campo:c,
                     Valor_antes:antes, Valor_despues:v,
                     Motivo:'Correccion del catalogo de proveedores' });
    });

    if(!cambios.length) return { ok:true, sinCambio:true };
    escribirFila({ hoja:H.proveedores, noSello:true,
      claves:[{ columna:'Proveedor', valor:proveedor }], fila:f });
    apiLogCambio_(cambios, operador);
    return { ok:true, cambios:cambios.length };
  } finally { lock.releaseLock(); }
}

/** Digito de verificacion del NIT colombiano, segun la DIAN. */
function dvNitDian(nit){
  var pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  var d = String(nit).replace(/\D/g, '').split('').map(Number).reverse();
  var s = 0;
  for(var i = 0; i < d.length; i++) s += d[i] * (pesos[i] || 0);
  var r = s % 11;
  return r < 2 ? r : 11 - r;
}

/* ============================================================
   ESQUEMA, LLAVES Y RELACIONES
   ============================================================ */

/* Esquema aditivo HERALSA: conserva nombres nativos y admite columnas del libro 6.0. */
var ESQUEMA_NATIVO = {"CAT_Productos":["Codigo","Descripcion","Tipo_trabajo","Unidad","Punto_reorden","Activo","Codigo_barras","IVA","Precio_mayorista","Precio_minorista","Costo","Categoria","Costo_origen","Inventariable","Cuenta_ventas","Cuenta_inventario","Cuenta_costo_venta","Requiere_revision","Observacion_calidad","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"CAT_Clientes":["Cliente","Canal_habitual","Contacto","Activo","Tipo_identificacion","Numero_identificacion","Forma_pago","Medio_pago","Vendedor","Cliente_id","Digito_verificacion","Plazo_dias","Correo","Telefono","Direccion","Municipio","Departamento","Lista_precios","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"CAT_Proveedores":["Proveedor","Clase","Contacto","Lead_time_pactado_d","Activo","Proveedor_id","Tipo_identificacion","Numero_identificacion","Forma_pago","Medio_pago","Plazo_dias","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"CAT_MateriasPrimas":["Codigo","Descripcion","Unidad","Punto_reorden","Activo","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"R1_Compras":["C_num","tn","tp","tr","Proveedor","Clase_compra","Pp","Pc","Pi","Pf","Faltantes","Lead_interno_d","Lead_proveedor_d","Lead_total_d","TCR_compra_%","Estado","Operador_pide","Operador_recibe","Registrado_en","Proveedor_id","Forma_pago","Medio_pago","Plazo_dias","Vencimiento","Valor_total","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"R1_Detalle":["C_num","Codigo","Descripcion","Tipo","Cant_pedida","Estado_recepcion","Proveedor","tn","tr","Cant_recibida","Fecha_recepcion","Costo_unitario","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"R2_Preparacion":["P_num","Tipo","tc","td","tl","Ciclo_h","Despacho_h","Surtido_inventario","Hay_MP","Materia_prima_faltante","Completo","Reproceso","Tipo_defecto","Operador","Registrado_en","Organizado_en","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"R2_Detalle":["P_num","Tipo","Referencia","Descripcion","Cant_solicitada","Cant_despachada","Precio_unitario","Descuento_pct","IVA_pct","Como_se_suple","Origen","Origen_M","Motivo_novedad","Se_suplio","Registrado_en","Codigo","Costo_unitario","Materias_faltantes","Validado_por","Validado_en","Estado_validacion","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"R3_Pedidos":["P_num","Cliente","Canal","ts","Fecha_compromiso","Dias_prometidos","tc","Fecha_real_listo","Listo_a_tiempo","Pedido_completo","Atrasado_por_insumo","Referencia_faltante","TSI_pedido_%","Tipo_pedido","Estado","Operador","Registrado_en","Descuento_global_pct","Cliente_id","Tipo_venta","Vendedor_id","Finalizado_en","Despacho_iniciado_en","Organizado_en","Revision","Etapa_preparacion","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"R4_Entregas":["P_num","Cliente","Canal","tl","te","Ciclo_entrega_d","Gasto_entrega","Completa","A_tiempo","Sin_novedad","Documento_correcto","OTIF","Motivo_no_OTIF","Observaciones","Operador","Registrado_en","Doc_tipo","Doc_numero","Doc_fecha","Doc_estado","Forma_pago","Medio_pago","Plazo_dias","Vencimiento","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"MOV_Inventario":["Mov_num","Fecha","Codigo","Descripcion","Tipo_mov","Cantidad","Origen_doc","Operador","Observacion","Origen_tipo","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"LOG_Cambios":["Log_num","Fecha","Tabla","Registro","Campo","Valor_antes","Valor_despues","Operador","Motivo"],"CFG_Config":["Clave","Valor","Descripcion"],"MOV_Caja":["Caja_num","Fecha","Tipo_mov","Medio_pago","Valor","Tercero","Tercero_id","Origen_tipo","Origen_doc","Operador","Observacion","Estado_registro","Motivo_anulacion","Anulado_por","Anulado_en"],"CAT_Usuarios":["Usuario_id","Nombre","Usuario","Clave_hash","Sal","Rol","Activo","Debe_cambiar_clave","Ultimo_acceso"]};
var PK_NATIVO = {"CAT_Productos":["Codigo"],"CAT_Clientes":["Cliente_id"],"CAT_Proveedores":["Proveedor_id"],"CAT_MateriasPrimas":["Codigo"],"R1_Compras":["C_num"],"R1_Detalle":["C_num","Codigo"],"R2_Preparacion":["P_num","Tipo"],"R2_Detalle":["P_num","Tipo","Referencia"],"R3_Pedidos":["P_num"],"R4_Entregas":["P_num"],"MOV_Inventario":["Mov_num"],"LOG_Cambios":["Log_num"],"CFG_Config":["Clave"],"MOV_Caja":["Caja_num"],"CAT_Usuarios":["Usuario_id"]};
var RELACIONES_NATIVAS = [{"desde":"R1_Detalle.C_num","hacia":"R1_Compras.C_num"},{"desde":"R2_Preparacion.P_num","hacia":"R3_Pedidos.P_num"},{"desde":"R2_Detalle.P_num","hacia":"R3_Pedidos.P_num"},{"desde":"R4_Entregas.P_num","hacia":"R3_Pedidos.P_num"},{"desde":"MOV_Inventario.Codigo","hacia":"CAT_Productos.Codigo","opcional":true}];


/* ============================================================
   SESIONES Y PERMISOS
   ============================================================ */

/* ACCESO · envoltorios con token alrededor de la lógica nativa. */
var SESION_HORAS_NATIVA=8;
var ROL_ADMIN='ADMIN',ROL_OPERACION='OPERACION',ROL_MOSTRADOR='MOSTRADOR';

function sha256Nativo_(texto){
  var bytes=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,texto,Utilities.Charset.UTF_8);
  return bytes.map(function(b){var v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('');
}
function crearUsuarioNativo_(usuario,nombre,rol,clave,secuencia){
  var sal=Utilities.getUuid().replace(/-/g,'');
  anexarBloque('CAT_Usuarios',ESQUEMA_NATIVO.CAT_Usuarios,[{Usuario_id:'USR'+ceros2(secuencia,4),Nombre:nombre,
    Usuario:low(usuario),Clave_hash:derivarClaveV2_(sal,clave),Sal:sal,Rol:rol,Activo:'S',Debe_cambiar_clave:'S',Ultimo_acceso:''}]);
}
function usuarioPublico_(u){return {Usuario:u.Usuario,Nombre:u.Nombre,Rol:u.Rol,Debe_cambiar_clave:u.Debe_cambiar_clave};}

/* =====================================================================
   v5.1 · B3 · DERIVACION DE CLAVE CON PREFIJO DE VERSION
   =====================================================================
   El formato viejo era un SHA-256 simple de sal+clave: una sola pasada.
   Eso se prueba por fuerza bruta a millones de intentos por segundo si
   alguien llega a ver la hoja. El formato nuevo repite el resumen muchas
   veces para que cada intento cueste.

   POR QUE UN PREFIJO EN LUGAR DE UNA COLUMNA NUEVA: los hashes viejos y
   los nuevos tienen la MISMA longitud, asi que no hay forma de
   distinguirlos mirando el valor. Con el prefijo 'v2$' se distinguen a
   simple vista, no hace falta una columna numero 16 en CAT_Usuarios, y la
   migracion se completa sola: cada usuario se migra la primera vez que
   entra, validando con el metodo viejo y re-guardando con el nuevo.
   Nadie tiene que reiniciar ninguna clave.

   SOBRE EL NUMERO DE ITERACIONES, Y ESTO IMPORTA:
   en el documento de parches propuse 120000. Al aplicarlo me di cuenta de
   que NO he medido lo que cuesta computeDigest en Apps Script, y 120000
   llamadas pueden tardar varios segundos en CADA inicio de sesion, con el
   riesgo de agotar el tiempo de ejecucion. Asi que arranco en 12000, que
   es 12000 veces mas costoso de atacar que el formato viejo, y dejo la
   funcion medirCosteClave_() para que usted mida en SU cuenta y suba el
   numero hasta donde el inicio de sesion siga siendo comodo.
   Guia: si medirCosteClave_() reporta menos de 300 ms, puede duplicarlo.
   ===================================================================== */
var CLAVE_PREFIJO_V2  = 'v2$';
var CLAVE_ITERACIONES = 12000;

function hex_(bytes){
  return bytes.map(function(b){var v=(b<0?b+256:b).toString(16);return v.length===1?'0'+v:v;}).join('');
}
function derivarClaveV2_(sal,clave){
  var h=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,txt(sal)+txt(clave),Utilities.Charset.UTF_8);
  for(var i=1;i<CLAVE_ITERACIONES;i++) h=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,h);
  return CLAVE_PREFIJO_V2+hex_(h);
}
/** Valida contra CUALQUIERA de los dos formatos. No decide nada mas. */
function claveCorrecta_(u,clave){
  var guardado=txt(u.Clave_hash);
  if(guardado.indexOf(CLAVE_PREFIJO_V2)===0) return derivarClaveV2_(u.Sal,clave)===guardado;
  return sha256Nativo_(txt(u.Sal)+txt(clave))===guardado;   /* formato v1, en extincion */
}
/** Si el hash guardado es del formato viejo, lo reescribe con el nuevo.
    Se llama SOLO despues de haber validado la clave. Devuelve si migro. */
function migrarClaveSiHaceFalta_(u,clave){
  if(txt(u.Clave_hash).indexOf(CLAVE_PREFIJO_V2)===0) return false;
  if(!u.__fila) return false;
  var sh=hoja('CAT_Usuarios'),ix=indices(sh);
  sh.getRange(u.__fila,ix.Clave_hash+1).setValue(derivarClaveV2_(u.Sal,clave));
  return true;
}
/** Para medir en SU cuenta. Ejecutar desde el editor y leer el registro. */
function medirCosteClave_(){
  var t0=Date.now();
  derivarClaveV2_('salDePrueba1234','ClaveDePrueba2026');
  var ms=Date.now()-t0;
  Logger.log('CLAVE_ITERACIONES = '+CLAVE_ITERACIONES+' -> '+ms+' ms por intento.');
  Logger.log(ms<300 ? 'Holgado: puede duplicar CLAVE_ITERACIONES.'
                    : ms<1000 ? 'Razonable: dejelo asi.'
                              : 'Lento: baje CLAVE_ITERACIONES.');
  return ms;
}

/* =====================================================================
   v5.1 · B2 · LA SESION VIVE EN PROPERTIESSERVICE, NO EN CACHESERVICE
   =====================================================================
   CacheService es memoria desechable: Google puede desalojar una entrada
   antes de que expire, sin aviso y sin error. Cuando eso pasaba, al
   operador se le cerraba la sesion en mitad de un despacho. Y lo mismo le
   pasaba al contador de intentos fallidos, que es peor: desalojarlo
   reinicia la defensa contra fuerza bruta.
   PropertiesService es almacenamiento persistente. No caduca solo, asi
   que la caducidad se lleva a mano en el campo 'expira' y hay un barrido
   oportunista para que el almacen no crezca sin control.
   ===================================================================== */
function sesionGuardar_(token,obj){
  var p=PropertiesService.getScriptProperties();
  obj.expira=Date.now()+SESION_HORAS_NATIVA*3600*1000;
  p.setProperty('SES_'+txt(token),JSON.stringify(obj));
  sesionBarrer_(p);
}
function sesionLeer_(token){
  var p=PropertiesService.getScriptProperties(),crudo=p.getProperty('SES_'+txt(token));
  if(!crudo) return null;
  var s;
  try{ s=JSON.parse(crudo); }catch(e){ p.deleteProperty('SES_'+txt(token)); return null; }
  if(!s.expira||Date.now()>s.expira){ p.deleteProperty('SES_'+txt(token)); return null; }
  return s;
}
function sesionBorrar_(token){
  PropertiesService.getScriptProperties().deleteProperty('SES_'+txt(token));
}
/** Barre sesiones vencidas, una vez por hora como maximo. */
function sesionBarrer_(p){
  var marca=Number(p.getProperty('SES_BARRIDO')||0);
  if(Date.now()-marca<3600*1000) return;
  p.setProperty('SES_BARRIDO',String(Date.now()));
  var todas=p.getProperties(),ms=Date.now();
  Object.keys(todas).forEach(function(k){
    if(k.indexOf('SES_')!==0||k==='SES_BARRIDO') return;
    try{ var s=JSON.parse(todas[k]); if(!s.expira||ms>s.expira) p.deleteProperty(k); }
    catch(e){ p.deleteProperty(k); }
  });
}
/* El contador de intentos, tambien persistente. */
function intentosLeer_(usuario){
  var p=PropertiesService.getScriptProperties(),crudo=p.getProperty('INT_'+usuario);
  if(!crudo) return 0;
  var o;
  try{ o=JSON.parse(crudo); }catch(e){ p.deleteProperty('INT_'+usuario); return 0; }
  if(Date.now()>o.hasta){ p.deleteProperty('INT_'+usuario); return 0; }
  return Number(o.n)||0;
}
function intentosSumar_(usuario,n){
  PropertiesService.getScriptProperties()
    .setProperty('INT_'+usuario,JSON.stringify({n:n+1,hasta:Date.now()+600*1000}));
}
function intentosBorrar_(usuario){
  PropertiesService.getScriptProperties().deleteProperty('INT_'+usuario);
}

function sesionNativa_(token){
  var s=sesionLeer_(token);
  if(!s)throw new Error('SESIÓN_VENCIDA');
  var u=buscarEn(filas('CAT_Usuarios'),'Usuario',s.usuario);
  if(!u||txt(u.Activo).toUpperCase()!=='S')throw new Error('SESIÓN_VENCIDA');
  s.nombre=txt(u.Nombre);s.rol=txt(u.Rol);s.debe_cambiar_clave=txt(u.Debe_cambiar_clave)==='S';return s;
}

/* =====================================================================
   v5.1 · B1 · EL CAMBIO DE CLAVE OBLIGATORIO SE EXIGE EN EL SERVIDOR
   =====================================================================
   Debe_cambiar_clave solo se comprobaba en el cliente. Cualquiera con la
   clave temporal podia operar sin cambiarla, y de hecho paso: un usuario
   entro y trabajo con la clave que viene escrita en claro en
   Instalacion.gs. Ahora el servidor rechaza todo lo que no sea cambiar la
   clave, cerrar la sesion o comprobar que hay linea.
   LISTA BLANCA EXPLICITA, no una regla negativa: si manana se agrega una
   API nueva y nadie se acuerda de esto, queda bloqueada por omision, que
   es el lado seguro del error.
   ===================================================================== */
var CON_CLAVE_PENDIENTE = ['apiCambiarClave','apiCerrarSesion','apiPing'];

function exigeClaveCambiada_(s,nombreApi){
  if(!s||!s.debe_cambiar_clave) return s;
  if(CON_CLAVE_PENDIENTE.indexOf(nombreApi)>=0) return s;
  throw new Error('CLAVE_PENDIENTE');
}
function rolNativo_(token,roles,api){
  var s=sesionNativa_(token);
  if(roles.indexOf(s.rol)<0)throw new Error('PERMISO_DENEGADO');
  return exigeClaveCambiada_(s,api||'rolNativo');   /* v5.1 · B1 */
}
function operativo_(token,api){
  return exigeClaveCambiada_(rolNativo_(token,[ROL_ADMIN,ROL_OPERACION],api||'operativo'),api||'operativo');
}
function pedidoPropio_(s,pid){
  var p=buscarEn(filas(H.pedidos),'P_num',txt(pid));
  if(!p)throw new Error('El pedido no existe.');
  if(s.rol===ROL_MOSTRADOR && !(txt(p.Tipo_venta)==='MOSTRADOR'&&low(p.Operador)===low(s.nombre)))throw new Error('PERMISO_DENEGADO');
  return p;
}
function apiIniciarSesion(usuario,clave){
  usuario=low(usuario);
  var intentos=intentosLeer_(usuario);
  if(intentos>=8)throw new Error('Demasiados intentos. Espere diez minutos.');
  var u=buscarEn(filas('CAT_Usuarios'),'Usuario',usuario);
  if(!u||txt(u.Activo).toUpperCase()!=='S'||!claveCorrecta_(u,clave)){
    intentosSumar_(usuario,intentos);throw new Error('Usuario o contraseña incorrectos.');
  }
  intentosBorrar_(usuario);
  migrarClaveSiHaceFalta_(u,clave);   /* v5.1 · B3 · la migracion se completa sola */
  var token=Utilities.getUuid()+Utilities.getUuid();
  sesionGuardar_(token,{usuario:usuario,nombre:u.Nombre,rol:u.Rol});
  if(u.__fila)hoja('CAT_Usuarios').getRange(u.__fila,indices(hoja('CAT_Usuarios')).Ultimo_acceso+1).setValue(ahora());
  return {ok:true,token:token,usuario:usuarioPublico_(u)};
}
function apiCerrarSesion(token){sesionBorrar_(token);return {ok:true};}
function apiCambiarClave(token,actual,nueva){
  var s=sesionNativa_(token),u=buscarEn(filas('CAT_Usuarios'),'Usuario',s.usuario);
  if(!u||!claveCorrecta_(u,actual))throw new Error('La contraseña actual no coincide.');
  validarClaveNativa_(nueva);
  if(txt(nueva)===txt(actual))throw new Error('La contraseña nueva no puede ser igual a la actual.');
  var sal=Utilities.getUuid().replace(/-/g,''),sh=hoja('CAT_Usuarios'),ix=indices(sh);
  sh.getRange(u.__fila,ix.Sal+1).setValue(sal);sh.getRange(u.__fila,ix.Clave_hash+1).setValue(derivarClaveV2_(sal,nueva));
  sh.getRange(u.__fila,ix.Debe_cambiar_clave+1).setValue('N');return {ok:true};
}
/* =====================================================================
   v5.1 · B4 · SIEMPRE TIENE QUE QUEDAR UN ADMINISTRADOR ACTIVO
   =====================================================================
   Sin esto, el unico administrador podia bajarse el rol o desactivarse a
   si mismo, y el sistema quedaba sin nadie capaz de crear usuarios, ver
   la caja ni cambiar la configuracion. Recuperarlo exigiria editar
   CAT_Usuarios a mano en la hoja, que es justo lo que la aplicacion
   existe para evitar.
   ===================================================================== */
function exigeUnAdmin_(usuarioIdQueCambia,rolNuevo,activoNuevo){
  if(rolNuevo===undefined&&activoNuevo===undefined) return;
  var admins=filas('CAT_Usuarios').filter(function(u){
    return txt(u.Rol)===ROL_ADMIN&&txt(u.Activo).toUpperCase()==='S';
  });
  var esElUnico=admins.length===1&&txt(admins[0].Usuario_id)===txt(usuarioIdQueCambia);
  if(!esElUnico) return;
  if(rolNuevo!==undefined&&rolNuevo!==ROL_ADMIN)
    throw new Error('Es el único administrador activo. Nombre otro administrador antes de cambiarle el rol.');
  if(activoNuevo!==undefined&&txt(activoNuevo).toUpperCase()!=='S')
    throw new Error('Es el único administrador activo. Nombre otro administrador antes de desactivarlo.');
}

function validarClaveNativa_(clave){
  if(txt(clave).length<10||!/[A-Z]/.test(clave)||!/[a-z]/.test(clave)||!/[0-9]/.test(clave))
    throw new Error('La contraseña debe tener al menos 10 caracteres, con mayúsculas, minúsculas y números.');
}
function apiGuardarUsuario(token,datos){
  rolNativo_(token,[ROL_ADMIN]);datos=datos||{};
  if([ROL_ADMIN,ROL_OPERACION,ROL_MOSTRADOR].indexOf(datos.Rol)<0)throw new Error('Rol inválido.');
  var existente=datos.Usuario_id?buscarEn(filas('CAT_Usuarios'),'Usuario_id',datos.Usuario_id):null;
  if(existente){
    var sh=hoja('CAT_Usuarios'),ix=indices(sh);
    if(datos.Usuario!==undefined){
      var nuevoUsuario=low(datos.Usuario);
      if(!/^[a-z0-9._-]{3,40}$/.test(nuevoUsuario))throw new Error('El usuario debe tener 3 a 40 caracteres: letras, números, punto, guion o guion bajo.');
      var repetido=filas('CAT_Usuarios').some(function(u){return txt(u.Usuario_id)!==txt(existente.Usuario_id)&&low(u.Usuario)===nuevoUsuario;});
      if(repetido)throw new Error('Ese nombre de usuario ya pertenece a otra cuenta.');
      sh.getRange(existente.__fila,ix.Usuario+1).setValue(nuevoUsuario);
    }
    /* v5.1 · B4 · antes de tocar Rol o Activo, comprobar que no es el ultimo admin. */
    exigeUnAdmin_(existente.Usuario_id,datos.Rol,datos.Activo);
    ['Nombre','Rol','Activo'].forEach(function(c){if(datos[c]!==undefined)sh.getRange(existente.__fila,ix[c]+1).setValue(datos[c]);});
    if(datos.Clave){validarClaveNativa_(datos.Clave);var sal=Utilities.getUuid().replace(/-/g,'');sh.getRange(existente.__fila,ix.Sal+1).setValue(sal);sh.getRange(existente.__fila,ix.Clave_hash+1).setValue(derivarClaveV2_(sal,datos.Clave));sh.getRange(existente.__fila,ix.Debe_cambiar_clave+1).setValue('S');}
    return {ok:true};
  }
  if(!txt(datos.Usuario)||buscarEn(filas('CAT_Usuarios'),'Usuario',low(datos.Usuario)))throw new Error('El usuario ya existe o está vacío.');
  validarClaveNativa_(datos.Clave);crearUsuarioNativo_(datos.Usuario,datos.Nombre,datos.Rol,datos.Clave,filas('CAT_Usuarios').length+1);return {ok:true};
}

function estadoSeguro_(s,ligero){
  var e=apiEstado_(ligero);e.usuario={Usuario:s.usuario,Nombre:s.nombre,Rol:s.rol,Debe_cambiar_clave:s.debe_cambiar_clave};
  if(s.rol!==ROL_MOSTRADOR)return e;
  var propios=(e.pedidos||[]).filter(function(p){return txt(p.Tipo_venta)==='MOSTRADOR'&&low(p.Operador)===low(s.nombre);}),ids={};
  propios.forEach(function(p){ids[txt(p.P_num)]=true;});e.pedidos=propios;
  ['partes','refs','entregas'].forEach(function(k){e[k]=(e[k]||[]).filter(function(r){return ids[txt(r.P_num)];});});
  e.compras=[];e.detalle=[];e.movimientos=[];e.cambios=[];
  /* v5.1 · C2 · en modo ligero estos campos NO vienen. Crearlos vacios haria
     que la app fusionara un catalogo vacio y le borrara los productos al
     vendedor de mostrador. Solo se filtran si existen. */
  if(e.productos)e.productos=e.productos.map(function(p){var o={};Object.keys(p).forEach(function(k){if(['Costo','Costo_origen','Cuenta_ventas','Cuenta_inventario','Cuenta_costo_venta','Observacion_calidad'].indexOf(k)<0)o[k]=p[k];});return o;});
  /* =====================================================================
     v5.4 · BUG_002 · EL CANAL FALTABA EN ESTA LISTA BLANCA
     =====================================================================
     Esta lista recorta las columnas de CAT_Clientes que ve un usuario de
     MOSTRADOR. No incluia Canal_habitual, asi que para ese rol el canal
     llegaba vacio y la aplicacion no podia preseleccionarlo: siempre tenia
     que preguntarlo.
     El canal NO es un dato sensible -- es justo lo que decide la lista de
     precios que el vendedor necesita aplicar -- asi que entra. Lo que se
     sigue recortando es el COSTO y las cuentas contables, que es lo que de
     verdad no tiene que ver un vendedor de mostrador.
     ===================================================================== */
  if(e.clientesFull)e.clientesFull=e.clientesFull.map(function(c){var o={};['Cliente_id','Cliente','Canal_habitual','Lista_precios','Contacto','Tipo_identificacion','Numero_identificacion','Digito_verificacion','Forma_pago','Medio_pago','Plazo_dias','Vendedor','Activo'].forEach(function(k){o[k]=c[k];});return o;});
  return e;
}
function apiPing(token){sesionNativa_(token);return apiPing_();}
function apiCatalogos(token){var s=exigeClaveCambiada_(sesionNativa_(token),'apiCatalogos');return estadoSeguro_(s).catalogos;}
function apiPreparacion(token,pid,accion,datos){var s=operativo_(token);return apiPreparacion_(pid,accion,datos,s.nombre);}
function apiEditarFactura(token,pid,datos){var s=operativo_(token);return apiEditarFactura_(pid,datos,s.nombre);}
function apiUsuarios(token){
  rolNativo_(token,[ROL_ADMIN]);
  return filas('CAT_Usuarios').map(function(u){return {Usuario_id:u.Usuario_id,Nombre:u.Nombre,Usuario:u.Usuario,Rol:u.Rol,Activo:u.Activo,Debe_cambiar_clave:u.Debe_cambiar_clave};});
}
function apiEstado(token,ligero){return estadoSeguro_(exigeClaveCambiada_(sesionNativa_(token),'apiEstado'),ligero);}
function apiNuevoId(token,prefijo){var s=exigeClaveCambiada_(sesionNativa_(token),'apiNuevoId');if(s.rol===ROL_MOSTRADOR&&prefijo!=='P')throw new Error('PERMISO_DENEGADO');return apiNuevoId_(prefijo);}
function apiCrearPedido(token,fila){
  var s=exigeClaveCambiada_(sesionNativa_(token),'apiCrearPedido');fila=fila||{};fila.Operador=s.nombre;
  if(s.rol===ROL_MOSTRADOR){fila.Tipo_venta='MOSTRADOR';fila.Tipo_pedido='MOSTRADOR';}
  return apiCrearPedido_(fila);
}
function apiCrearPedidoF2(token,fila,lineas,partes){var s=exigeClaveCambiada_(sesionNativa_(token),'apiCrearPedidoF2');fila=fila||{};fila.Operador=s.nombre;if(s.rol===ROL_MOSTRADOR){fila.Tipo_venta='MOSTRADOR';fila.Tipo_pedido='MOSTRADOR';}return apiCrearPedidoF2_(fila,lineas,partes);}
function apiCrearCompra(token,fila,lineas){var s=operativo_(token);fila=fila||{};fila.Operador_pide=s.nombre;return apiCrearCompra_(fila,lineas);}
function apiGuardar(token,datos){
  var s=exigeClaveCambiada_(sesionNativa_(token),'apiGuardar');
  if(s.rol===ROL_OPERACION)(datos||[]).forEach(function(d){
    if([H.compras,H.detalle,H.pedidos,H.prep,H.prepDet,H.entregas].indexOf(d.hoja)<0)
      throw new Error('PERMISO_DENEGADO');
  });
  if(s.rol===ROL_MOSTRADOR)(datos||[]).forEach(function(d){
    if([H.pedidos,H.prep,H.prepDet,H.entregas].indexOf(d.hoja)<0)throw new Error('PERMISO_DENEGADO');
    pedidoPropio_(s,d.fila&&d.fila.P_num);
  });
  return apiGuardar_(datos);
}
function apiAnular(token,tipo,id,motivo,operador){var s=operativo_(token);return apiAnular_(tipo,id,motivo,s.nombre);}
function apiReactivar(token,tipo,id,operador){var s=operativo_(token);return apiReactivar_(tipo,id,s.nombre);}
function apiAgregarCatalogo(token,cat,valor,extra){var s=exigeClaveCambiada_(sesionNativa_(token),'apiAgregarCatalogo');if(s.rol===ROL_MOSTRADOR&&cat!=='clientes')throw new Error('PERMISO_DENEGADO');return apiAgregarCatalogo_(cat,valor,extra);}
function apiFactura(token,pid){var s=exigeClaveCambiada_(sesionNativa_(token),'apiFactura');pedidoPropio_(s,pid);return apiFactura_(pid);}
function apiMover(token,movs,operador){var s=exigeClaveCambiada_(sesionNativa_(token),'apiMover');if(s.rol===ROL_MOSTRADOR)(movs||[]).forEach(function(m){pedidoPropio_(s,m.Origen_doc||m.origen);});return apiMover_(movs,s.nombre);}
function apiSaldos(token){exigeClaveCambiada_(sesionNativa_(token),'apiSaldos');return apiSaldos_();}
function apiLogCambio(token,cambios,operador){var s=operativo_(token);return apiLogCambio_(cambios,s.nombre);}
function apiEditarProducto(token,codigo,campo,valor,operador,motivo){var s=operativo_(token);return apiEditarProducto_(codigo,campo,valor,s.nombre,motivo);}
function apiConfig(token){exigeClaveCambiada_(sesionNativa_(token),'apiConfig');return apiConfig_();}
function apiGuardarConfig(token,clave,valor,operador){var s=rolNativo_(token,[ROL_ADMIN]);return apiGuardarConfig_(clave,valor,s.nombre);}
function apiNuevaRemision(token){operativo_(token);return apiNuevaRemision_();}
function apiDocumento(token,pid,tipo,operador,pago){
  var s=exigeClaveCambiada_(sesionNativa_(token),'apiDocumento');pedidoPropio_(s,pid);var r=apiDocumento_(pid,tipo,s.nombre,pago);
  if(r&&r.ok)registrarCajaDocumentoNativo_(pid,r,s);return r;
}
function apiAlegra(token,pids){operativo_(token);return apiAlegra_(pids);}
function apiPorFacturar(token){operativo_(token);return apiPorFacturar_();}
function apiMarcarFacturado(token,pids,operador){var s=operativo_(token);return apiMarcarFacturado_(pids,s.nombre);}
function apiExcelAlegra(token,pids,operador){var s=operativo_(token);return apiExcelAlegra_(pids,s.nombre);}
function apiGuardarCliente(token,cliente,datos,operador){var s=exigeClaveCambiada_(sesionNativa_(token),'apiGuardarCliente');return apiGuardarCliente_(cliente,datos,s.nombre);}
/* v5.1 · El catalogo de proveedores lo corrige quien opera o administra, no
   mostrador: un vendedor no tiene por que cambiar la forma de pago de un
   proveedor. Por eso operativo_ y no sesionNativa_. */
function apiGuardarProveedor(token,proveedor,datos,operador){var s=operativo_(token,'apiGuardarProveedor');return apiGuardarProveedor_(proveedor,datos,s.nombre);}
function apiHayDatosPrueba(token){exigeClaveCambiada_(sesionNativa_(token),'apiHayDatosPrueba');return {ok:false,hay:false,produccion:true};}
function apiCargarDatosPrueba(){throw new Error('Los datos demo están deshabilitados en producción.');}
function apiVerificarSimulacion(token){rolNativo_(token,[ROL_ADMIN]);return apiVerificarSimulacion_();}


/* ============================================================
   CAJA, CxC, CxP Y ANÁLISIS
   ============================================================ */

/* CAJA, CxC, CxP Y ANÁLISIS PARCIAL · hechos en MOV_Caja, cálculos al leer. */
function registrarCajaDocumentoNativo_(pid,resultado,ses){
  if(txt(resultado.forma).toUpperCase().indexOf('CRED')===0)return {ok:true,credito:true};
  var lock=LockService.getScriptLock();lock.waitLock(20000);
  try{
    var ya=filas('MOV_Caja').filter(function(m){return txt(m.Origen_doc)===txt(pid)&&txt(m.Tipo_mov)==='INGRESO_VENTA'&&txt(m.Estado_registro)!=='ANULADO';});
    if(ya.length)return {ok:true,duplicado_evitado:true};
    var entrega=buscarEn(filas(H.entregas),'P_num',txt(pid))||{};
    var pedido=buscarEn(filas(H.pedidos),'P_num',txt(pid))||{};
    var mov={Caja_num:nuevoConsecutivo('MOV_Caja','CAJA',6),Fecha:ahora(),Tipo_mov:'INGRESO_VENTA',Medio_pago:resultado.medio,
      Valor:Number(resultado.total)||0,Tercero:txt(entrega.Cliente)||txt(pedido.Cliente),Tercero_id:txt(pedido.Cliente_id),Origen_tipo:'VENTA',Origen_doc:pid,Operador:ses.nombre,
      Observacion:'Cobro automático al emitir el documento',Estado_registro:E_VIG};
    anexarBloque('MOV_Caja',ESQUEMA_NATIVO.MOV_Caja,[mov]);return {ok:true,movimiento:mov.Caja_num};
  }finally{lock.releaseLock();}
}
function apiRegistrarCaja(token,datos){
  var s=rolNativo_(token,[ROL_ADMIN]);datos=datos||{};
  var tipo=txt(datos.Tipo_mov).toUpperCase(),permitidos=['INGRESO','EGRESO','ABONO_CXC','PAGO_CXP','GASTO_ENTREGA'];
  if(permitidos.indexOf(tipo)<0)throw new Error('Tipo de movimiento de caja no válido.');
  var valor=numero(datos.Valor);if(valor<=0)throw new Error('El valor debe ser mayor que cero.');
  var medio=txt(datos.Medio_pago)||'Efectivo';
  if(AL_MEDIO.indexOf(medio)<0)throw new Error('Medio de pago no válido.');
  var id=txt(datos.Origen_doc),tercero=txt(datos.Tercero),terceroId=txt(datos.Tercero_id),origen=txt(datos.Origen_tipo);
  var lock=LockService.getScriptLock();lock.waitLock(20000);
  try{
    if(tipo==='ABONO_CXC'||tipo==='PAGO_CXP'){
      if(!id)throw new Error('El abono o pago necesita una cuenta de origen.');
      var movs=filas('MOV_Caja').filter(function(m){return txt(m.Estado_registro)!=='ANULADO';}),total=0,pagado=0,saldo=0;
      if(tipo==='ABONO_CXC'){
        var entrega=buscarEn(filas(H.entregas),'P_num',id);
        if(!entrega||!txt(entrega.Doc_tipo)||txt(entrega.Forma_pago).toUpperCase().indexOf('CRED')!==0)
          throw new Error('La cuenta por cobrar no existe o no es una venta a crédito documentada.');
        total=apiFactura_(id).total;tercero=txt(entrega.Cliente);origen='VENTA';
        var pedido=buscarEn(filas(H.pedidos),'P_num',id)||{};terceroId=txt(pedido.Cliente_id);
        movs.forEach(function(m){if(txt(m.Origen_doc)===id&&txt(m.Tipo_mov)==='ABONO_CXC')pagado+=numero(m.Valor);});
      }else{
        var compra=buscarEn(filas(H.compras),'C_num',id);
        if(!compra||txt(compra.Forma_pago).toUpperCase().indexOf('CRED')!==0)
          throw new Error('La cuenta por pagar no existe o no es una compra a crédito.');
        total=numero(compra.Valor_total);tercero=txt(compra.Proveedor);terceroId=txt(compra.Proveedor_id);origen='COMPRA';
        movs.forEach(function(m){if(txt(m.Origen_doc)===id&&txt(m.Tipo_mov)==='PAGO_CXP')pagado+=Math.abs(numero(m.Valor));});
      }
      saldo=Math.max(0,total-pagado);
      if(saldo<=0)throw new Error('La cuenta ya está pagada; no admite más movimientos.');
      if(valor>saldo+0.000001)throw new Error('El valor supera el saldo pendiente: '+saldo+'.');
    }
    if(['EGRESO','PAGO_CXP','GASTO_ENTREGA'].indexOf(tipo)>=0)valor=-valor;
    var mov={Caja_num:nuevoConsecutivo('MOV_Caja','CAJA',6),Fecha:txt(datos.Fecha)||ahora(),Tipo_mov:tipo,
      Medio_pago:medio,Valor:valor,Tercero:tercero,Tercero_id:terceroId,
      Origen_tipo:origen,Origen_doc:id,Operador:s.nombre,Observacion:txt(datos.Observacion),Estado_registro:E_VIG};
    anexarBloque('MOV_Caja',ESQUEMA_NATIVO.MOV_Caja,[mov]);
    return {ok:true,id:mov.Caja_num};
  }finally{lock.releaseLock();}
}
function apiCajaResumen(token){
  rolNativo_(token,[ROL_ADMIN]);
  var movs=filas('MOV_Caja').filter(function(m){return txt(m.Estado_registro)!=='ANULADO';}),caja=0;
  movs.forEach(function(m){caja+=numero(m.Valor);});
  var abonosC={},pagosP={};movs.forEach(function(m){var id=txt(m.Origen_doc);if(m.Tipo_mov==='ABONO_CXC')abonosC[id]=(abonosC[id]||0)+numero(m.Valor);if(m.Tipo_mov==='PAGO_CXP')pagosP[id]=(pagosP[id]||0)+Math.abs(numero(m.Valor));});
  /* v5.1 · C1 · las cuatro hojas se leen UNA vez y se indexan. Antes,
     apiFactura_ dentro del bucle releia R2_Detalle y R3_Pedidos por cada
     entrega a credito. La regla de negocio no cambia en nada. */
  var ents=filas(H.entregas), peds=filas(H.pedidos), dets=filas(H.prepDet), compras=filas(H.compras);
  var ctx={pedPorNum:indicePor_(peds,'P_num'),detPorPedido:agrupaPor_(dets,'P_num')};

  var cxc=[],cxp=[],alRecibir=[];
  ents.forEach(function(e){
    if(txt(e.Estado_registro)==='ANULADO'||txt(e.Forma_pago).toUpperCase().indexOf('CRED')!==0||!txt(e.Doc_tipo))return;
    var total=apiFactura_(e.P_num,ctx).total,pagado=abonosC[txt(e.P_num)]||0,saldo=Math.max(0,total-pagado);
    if(saldo>0)cxc.push({P_num:e.P_num,Cliente:e.Cliente,Total:total,Pagado:pagado,Saldo:saldo,Vencimiento:e.Vencimiento,
      Dias_atraso:e.Vencimiento&&txt(e.Vencimiento)<fechaHoy()?Math.floor((new Date(fechaHoy())-new Date(txt(e.Vencimiento)))/86400000):0});
  });
  compras.forEach(function(c){
    if(txt(c.Estado_registro)==='ANULADO')return;
    var forma=txt(c.Forma_pago), formaMay=forma.toUpperCase();

    /* CREDITO a proveedor -> cuenta por pagar, con plazo y vencimiento. */
    if(formaMay.indexOf('CRED')===0){
      var total=numero(c.Valor_total),pagado=pagosP[txt(c.C_num)]||0,saldo=Math.max(0,total-pagado);
      if(saldo>0)cxp.push({C_num:c.C_num,Proveedor:c.Proveedor,Total:total,Pagado:pagado,Saldo:saldo,Plazo_dias:c.Plazo_dias,Vencimiento:c.Vencimiento,
        Dias_atraso:c.Vencimiento&&txt(c.Vencimiento)<fechaHoy()?Math.floor((new Date(fechaHoy())-new Date(txt(c.Vencimiento)))/86400000):0});
      return;
    }

    /* =====================================================================
       v5.1 · D-23 · POR PAGAR AL RECIBIR
       =====================================================================
       Contraentrega y Pago_al_recibir se admitian al crear la compra y no
       producian NINGUN efecto financiero: no eran cuenta por pagar, no
       aparecian en caja, no aparecian en ningun sitio. Era dinero
       comprometido que la empresa no veia en ninguna pantalla.

       NO son cuentas por pagar, y por eso van en su propio bloque: una CxP
       tiene plazo y fecha de vencimiento, y estas no tienen ninguno de los
       dos. Se pagan contra la llegada de la mercancia, cuando llegue.
       El egreso de caja se registra en la RECEPCION; mientras la compra no
       se haya recibido (sin tr), lo que hay es un compromiso pendiente.
       ===================================================================== */
    if(['CONTRAENTREGA','PAGO_AL_RECIBIR'].indexOf(formaMay)>=0){
      if(txt(c.tr))return;        /* ya se recibio: el egreso ya esta en caja */
      var comprometido=numero(c.Valor_total);
      if(comprometido>0)alRecibir.push({C_num:c.C_num,Proveedor:c.Proveedor,
        Total:comprometido,Condicion:forma,Esperada:c.tp||'',
        Nota:'Se paga cuando llegue el pedido. No tiene plazo ni vencimiento.'});
    }
  });

  var totalCxc=0,totalCxp=0,totalAlRecibir=0;
  cxc.forEach(function(x){totalCxc+=numero(x.Saldo)||0;});
  cxp.forEach(function(x){totalCxp+=numero(x.Saldo)||0;});
  alRecibir.forEach(function(x){totalAlRecibir+=numero(x.Total)||0;});
  return {ok:true,caja:caja,movimientos:movs.slice(-200).reverse(),cxc:cxc,cxp:cxp,
    total_cxc:totalCxc,total_cxp:totalCxp,
    al_recibir:alRecibir,total_al_recibir:totalAlRecibir};
}
function apiAnalisisFinanciero(token){
  rolNativo_(token,[ROL_ADMIN],'apiAnalisisFinanciero');
  /* =====================================================================
     v5.1 · C1 · TRES LECTURAS EN TOTAL, NO CUATRO POR PEDIDO
     =====================================================================
     Antes, por CADA pedido: una lectura de R4_Entregas, dos dentro de
     apiFactura_ (R2_Detalle y R3_Pedidos) y una mas de R2_Detalle para el
     costo. Con 8 pedidos eran unas 32 lecturas completas de hoja para un
     calculo que necesita tres. Los numeros que salen son los mismos.
     ===================================================================== */
  var peds=filas(H.pedidos), ents=filas(H.entregas), dets=filas(H.prepDet);
  var entPorNum=indicePor_(ents,'P_num'), detPorPedido=agrupaPor_(dets,'P_num');
  var ctx={pedPorNum:indicePor_(peds,'P_num'),detPorPedido:detPorPedido};
  var ventas=0,costo=0,gastos=0;
  peds.forEach(function(p){
    if(txt(p.Estado_registro)==='ANULADO')return;
    var ent=entPorNum[txt(p.P_num)];if(!ent||!txt(ent.te))return;
    ventas+=apiFactura_(p.P_num,ctx).subtotal;gastos+=numero(ent.Gasto_entrega);
    (detPorPedido[txt(p.P_num)]||[]).forEach(function(l){
      if(txt(l.Estado_registro)!=='ANULADO')costo+=numero(l.Costo_unitario)*numero(l.Cant_despachada);
    });
  });
  return {ok:true,ventas_netas:ventas,costo_ventas:costo,margen_bruto:ventas-costo,gastos_entrega:gastos,
    resultado_operativo_parcial:ventas-costo-gastos,nota:'Resultado operativo parcial; no es balance general ni incluye saldos de apertura.'};
}


/* =====================================================================
   v5.1 · COMPROBACIONES QUE SI SE PUEDEN EJECUTAR DESDE EL EDITOR
   =====================================================================
   POR QUE HACE FALTA ESTE BLOQUE:
   Apps Script OCULTA del desplegable «Ejecutar» toda funcion cuyo nombre
   termina en guion bajo. Las trata como privadas. Por eso en la lista no
   aparecen simularReparacionExpediente_, verificarIndex_, medirCosteClave_
   ni prueba_: no es que falten, es que el editor no las muestra.

   Estas de abajo son envolturas PUBLICAS, sin guion bajo, que si salen en
   el desplegable. No cambian ninguna regla: solo dan acceso a lo que ya
   existe para poder comprobarlo.
   ===================================================================== */

/** Ejecutar esta. Dice si los tres archivos quedaron bien pegados. */
function heralsaVersion(){
  Logger.log('=========== VERSIONES ===========');
  Logger.log('Codigo.gs : ' + VERSION_BACKEND + '      <- debe decir v5.5.7');
  Logger.log('Fase 2    : ' + VERSION_FASE2 + '      <- debe decir f2.2');
  var vIndex = null, largo = 0, cierra = false;
  try{
    var t = HtmlService.createHtmlOutputFromFile('Index').getContent();
    largo  = t.length;
    vIndex = (t.match(/VERSION_APP\s*=\s*'([^']+)'/) || [])[1] || null;
    cierra = t.replace(/\s+$/, '').slice(-7) === '</html>';
    Logger.log('Index     : ' + (vIndex || 'NO ENCONTRADA') + '      <- debe decir v5.5.7');
    Logger.log('Termina en </html>: ' + (cierra ? 'SI' : 'NO  *** QUEDO CORTADO AL PEGAR ***'));
    /* El tamano que devuelve getContent() NO coincide con el del archivo
       fuente: HtmlService no entrega el texto literal. Comparar tamanos aqui
       da falsas alarmas. Para saber si el pegado quedo completo hay que
       ejecutar heralsaDiagnosticarIndex(), que busca marcas concretas. */
    Logger.log('Tamano via HtmlService: ' + largo + ' (NO es el tamano del archivo:');
    Logger.log('   no sirve para comparar. Use heralsaDiagnosticarIndex).');
  }catch(e){
    Logger.log('Index     : NO SE PUDO LEER -> ' + e.message);
    Logger.log('   El archivo HTML tiene que llamarse exactamente «Index», con I mayuscula,');
    Logger.log('   porque doGet() lo pide con ese nombre. Si se llama «index», cambiele el nombre.');
  }
  Logger.log('---------------------------------');
  if(vIndex === VERSION_BACKEND && cierra)
    Logger.log('>>> TODO PAREJO EN v5.5.7. El codigo esta bien pegado.');
  else if(vIndex && vIndex !== VERSION_BACKEND)
    Logger.log('>>> NO COINCIDEN. Vuelva a pegar el archivo que se quedo atras.');
  else
    Logger.log('>>> REVISE LO DE ARRIBA antes de seguir.');
  Logger.log('');
  Logger.log('AVISO: esto comprueba el CODIGO DEL PROYECTO, no lo que sirve la');
  Logger.log('direccion web. Para que la aplicacion sirva este codigo hay que');
  Logger.log('EDITAR la implementacion existente y ponerle «Nueva version».');
  Logger.log('Crear una implementacion nueva genera una direccion DISTINTA y deja');
  Logger.log('la de siempre sirviendo la version vieja.');
  return { backend:VERSION_BACKEND, fase2:VERSION_FASE2, index:vIndex, largo_index:largo, cierra_bien:cierra };
}

/** Simula la reparacion del expediente. NO escribe nada. */
function heralsaSimularReparacionExpediente(){ return simularReparacionExpediente_(); }

/** Simula la reparacion de R2. NO escribe nada. */
function heralsaSimularReparacionR2(){ return simularReparacionR2_(); }

/** Mide lo que cuesta derivar una clave, para ajustar CLAVE_ITERACIONES. */
function heralsaMedirCosteClave(){ return medirCosteClave_(); }

/** Resumen de lo que hay en la hoja: filas por pestaña y siguientes consecutivos. */
function heralsaResumenHoja(){ return prueba_(); }


/* =====================================================================
   v5.1 · DIAGNOSTICO DEL INDEX POR MARCAS, NO POR TAMANO
   =====================================================================
   POR QUE ASI:
   HtmlService.createHtmlOutputFromFile('Index').getContent() NO devuelve el
   texto literal del archivo: su longitud no coincide con la del fuente, ni
   con la del archivo viejo ni con la del nuevo. Comparar tamanos da falsas
   alarmas, y ya dio una.
   Lo que si es concluyente es buscar MARCAS concretas y contar cuantas veces
   aparecen. Si los numeros cuadran, el pegado quedo completo. Si una marca
   sale 0, se sabe EXACTAMENTE que cambio falta.
   ===================================================================== */
function heralsaDiagnosticarIndex(){
  var t;
  try{ t = HtmlService.createHtmlOutputFromFile('Index').getContent(); }
  catch(e){
    Logger.log('NO SE PUDO LEER el archivo «Index»: ' + e.message);
    Logger.log('Tiene que llamarse exactamente Index, con I mayuscula.');
    return { ok:false };
  }
  function cuenta(aguja){ return t.split(aguja).length - 1; }

  /* =====================================================================
     MARCAS QUE ESTAN EN CODIGO, NUNCA EN COMENTARIOS
     =====================================================================
     Apps Script BORRA los comentarios del JavaScript al servir el HTML, y
     getContent() devuelve esa version ya procesada. La primera version de
     esta funcion usaba comentarios como marca y daba una falsa alarma:
     decia que faltaban cinco cambios cuando el archivo estaba completo.
     Estas marcas son codigo que se ejecuta, asi que sobreviven.
     ===================================================================== */
  /* =====================================================================
     v5.5.1 · BUG_022 · ESTE VERIFICADOR DABA UNA FALSA ALARMA
     =====================================================================
     EL DEFECTO, y es mio: las esperanzas estaban CONGELADAS en v5.1. La
     primera marca buscaba literalmente la cadena «VERSION_APP = 'v5.1'»,
     asi que desde v5.2 era IMPOSIBLE que pasara. Y los conteos exactos de
     <style, </style> y class="modo" eran la foto de un momento: al agregar
     un bloque de estilos de Fase 2 dejaron de cuadrar.
     CONSECUENCIA: con el Index correctamente pegado en v5.5, esta funcion
     listaba cuatro cosas «que no cuadran» y terminaba diciendo «Vuelva a
     pegar el index.html completo». Un verificador que pide rehacer un
     trabajo que esta bien es peor que no tener verificador: entrena a no
     creerle, y el dia que detecte algo de verdad nadie le va a hacer caso.

     LA LECCION, y es la que aplico ahora: un conteo exacto no es un
     invariante, es una fotografia, y las fotografias caducan. Lo que se
     comprueba tiene que ser VERDADERO POR CONSTRUCCION:
       · la version se LEE del archivo y se compara con la del servidor,
         en vez de buscar un numero escrito a mano aqui
       · las etiquetas se comprueban EQUILIBRADAS entre si, no contra un
         numero fijo
       · de las marcas de codigo se exige que EXISTAN, no cuantas veces
       · el conteo exacto se reserva para los dos casos donde el numero ES
         la propiedad: que haya UNA sola definicion de lo que debe ser
         unico. Ahi un 2 es el defecto.
     ===================================================================== */
  var fallan = [], i;
  Logger.log('===== DIAGNOSTICO DEL INDEX =====');
  Logger.log('Termina en </html>: ' + (t.replace(/\s+$/, '').slice(-7) === '</html>' ? 'SI' : 'NO *** CORTADO ***'));
  if(t.replace(/\s+$/, '').slice(-7) !== '</html>') fallan.push('el archivo esta CORTADO: no termina en </html>');
  Logger.log('');

  /* ---- 1 · la version, leida del archivo y no escrita aqui ---- */
  var mv = t.match(/VERSION_APP\s*=\s*'([^']+)'/);
  var vIdx = mv ? mv[1] : null;
  Logger.log('--- 1 · version ---');
  Logger.log('   Index     : ' + (vIdx || '>>> NO SE ENCONTRO VERSION_APP <<<'));
  Logger.log('   Codigo.gs : ' + VERSION_BACKEND);
  if(!vIdx) fallan.push('el Index no declara VERSION_APP');
  else if(vIdx !== VERSION_BACKEND)
    fallan.push('el Index dice ' + vIdx + ' y Codigo.gs dice ' + VERSION_BACKEND +
                ': falta pegar una de las dos mitades');
  else Logger.log('   OK · las dos mitades dicen lo mismo');
  Logger.log('');

  /* ---- 2 · estructura EQUILIBRADA, que no caduca ---- */
  Logger.log('--- 2 · estructura ---');
  [['<style', '</style>'], ['<script', '</script>']].forEach(function(par){
    var a = cuenta(par[0]), b = cuenta(par[1]);
    Logger.log('   ' + par[0] + ' = ' + a + '   ' + par[1] + ' = ' + b + (a === b ? '   ok' : '   <<< DESCUADRADO'));
    if(a !== b) fallan.push(par[0] + ' aparece ' + a + ' veces y ' + par[1] + ' ' + b +
                            ': el archivo quedo cortado a mitad de un bloque');
    if(!a) fallan.push('no hay ni un ' + par[0] + ': el pegado no trajo el cuerpo del archivo');
  });
  Logger.log('');

  /* ---- 3 · marcas que tienen que EXISTIR (una o mas) ---- */
  var deben = [
    ["VERSION_F2 = 'f2.2'",   'la version de Fase 2'],
    ['function h6SeccionDe_', 'BUG_004 · la autoridad unica de la seccion'],
    ['function derivarPar_',  'BUG_004 · la gemela pura de la del servidor'],
    ['function editandoAhora_', 'BUG_003 · la guarda de edicion en curso'],
    ['toastGrave_',           'BUG_015 · los avisos graves no se borran solos'],
    ['DB.colaDoc',            'BUG_020 · la cola de emisiones pendientes de numerar'],
    ['provisional',           'BUG_020 · el documento sin numerar se marca'],
    ['function alElegidos',   'la exportacion respeta las casillas'],
    ['min-height:124mm',      'el TOTAL no se recorta al imprimir'],
    ['function idsTxt',       'los P-### de cada seccion'],
    ['puedeSincronizar_',     'no sincronizar sin cambiar la clave']
  ];
  Logger.log('--- 3 · marcas que tienen que estar ---');
  for(i = 0; i < deben.length; i++){
    var n3 = cuenta(deben[i][0]);
    Logger.log('   ' + (n3 > 0 ? 'OK  ' : 'FALTA') + ' · ' + (deben[i][0] + '                              ').slice(0, 26) +
               ' · ' + deben[i][1]);
    if(!n3) fallan.push('falta «' + deben[i][0] + '» (' + deben[i][1] + ')');
  }
  Logger.log('');

  /* ---- 4 · los unicos sitios donde el NUMERO es la propiedad ---- */
  var unicos = [
    ['A.alegraGenerar =', 'hubo DOS definiciones y la segunda tapaba la primera'],
    ['vaciarCola=function', 'BUG_021 · hubo una segunda definicion que dejaba la primera muerta'],
    ['A.escAbrir=function', 'BUG_027 · hubo DOS, y la tapada escondia un segundo emisor de documentos'],
    ['A.facEjecutar =', 'BUG_027 · el emisor de documentos es UNO'],
    ['function toast(',   'un solo canal de avisos']
  ];
  Logger.log('--- 4 · lo que tiene que estar UNA sola vez ---');
  for(i = 0; i < unicos.length; i++){
    var n4 = cuenta(unicos[i][0]);
    Logger.log('   ' + (n4 === 1 ? 'OK  ' : 'FALLA') + ' · ' + unicos[i][0] + ' aparece ' + n4 +
               ' vez(ces) · ' + unicos[i][1]);
    if(n4 !== 1) fallan.push('«' + unicos[i][0] + '» aparece ' + n4 + ' veces y tiene que aparecer 1: ' + unicos[i][1]);
  }
  Logger.log('');

  if(!fallan.length){
    Logger.log('>>> EL INDEX ESTA COMPLETO Y PAREJO CON EL SERVIDOR.');
    Logger.log('>>> Si la aplicacion sigue mostrando lo de antes, el problema NO');
    Logger.log('>>> es el codigo: es la IMPLEMENTACION. Hay que EDITAR la que ya');
    Logger.log('>>> existe y ponerle «Nueva version», no crear otra.');
  }else{
    Logger.log('>>> ' + fallan.length + ' COSA(S) NO CUADRAN:');
    for(var j = 0; j < fallan.length; j++) Logger.log('    - ' + fallan[j]);
  }
  return { ok:!fallan.length, fallan:fallan };
}


/* ####################################################################
   CONEXION CON ALEGRA
   #################################################################### */

/* =====================================================================
   HERALSA · CONEXION CON ALEGRA · PASO 3 Y 4
   =====================================================================
   PEGAR ESTE BLOQUE COMPLETO AL FINAL DE Codigo.gs.
   No reemplaza nada: se anade. Puede pegarlo despues de la ultima linea
   del archivo, la que cierra la ultima funcion.

   EL TOKEN NO SE ESCRIBE EN NINGUN ARCHIVO DE FORMA PERMANENTE.
   Se escribe UNA vez en la funcion de abajo, se ejecuta, y despues se
   borra de ahi. Queda guardado en PropertiesService, que es el almacen
   del servidor: no viaja al navegador y no se puede leer desde la app.
   ===================================================================== */

var ALEGRA_BASE = 'https://api.alegra.com/api/v1';

/* =====================================================================
   PASO 3 · GUARDAR EL TOKEN  ·  SE EJECUTA UNA SOLA VEZ
   =====================================================================
   1. Entre las comillas de abajo, pegue su JWT Token de Alegra.
   2. Guarde el archivo (el icono del disquete).
   3. Arriba, en el desplegable de funciones, elija
      heralsaAlegraGuardarToken  y pulse Ejecutar.
   4. Lea el registro: debe decir TOKEN GUARDADO.
   5. VUELVA AQUI, borre el token de entre las comillas y deje
      'PEGUE_AQUI_SU_TOKEN' como estaba. Guarde otra vez.
      El token ya quedo en el almacen; esta linea no hace falta.
   ===================================================================== */
function heralsaAlegraGuardarToken(){
  var TOKEN = 'PEGUE_AQUI_SU_TOKEN';

  if(TOKEN === 'PEGUE_AQUI_SU_TOKEN' || !TOKEN){
    Logger.log('No pego el token. Reemplace PEGUE_AQUI_SU_TOKEN por su JWT de Alegra.');
    return;
  }
  if(TOKEN.indexOf('eyJ') !== 0){
    Logger.log('AVISO: un JWT de Alegra empieza por «eyJ». El que pego empieza por «' +
               TOKEN.substring(0,4) + '». Revise que copio el JWT Token y no otra cosa.');
  }
  PropertiesService.getScriptProperties().setProperty('ALEGRA_JWT', TOKEN);
  Logger.log('TOKEN GUARDADO. Longitud: ' + TOKEN.length + ' caracteres.');
  Logger.log('AHORA BORRE EL TOKEN DE ESTA FUNCION y vuelva a guardar el archivo.');
  Logger.log('Siguiente paso: ejecute heralsaAlegraProbar');
}

/** Borra el token guardado. Por si hay que cambiarlo o revocarlo. */
function heralsaAlegraBorrarToken(){
  PropertiesService.getScriptProperties().deleteProperty('ALEGRA_JWT');
  Logger.log('Token borrado del almacen. La app no podra facturar hasta guardar otro.');
}

/* ---------- llamada generica. No se usa a mano. ---------- */
function alegraLlamar_(ruta, metodo, cuerpo){
  var jwt = PropertiesService.getScriptProperties().getProperty('ALEGRA_JWT');
  if(!jwt) throw new Error('ALEGRA_SIN_TOKEN');

  var op = {
    method: metodo || 'get',
    headers: { 'Authorization': 'Bearer ' + jwt, 'Accept': 'application/json' },
    contentType: 'application/json',
    muteHttpExceptions: true          /* para leer el error en lugar de que explote */
  };
  if(cuerpo) op.payload = JSON.stringify(cuerpo);

  var r = UrlFetchApp.fetch(ALEGRA_BASE + ruta, op);
  var codigo = r.getResponseCode();
  var texto  = r.getContentText();
  var datos  = null;
  try{ datos = JSON.parse(texto); }catch(e){}

  /* =====================================================================
     v5.4 · BUG_007 · «NO SE PUEDE CONSULTAR NI GENERAR: LA API CADUCO»
     =====================================================================
     El mensaje anterior metia tres causas distintas en una sola frase, y el
     operador no sabia si tenia que renovar el token, pedir un permiso, o
     llamar a alguien. Ahora se distinguen, porque la accion es distinta en
     cada caso, y se dice EXACTAMENTE que hacer.
     ===================================================================== */
  if(codigo === 401 || codigo === 403){
    var cuerpo = String(texto || '').toLowerCase();
    var caducado = codigo === 401 || /expir|caduc|invalid token|token is invalid|jwt/.test(cuerpo);
    if(caducado)
      throw new Error('ALEGRA_TOKEN_VENCIDO: la clave de Alegra ya no sirve (caducó o fue revocada). ' +
        'Hay que generar una nueva en Alegra y guardarla con heralsaAlegraGuardarToken(). ' +
        'Ejecute heralsaAlegraRenovar() para ver el paso a paso. Respuesta de Alegra: ' +
        texto.substring(0,200));
    throw new Error('ALEGRA_FALTA_PERMISO: la clave sirve pero no tiene permiso para «' + ruta +
      '». Hay que marcar ese permiso en Alegra al editar el token. Respuesta: ' + texto.substring(0,200));
  }
  if(codigo >= 400)
    throw new Error('ALEGRA_ERROR_' + codigo + ': ' + texto.substring(0,500));

  return datos;
}

/* =====================================================================
   PASO 4 · PROBAR LA CONEXION  ·  NO CREA NADA
   =====================================================================
   Solo LEE. No escribe en Alegra, no emite nada, no toca la DIAN.
   Ejecutela y mandeme el registro completo.
   ===================================================================== */
function heralsaAlegraProbar(){
  Logger.log('===== PRUEBA DE CONEXION CON ALEGRA =====');
  Logger.log('URL base: ' + ALEGRA_BASE);

  var jwt = PropertiesService.getScriptProperties().getProperty('ALEGRA_JWT');
  if(!jwt){
    Logger.log('NO HAY TOKEN GUARDADO. Ejecute primero heralsaAlegraGuardarToken.');
    return;
  }
  Logger.log('Token guardado: SI (' + jwt.length + ' caracteres, empieza por ' + jwt.substring(0,3) + ')');

  /* 1 · datos de la empresa: la prueba mas barata de que el token sirve */
  try{
    var emp = alegraLlamar_('/company');
    Logger.log('');
    Logger.log('--- SU EMPRESA EN ALEGRA ---');
    Logger.log('Nombre     : ' + (emp && (emp.name || emp.tradeName)));
    Logger.log('Identificacion: ' + (emp && emp.identification));
    Logger.log('Regimen    : ' + (emp && (emp.regime || '(no informado)')));
  }catch(e){
    Logger.log('FALLO al leer la empresa: ' + e.message);
    Logger.log('Si dice NO_AUTORIZADO: revise que el token sea el JWT y que');
    Logger.log('tenga marcados los permisos de Facturas, Items y Contactos.');
    return;
  }

  /* 2 · ultimas facturas: confirma el permiso de Facturas y nos muestra el formato */
  try{
    var fs = alegraLlamar_('/invoices?limit=5&order_direction=DESC');
    Logger.log('');
    Logger.log('--- SUS ULTIMAS FACTURAS (solo lectura) ---');
    if(!fs || !fs.length){ Logger.log('No devolvio facturas.'); }
    else fs.forEach(function(f){
      Logger.log('  ' + (f.numberTemplate ? (f.numberTemplate.fullNumber || f.numberTemplate.number) : f.id) +
                 ' | ' + f.date + ' | ' + (f.client && f.client.name) +
                 ' | total ' + f.total + ' | estado ' + f.status +
                 ' | DIAN ' + (f.stamp ? (f.stamp.legalStatus || '(sin estado)') : '(sin sello)'));
    });
    Logger.log('');
    Logger.log('ESTRUCTURA de la primera factura, para mapear los campos:');
    if(fs && fs[0]) Logger.log(JSON.stringify(fs[0]).substring(0, 1500));
  }catch(e){
    Logger.log('FALLO al leer las facturas: ' + e.message);
  }

  /* 3 · un item y un contacto: confirma esos dos permisos */
  try{
    var it = alegraLlamar_('/items?limit=1');
    Logger.log('');
    Logger.log('Permiso de Items   : OK (' + (it && it.length ? ('ejemplo: ' + it[0].name) : 'sin items') + ')');
  }catch(e){ Logger.log('Permiso de Items   : FALLO -> ' + e.message); }

  try{
    var co = alegraLlamar_('/contacts?limit=1');
    Logger.log('Permiso de Contactos: OK (' + (co && co.length ? ('ejemplo: ' + co[0].name) : 'sin contactos') + ')');
  }catch(e){ Logger.log('Permiso de Contactos: FALLO -> ' + e.message); }

  Logger.log('');
  Logger.log('===== FIN DE LA PRUEBA · no se creo ni se emitio nada =====');
}


/* ####################################################################
   PRUEBA DE ALEGRA
   #################################################################### */

/* =====================================================================
   HERALSA · PRUEBA DE ALEGRA · VERSION 2
   =====================================================================
   PEGAR AL FINAL DE Codigo.gs, igual que el bloque anterior.
   Esta reemplaza en la practica a heralsaAlegraProbar: ejecute
   heralsaAlegraProbar2.

   POR QUE HIZO FALTA:
   La version 1 empezaba leyendo /company, y ese endpoint exige el
   permiso «Configuraciones generales», que es justamente el que
   recomende NO marcar. El 403 Forbidden no era del token: era de ese
   endpoint. Y encima puse un return despues del fallo, asi que la
   prueba se detuvo sin comprobar los tres permisos que SI existen.
   Esta version no lee /company y no se detiene ante un fallo: prueba
   todo y reporta cada cosa por separado.
   ===================================================================== */
function heralsaAlegraProbar2(){
  Logger.log('===== PRUEBA DE ALEGRA v2 · solo lectura =====');
  var jwt = PropertiesService.getScriptProperties().getProperty('ALEGRA_JWT');
  if(!jwt){ Logger.log('NO HAY TOKEN. Ejecute heralsaAlegraGuardarToken.'); return; }
  Logger.log('Token: ' + jwt.length + ' caracteres, empieza por ' + jwt.substring(0,3));
  Logger.log('');

  var ok = 0, fallo = 0;
  function probar(nombre, ruta, pintar){
    try{
      var d = alegraLlamar_(ruta);
      Logger.log('[OK] ' + nombre);
      if(pintar) pintar(d);
      ok++;
      return d;
    }catch(e){
      Logger.log('[FALLA] ' + nombre + ' -> ' + String(e.message).substring(0,220));
      fallo++;
      return null;
    }
  }

  /* 1 · FACTURAS · es el permiso que de verdad importa */
  var fs = probar('Facturas (leer)', '/invoices?limit=5&order_direction=DESC', function(fs){
    if(!fs || !fs.length){ Logger.log('     (no devolvio facturas)'); return; }
    fs.forEach(function(f){
      var num = f.numberTemplate ? (f.numberTemplate.fullNumber || f.numberTemplate.number) : f.id;
      var dian = '(sin sello)';
      if(f.stamp) dian = (f.stamp.legalStatus || f.stamp.status || JSON.stringify(f.stamp).substring(0,60));
      Logger.log('     ' + num + ' | ' + f.date + ' | ' + (f.client && f.client.name) +
                 ' | ' + f.total + ' | estado:' + f.status + ' | DIAN:' + dian);
    });
  });

  /* 2 · ITEMS */
  probar('Items (leer)', '/items?limit=2', function(d){
    if(d && d.length) d.forEach(function(i){
      Logger.log('     id ' + i.id + ' | ref ' + (i.reference || '(sin referencia)') + ' | ' + i.name);
    });
  });

  /* 3 · CONTACTOS */
  probar('Contactos (leer)', '/contacts?limit=2', function(d){
    if(d && d.length) d.forEach(function(c){
      Logger.log('     id ' + c.id + ' | ' + c.name +
                 ' | ident ' + (c.identificationObject ? c.identificationObject.number : (c.identification || '-')));
    });
  });

  /* 4 · NUMERACIONES · hace falta para saber con que prefijo se emite */
  probar('Numeraciones (leer)', '/number-templates');

  /* 5 · LA ESTRUCTURA COMPLETA de una factura ya emitida.
         Es la pieza que necesito para mapear sin adivinar: me dice los
         nombres de campo exactos y, sobre todo, como se ve el sello de
         la DIAN en una factura que ya fue aprobada. */
  if(fs && fs.length){
    Logger.log('');
    Logger.log('===== ESTRUCTURA DE SU ULTIMA FACTURA =====');
    var t = JSON.stringify(fs[0], null, 1);
    Logger.log('(longitud total: ' + t.length + ' caracteres)');
    /* se parte en trozos: el registro de Apps Script corta las lineas largas */
    for(var i = 0; i < t.length && i < 6000; i += 1200)
      Logger.log('--- parte ' + (i/1200 + 1) + ' ---\n' + t.substring(i, i + 1200));
  }

  Logger.log('');
  Logger.log('===== RESUMEN: ' + ok + ' bien, ' + fallo + ' con fallo =====');
  if(fallo) Logger.log('Lo que falle es un permiso que falta en el token, no un error del codigo.');
  Logger.log('No se creo ni se emitio nada.');
}


/* ####################################################################
   EMISION A ALEGRA
   #################################################################### */

/* =====================================================================
   HERALSA · EMISION A ALEGRA · PASO 6 Y 7
   =====================================================================
   PEGAR AL FINAL DE Codigo.gs, despues de los dos bloques anteriores.

   LO QUE HACE ESTE BLOQUE:
     - valida un pedido CONTRA ALEGRA sin emitir nada
     - arma el borrador exacto que se enviaria
     - emite, pero SOLO si llega la confirmacion explicita del operador
     - consulta el estado DIAN despues, porque el sello NO llega al crear

   POR QUE EL SELLO NO LLEGA AL CREAR, comprobado en su cuenta:
     FV530 creada 15:25:08  ·  sellada por la DIAN 15:25:35
     27 segundos de diferencia. Al crear, la respuesta viene sin stamp.
     Por eso se guarda el id y se consulta despues.

   SOBRE productKey (observacion FAZ09 de la DIAN):
     NO se envia. Es el codigo UNSPSC, una clasificacion estandar, y no
     es obligatorio: su cuenta lleva 7 anos emitiendo con esa observacion
     y la DIAN acepta. Se deja asi por decision suya. Si algun dia la
     DIAN lo exige, se agrega una columna a CAT_Productos y se manda.
   ===================================================================== */

/* ---- columnas donde se guarda lo que responde Alegra ---- */
var COL_ALEGRA_ID   = 'Alegra_id';
var COL_CUFE        = 'CUFE';
var COL_DIAN        = 'Estado_DIAN';
var COL_EMITIDO_EN  = 'Emitido_en';

/* =====================================================================
   PASO 6 · crear las cuatro columnas. Ejecutar UNA vez.
   Es aditivo: si ya existen, no hace nada.
   ===================================================================== */
function heralsaAlegraCrearColumnas(){
  var sh = hoja(H.entregas), enc = sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(txt);
  var nuevas = [COL_ALEGRA_ID, COL_CUFE, COL_DIAN, COL_EMITIDO_EN].filter(function(c){ return enc.indexOf(c) < 0; });
  if(!nuevas.length){ Logger.log('Las cuatro columnas ya existen. No se hizo nada.'); return; }
  nuevas.forEach(function(c){ sh.getRange(1, sh.getLastColumn()+1).setValue(c); });
  Logger.log('Columnas creadas en R4_Entregas: ' + nuevas.join(', '));
  Logger.log('No se borro ni se movio ningun dato: se agregaron al final.');
}

/* ---- ayudantes de lectura en Alegra ---- */
function alegraContactoPorIdent_(ident){
  var n = txt(ident).split('-')[0].replace(/\D/g,'');
  if(!n) return null;
  var r = alegraLlamar_('/contacts?identification=' + encodeURIComponent(n) + '&limit=5');
  if(!r || !r.length) return null;
  for(var i=0;i<r.length;i++){
    var o = r[i], num = o.identificationObject ? o.identificationObject.number : o.identification;
    if(txt(num).replace(/\D/g,'') === n) return o;
  }
  return r[0];
}
function alegraItemPorRef_(ref){
  var q = txt(ref);
  if(!q) return null;
  var r = alegraLlamar_('/items?query=' + encodeURIComponent(q) + '&limit=10');
  if(!r || !r.length) return null;
  for(var i=0;i<r.length;i++) if(low(r[i].reference) === low(q)) return r[i];
  return null;   /* coincidencia EXACTA o nada: no se factura un producto parecido */
}

/* =====================================================================
   VALIDACION · todo lo que puede fallar, antes de tocar la DIAN
   =====================================================================
   Devuelve { ok, errores[], avisos[], borrador }. Si ok es false NO se
   emite. Una factura no emitida se corrige gratis; una emitida, con
   nota credito.
   ===================================================================== */
function alegraValidarPedido_(pid){
  pid = txt(pid);
  var errores = [], avisos = [];

  var ped = buscarEn(filas(H.pedidos), 'P_num', pid);
  if(!ped) return { ok:false, errores:['El pedido ' + pid + ' no existe.'] };
  if(txt(ped[COL_EST]).toUpperCase() === E_ANU)
    return { ok:false, errores:[pid + ' esta inhabilitado. No se puede facturar.'] };
  if(['LISTO','ENTREGADO'].indexOf(txt(ped.Estado).toUpperCase()) < 0)
    errores.push(pid + ' esta en ' + txt(ped.Estado) + '. Solo se factura un pedido LISTO o ENTREGADO.');

  var ent = buscarEn(filas(H.entregas), 'P_num', pid) || {};

  /* 1 · YA FACTURADO · la defensa contra la doble emision */
  if(txt(ent[COL_ALEGRA_ID]))
    return { ok:false, yaEmitida:true,
      errores:[pid + ' YA tiene factura en Alegra (id ' + txt(ent[COL_ALEGRA_ID]) +
               (txt(ent.Doc_numero) ? ', numero ' + txt(ent.Doc_numero) : '') +
               '). No se emite dos veces: una factura ante la DIAN solo se corrige con nota credito.'] };

  /* 2 · la factura calculada por la app */
  var f = apiFactura_(pid);
  if(!f || !f.lineas || !f.lineas.length) errores.push(pid + ' no tiene lineas.');
  if(numero(f.total) <= 0) errores.push(pid + ' suma ' + numero(f.total) + '. No se puede emitir una factura sin valor.');

  /* 3 · el cliente y su identificacion */
  var cli = buscarEn(filas(H.clientes), 'Cliente', txt(ped.Cliente)) || {};
  var tipoId = txt(cli.Tipo_identificacion), numId = txt(cli.Numero_identificacion);
  if(!numId) errores.push('El cliente "' + txt(ped.Cliente) + '" no tiene numero de identificacion en CAT_Clientes.');
  if(!tipoId) errores.push('El cliente "' + txt(ped.Cliente) + '" no tiene tipo de identificacion.');
  if(tipoId === 'NIT' && numId.indexOf('-') > 0){
    var pz = numId.split('-'), dv = dvNitDian(pz[0]);
    if(String(dv) !== txt(pz[1]))
      errores.push('El digito de verificacion del NIT no corresponde: para ' + pz[0] + ' deberia ser ' + dv + '.');
  }

  /* 4 · el cliente EN ALEGRA */
  var cAlegra = null;
  if(numId){
    try{
      cAlegra = alegraContactoPorIdent_(numId);
      if(!cAlegra) errores.push('En Alegra no existe un contacto con identificacion ' + numId +
        '. Creelo en Alegra, o corrija la identificacion en CAT_Clientes.');
      /* se comparan los nombres NORMALIZANDO espacios: un doble espacio no
         es una diferencia real y no debe generar una alarma al operador. */
      else if(low(cAlegra.name).replace(/\s+/g,' ').trim() !== low(txt(ped.Cliente)).replace(/\s+/g,' ').trim())
        avisos.push('El nombre no es identico: aqui "' + txt(ped.Cliente) + '", en Alegra "' + cAlegra.name +
          '". Se factura al contacto de Alegra. Si el nombre no coincide con el RUT, la DIAN deja la observacion FAJ44b.');
    }catch(e){ errores.push('No se pudo consultar el cliente en Alegra: ' + e.message); }
  }

  /* 5 · cada referencia EN ALEGRA */
  var lineas = [], faltan = [];
  (f.lineas || []).forEach(function(l){
    var ref = txt(l.codigo);
    if(numero(l.cant_despachada) <= 0) return;      /* una linea sin unidades no va en la factura */
    var it = null;
    try{ it = alegraItemPorRef_(ref); }catch(e){ errores.push('No se pudo consultar ' + ref + ': ' + e.message); }
    if(!it){ faltan.push(ref); return; }
    lineas.push({
      id: it.id,
      reference: ref,
      quantity: numero(l.cant_despachada),
      price: numero(l.precio_unitario),
      discount: numero(l.descuento_pct) || 0,
      _dLinea: numero(l.descuento_pct) || 0
    });
  });
  if(faltan.length)
    errores.push('Estas referencias no existen en Alegra: ' + faltan.join(', ') +
      '. Creelas en Alegra antes de facturar; si no, la factura saldria sin esas lineas.');
  if(!lineas.length) errores.push('Ninguna linea tiene unidades despachadas.');

  /* 6 · forma de pago y vencimiento */
  var formaHoja = txt(ent.Forma_pago) || txt(cli.Forma_pago) || 'Contado';
  var esCredito = formaHoja.toUpperCase().indexOf('CRED') === 0;
  var fecha = txt(ent.Doc_fecha) || fechaHoy();
  var plazo = numero(ent.Plazo_dias) || numero(cli.Plazo_dias) || 30;
  var vence = esCredito ? (txt(ent.Vencimiento) || masDias(fecha, plazo)) : fecha;

  /* 7 · el borrador, tal como se enviaria */
  var borrador = {
    date: fecha.substr(0,10),
    dueDate: txt(vence).substr(0,10),
    client: cAlegra ? { id: cAlegra.id } : null,
    paymentForm: esCredito ? 'CREDIT' : 'CASH',
    items: lineas,
    anotation: 'Pedido ' + pid + ' · HERALSA',
    numberTemplate: { id: '16' }        /* su numeracion electronica FV */
  };

  /* =====================================================================
     8 · EL DESCUENTO GLOBAL TIENE QUE VIAJAR DENTRO DE LAS LINEAS
     =====================================================================
     DEFECTO QUE SE CORRIGE, Y ERA GRAVE:
     antes, el descuento global del pedido (R3_Pedidos.Descuento_global_pct)
     NO se enviaba a Alegra. El borrador llevaba solo el descuento propio de
     cada linea, asi que Alegra facturaba el valor SIN el descuento global.
     En P-006, con 18 % global, la pantalla mostraba 145.058 y Alegra habria
     emitido 176.900: 31.842 pesos de mas, en un documento fiscal que solo
     se corrige con nota credito.
     La validacion no lo detectaba porque comparaba el total de la app
     contra una suma que SI aplicaba el global: cuadraba, y daba luz verde a
     un borrador que no lo llevaba.

     COMO SE ARREGLA: Alegra aplica descuentos POR LINEA, no por factura.
     Lo compruebo en su factura FV530: el campo discount de la factura es la
     SUMA de los descuentos de linea, no un descuento aparte. Asi que el
     global se compone con el de cada linea:
         descuento_final = 100 x (1 - (1 - dLinea/100) x (1 - dGlobal/100))
     Con dLinea 0 y global 18 da 18. Con dLinea 15 y global 18 da 30,3,
     que es exactamente lo que queda tras aplicar los dos.

     Y la comprobacion del total se hace AHORA sobre el borrador final, no
     sobre un calculo paralelo. Si no cuadra al peso, es ERROR y no aviso:
     no se emite.
     ===================================================================== */
  var dg = numero(ped.Descuento_global_pct) || 0;
  if(dg > 0){
    lineas.forEach(function(l){
      var dl = numero(l._dLinea) || 0;
      var comp = 100 * (1 - (1 - dl/100) * (1 - dg/100));
      l.discount = Math.round(comp * 1000000) / 1000000;
    });
  }
  lineas.forEach(function(l){ delete l._dLinea; });

  /* la suma se calcula SOBRE EL BORRADOR, que es lo que de verdad se envia */
  var suma = 0;
  lineas.forEach(function(l){
    var bruto = l.price * l.quantity;
    suma += bruto - (bruto * (numero(l.discount)/100));
  });
  var totalApp = numero(f.total);
  if(Math.abs(Math.round(suma) - Math.round(totalApp)) > 1)
    errores.push('NO CUADRA: la app dice ' + Math.round(totalApp) + ' y lo que se enviaria a Alegra suma ' +
      Math.round(suma) + '. Diferencia de ' + Math.abs(Math.round(suma) - Math.round(totalApp)) +
      '. No se emite: un peso de diferencia en un documento fiscal es un documento mal emitido.');
  if(dg > 0)
    avisos.push('El descuento global del ' + dg + ' % se reparte dentro de cada linea, porque Alegra ' +
      'aplica descuentos por linea. El total final es el mismo: ' + Math.round(suma) + '.');

  return {
    ok: errores.length === 0,
    errores: errores, avisos: avisos,
    borrador: borrador,
    resumen: {
      pedido: pid,
      cliente: cAlegra ? cAlegra.name : txt(ped.Cliente),
      cliente_alegra_id: cAlegra ? cAlegra.id : '',
      identificacion: (tipoId ? tipoId + ' ' : '') + numId,
      forma: esCredito ? 'Credito' : 'Contado',
      vence: esCredito ? txt(vence).substr(0,10) : '',
      lineas: lineas.length,
      total_app: Math.round(totalApp),
      total_lineas: Math.round(suma),
      detalle: lineas
    }
  };
}

/* ---- API: preparar · NO emite, solo valida y devuelve el resumen ---- */
function apiAlegraPreparar(token, pid){
  operativo_(token, 'apiAlegraPreparar');
  try{ return alegraValidarPedido_(pid); }
  catch(e){ return { ok:false, errores:['Error al validar: ' + e.message] }; }
}

/* =====================================================================
   API: emitir · exige confirmacion EXPLICITA
   =====================================================================
   El operador tiene que mandar confirmacion === 'EMITIR'. No basta con
   llamar a la funcion: asi una llamada por descuido no emite nada.
   ===================================================================== */
function apiAlegraEmitir(token, pid, confirmacion){
  var s = operativo_(token, 'apiAlegraEmitir');
  if(confirmacion !== 'EMITIR') return { ok:false, errores:['Falta la confirmacion explicita.'] };

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    /* se vuelve a validar DENTRO del lock: entre ver el resumen y
       confirmar, otro dispositivo pudo haber facturado el mismo pedido */
    var v = alegraValidarPedido_(pid);
    if(!v.ok) return v;

    var r = alegraLlamar_('/invoices', 'post', v.borrador);
    if(!r || !r.id) return { ok:false, errores:['Alegra no devolvio el identificador de la factura.'] };

    var num = r.numberTemplate ? (r.numberTemplate.fullNumber || r.numberTemplate.number) : txt(r.id);
    var fila = {};
    fila[COL_ALEGRA_ID]  = txt(r.id);
    fila[COL_CUFE]       = r.stamp ? txt(r.stamp.cufe) : '';
    fila[COL_DIAN]       = r.stamp ? txt(r.stamp.legalStatus) : 'EN_PROCESO';
    fila[COL_EMITIDO_EN] = ahora();
    fila['Doc_tipo']     = 'FACTURA_ELECTRONICA';
    fila['Doc_numero']   = num;
    fila['Doc_fecha']    = txt(r.date);
    fila['Doc_estado']   = 'FACTURADO';
    escribirFila({ hoja:H.entregas, noSello:true, claves:[{columna:'P_num', valor:txt(pid)}], fila:fila });

    apiLogCambio_([{ Tabla:'R4_Entregas', Registro:txt(pid), Campo:'Factura_electronica',
      Valor_antes:'', Valor_despues:num + ' (Alegra id ' + r.id + ')',
      Motivo:'Emitida desde HERALSA por ' + s.nombre }], s.nombre);

    return { ok:true, alegra_id:txt(r.id), numero:num, total:numero(r.total),
      estado_dian: r.stamp ? txt(r.stamp.legalStatus) : 'EN_PROCESO',
      cufe: r.stamp ? txt(r.stamp.cufe) : '',
      nota:'La DIAN sella unos segundos despues. Consulte el estado para ver el CUFE.' };
  } finally { lock.releaseLock(); }
}

/* =====================================================================
   API: consultar el estado en la DIAN
   =====================================================================
   Hace falta porque el sello NO llega al crear la factura.
   ===================================================================== */
function apiAlegraEstado(token, pid){
  operativo_(token, 'apiAlegraEstado');
  var ent = buscarEn(filas(H.entregas), 'P_num', txt(pid)) || {};
  var id = txt(ent[COL_ALEGRA_ID]);
  if(!id) return { ok:false, errores:['Este pedido no tiene factura en Alegra.'] };

  var r = alegraLlamar_('/invoices/' + encodeURIComponent(id));
  var st = r && r.stamp ? r.stamp : null;
  var estado = st ? txt(st.legalStatus) : 'EN_PROCESO';

  var fila = {};
  fila[COL_DIAN] = estado;
  if(st && st.cufe) fila[COL_CUFE] = txt(st.cufe);
  escribirFila({ hoja:H.entregas, noSello:true, claves:[{columna:'P_num', valor:txt(pid)}], fila:fila });

  return { ok:true, alegra_id:id,
    numero: r && r.numberTemplate ? (r.numberTemplate.fullNumber || r.numberTemplate.number) : id,
    estado_dian: estado,
    aceptada: estado.indexOf('ACCEPTED') >= 0,
    con_observaciones: estado.indexOf('OBSERVATIONS') >= 0,
    cufe: st ? txt(st.cufe) : '',
    sellada_en: st ? txt(st.date) : '',
    observaciones: st && st.warnings ? st.warnings : [],
    total: r ? numero(r.total) : 0 };
}

/* ---- prueba de validacion sin emitir, desde el editor ---- */
function heralsaAlegraValidarPedido(){
  var PEDIDO = 'P-002';          /* cambie este numero por el que quiera probar */
  var v = alegraValidarPedido_(PEDIDO);
  Logger.log('===== VALIDACION DE ' + PEDIDO + ' · no se emite nada =====');
  Logger.log('Se puede emitir: ' + (v.ok ? 'SI' : 'NO'));
  (v.errores||[]).forEach(function(e){ Logger.log('  ERROR : ' + e); });
  (v.avisos||[]).forEach(function(a){ Logger.log('  AVISO : ' + a); });
  if(v.resumen){
    Logger.log('');
    Logger.log('Cliente : ' + v.resumen.cliente + ' (' + v.resumen.identificacion + ')');
    Logger.log('Pago    : ' + v.resumen.forma + (v.resumen.vence ? ' · vence ' + v.resumen.vence : ''));
    Logger.log('Lineas  : ' + v.resumen.lineas);
    Logger.log('Total   : ' + v.resumen.total_app + '  (suma de lineas: ' + v.resumen.total_lineas + ')');
  }
  if(v.borrador){ Logger.log(''); Logger.log('BORRADOR que se enviaria:'); Logger.log(JSON.stringify(v.borrador, null, 1)); }
  return v;
}


/* ####################################################################
   VALIDADOR DE COHERENCIA
   #################################################################### */

/* =====================================================================
   HERALSA · VALIDADOR CENTRAL DE COHERENCIA
   =====================================================================
   PEGAR AL FINAL DE Codigo.gs.

   POR QUE EXISTE ESTE ARCHIVO, y conviene decirlo:
   los defectos que se han corregido en esta version no los encontro una
   prueba: los encontro el usuario mirando la pantalla. Facturacion con
   dos rutas distintas, el descuento global que no viajaba, el medio de
   pago «Efectivo» en una factura a credito. Todos tienen la misma forma:
   cada dato, por separado, es valido. La CONTRADICCION entre dos datos es
   lo que nadie comprobaba.

   Este validador es un solo sitio donde viven esas reglas. No valida
   formatos -- eso ya lo hacen las funciones de cada API -- sino
   CONTRADICCIONES entre campos que por separado pasan.

   ERROR = contradiccion real. No se guarda.
   AVISO = sospechoso pero legitimo. Se guarda y se avisa.
   ===================================================================== */

/** Pago: forma, medio, plazo y vencimiento tienen que contar la misma historia. */
function cohPago_(d, contexto){
  d = d || {};
  var errores = [], avisos = [];
  var forma = txt(d.forma || d.Forma_pago);
  var medio = txt(d.medio || d.Medio_pago);
  var plazo = numero(d.plazo !== undefined ? d.plazo : d.Plazo_dias) || 0;
  var venc  = txt(d.vence || d.Vencimiento);
  var fecha = txt(d.fecha || d.Doc_fecha) || fechaHoy();
  var esCredito = forma.toUpperCase().indexOf('CRED') === 0;
  var esContado = forma.toUpperCase().indexOf('CONTAD') === 0;

  /* ---- LA QUE EL USUARIO SEÑALO ----
     Credito con medio de pago concreto es una contradiccion: si es a
     credito NO se ha cobrado, asi que todavia no se sabe COMO se va a
     cobrar. El medio se registra en el abono, no al emitir. Dejarlo en
     «Efectivo» dice que entro plata que no entro, y eso descuadra la caja
     y miente en el documento. */
  /* =====================================================================
     v5.4 · BUG_008 · LA CONTRADICCION ENTRE MIS DOS PROPIAS GUARDAS
     =====================================================================
     Esta guarda exigia que a credito el medio fuera «Credito» o «Por
     definir». Pero apiDocumento_ exige que el medio este en AL_MEDIO, la
     lista literal de Alegra, que NO contiene ninguno de esos dos. Una
     guarda pedia A y la otra prohibia A: por eso NINGUNA venta a credito se
     podia emitir, que es el BUG_008 que reporto el usuario.

     EL VALOR CORRECTO es «Instrumento no definido»: es el unico de la lista
     de Alegra que significa exactamente «todavia no se sabe como se va a
     pagar», que es la verdad de una venta a credito. Se aceptan tambien los
     dos valores historicos para no invalidar documentos ya emitidos.
     ===================================================================== */
  var MEDIO_SIN_DEFINIR_ = ['INSTRUMENTO NO DEFINIDO', 'CREDITO', 'POR DEFINIR'];
  if(esCredito && medio && MEDIO_SIN_DEFINIR_.indexOf(medio.toUpperCase()) < 0)
    errores.push('Incoherencia de pago: el documento es a CREDITO pero dice que se pagó con "' + medio +
      '". Si es a crédito todavía no se ha cobrado, así que no puede haber medio de pago. ' +
      'El medio se registra cuando entre el abono.');

  if(esCredito && plazo <= 0)
    errores.push('Incoherencia de pago: es a CREDITO pero el plazo es ' + plazo +
      ' días. Una venta a crédito sin plazo no se puede cobrar ni vencer.');

  if(esCredito && !venc)
    errores.push('Incoherencia de pago: es a CREDITO y no tiene fecha de vencimiento. ' +
      'Sin vencimiento no entra en cartera y nadie la va a cobrar.');

  if(esContado && plazo > 0)
    avisos.push('Dice CONTADO pero tiene un plazo de ' + plazo + ' días. Si de verdad hay plazo, es a crédito.');

  if(esContado && !medio)
    errores.push('Incoherencia de pago: es de CONTADO y no dice con qué se pagó. ' +
      'Si entró plata, tiene que decir por dónde entró.');

  if(venc && fecha && txt(venc).substr(0,10) < txt(fecha).substr(0,10))
    errores.push('Incoherencia de fechas: el vencimiento (' + txt(venc).substr(0,10) +
      ') es ANTERIOR a la fecha del documento (' + txt(fecha).substr(0,10) + ').');

  if(!forma)
    errores.push('Falta la forma de pago. Sin eso no se sabe si es una venta cobrada o una cuenta por cobrar.');

  return { ok:errores.length === 0, errores:errores, avisos:avisos, contexto:contexto || '' };
}

/** Un pedido completo: estado, etapa, lineas y totales contra los hechos. */
/* =====================================================================
   v5.3 · RENDIMIENTO · EL CONTEXTO QUE YA EXISTIA Y NADIE LE PASABA
   =====================================================================
   MEDIDO: cohPedido_ leia SEIS hojas completas por cada pedido (R3,
   R2_Preparacion, R2_Detalle, R4 y dos mas dentro de apiFactura_). Con 15
   pedidos, heralsaRevisarCoherencia hacia 91 lecturas completas de hoja:
   son los 45 segundos que el usuario midio. Y apiDocumento_ la llamaba por
   cada documento, asi que emitir una remision costaba lo mismo.

   apiFactura_ ya aceptaba un ctx opcional desde v5.1 y los ayudantes
   indicePor_/agrupaPor_ ya estaban escritos. Faltaba el cable: nadie
   construia el contexto y nadie lo pasaba. Ahora cohCtx_() lee las cuatro
   hojas UNA vez y el mismo objeto sirve para apiFactura_, que ya sabe
   leerlo.
   Sin ctx se comporta EXACTAMENTE como antes, asi que ninguna llamada que
   ya existe cambia de resultado.
   ===================================================================== */
function cohCtx_(){
  var ped = filas(H.pedidos), prep = filas(H.prep), det = filas(H.prepDet), ent = filas(H.entregas);
  return { pedPorNum:indicePor_(ped, 'P_num'), prepPorPedido:agrupaPor_(prep, 'P_num'),
           detPorPedido:agrupaPor_(det, 'P_num'), entPorNum:indicePor_(ent, 'P_num'),
           pedidos:ped };
}

function cohPedido_(pid, ctx){
  pid = txt(pid);
  var errores = [], avisos = [];
  var p = ctx ? ctx.pedPorNum[pid] : buscarEn(filas(H.pedidos), 'P_num', pid);
  if(!p) return { ok:false, errores:['El pedido ' + pid + ' no existe.'] };

  var estado = txt(p.Estado).toUpperCase();
  var etapa  = txt(p.Etapa_preparacion).toUpperCase();
  var vivas_ = function(l){ return (l || []).filter(function(r){ return txt(r[COL_EST]).toUpperCase() !== E_ANU; }); };
  var partes = ctx ? vivas_(ctx.prepPorPedido[pid])
                   : filas(H.prep).filter(function(r){ return txt(r.P_num) === pid && txt(r[COL_EST]).toUpperCase() !== E_ANU; });
  var det    = ctx ? vivas_(ctx.detPorPedido[pid])
                   : filas(H.prepDet).filter(function(r){ return txt(r.P_num) === pid && txt(r[COL_EST]).toUpperCase() !== E_ANU; });
  var ent    = (ctx ? ctx.entPorNum[pid] : buscarEn(filas(H.entregas), 'P_num', pid)) || {};
  var tc = txt(p.tc) || txt((partes[0]||{}).tc);
  var tl = txt((partes[0]||{}).tl);

  /* =====================================================================
     v5.5.5 · BUG_031 · LAS TRES COPIAS DE LA FECHA DE CIERRE
     =====================================================================
     POR QUE HACE FALTA ESTA COMPROBACION, y lo descubri cruzando dos
     registros del usuario que parecian contradecirse:

       heralsaRevisarCoherencia : «P-012 · la entrega (te) es anterior al
                                  cierre (tl)»  -> ERROR
       indicador 8 (entrega)    : 0,5 dias con n=4, SIN ningun negativo

     Las dos cosas eran ciertas a la vez porque NO leen la misma celda. La
     fecha de cierre vive en TRES sitios:
         R2_Preparacion.tl        <- lo lee el indicador 4 y esta revision
         R4_Entregas.tl           <- lo lee el indicador 8
         R3_Pedidos.Fecha_real_listo <- lo lee la guarda de la entrega
     El cierre las escribe LAS TRES con el mismo valor y en la misma
     operacion, asi que desde un libro limpio nacen identicas. Pero si
     alguna se edita a mano, o viene de una version anterior -- que es el
     caso de P-012 --, dos indicadores miden desde copias distintas y
     NADIE lo avisa. Un numero que depende de cual copia se leyo no es un
     numero: es una coincidencia.

     No se cambia el esquema a estas alturas: eso es una decision del
     usuario y hacerlo justo antes de limpiar la base añade riesgo sin
     necesidad. Lo que si se hace es DECIRLO cuando pase, para que no
     pueda volver a esconderse.
     ===================================================================== */
  var tl3 = txt(p.Fecha_real_listo), tl4 = txt(ent.tl);
  var copiasTl = [['R2_Preparacion.tl', tl], ['R3.Fecha_real_listo', tl3], ['R4_Entregas.tl', tl4]]
                 .filter(function(x){ return x[1]; });
  if(copiasTl.length > 1){
    var dia0 = copiasTl[0][1].substr(0,10);
    var discrepan = copiasTl.filter(function(x){ return x[1].substr(0,10) !== dia0; });
    if(discrepan.length)
      errores.push(pid + ' tiene la fecha de cierre distinta en cada hoja: ' +
        copiasTl.map(function(x){ return x[0] + ' = ' + x[1]; }).join(' · ') +
        '. Los indicadores 4 y 8 miden desde copias distintas, asi que dan numeros que no se pueden comparar. ' +
        'Hay que dejar una sola fecha: la del cierre real.');
  }

  /* ---- estado contra hechos ---- */
  if(estado === 'LISTO' || estado === 'ENTREGADO'){
    var w = 0; det.forEach(function(l){ w += numero(l.Cant_despachada) || 0; });
    if(w <= 0) errores.push(pid + ' está en ' + estado + ' pero no despachó ninguna unidad. ' +
      'No se puede facturar ni entregar: corrija las cantidades o inhabilítelo.');
    if(!tl) avisos.push(pid + ' está en ' + estado + ' pero no tiene fecha de cierre (tl). El indicador de preparación no lo puede medir.');
  }
  if(etapa === 'FINALIZAR' && !tc)
    errores.push(pid + ': la hoja dice etapa FINALIZAR pero nunca inició despacho (no tiene tc). ' +
      'La etapa contradice los hechos.');
  if(estado === 'ENTREGADO' && !txt(ent.te))
    errores.push(pid + ' dice ENTREGADO y no tiene fecha de entrega (te).');
  if(txt(ent.te) && estado !== 'ENTREGADO')
    avisos.push(pid + ' tiene fecha de entrega pero su estado es ' + estado + '.');

  /* ---- exactamente dos partes F/R: invariante del expediente ---- */
  if(partes.length && partes.length !== 2)
    avisos.push(pid + ' tiene ' + partes.length + ' fila(s) en R2_Preparacion. El expediente espera exactamente dos, F y R.');

  /* ---- lineas ---- */
  det.forEach(function(l){
    var n = numero(l.Cant_solicitada) || 0, w = numero(l.Cant_despachada) || 0;
    var ref = txt(l.Referencia) || '(sin referencia)';
    if(w > n) errores.push(ref + ': despachadas ' + w + ' y solicitadas ' + n + '. No se puede entregar más de lo pedido.');
    if(n < 0 || w < 0) errores.push(ref + ': cantidades negativas.');
    if(w > 0 && numero(l.Precio_unitario) <= 0)
      errores.push(ref + ': se despacharon ' + w + ' unidades con precio 0. Una venta con precio cero no es una venta.');
    var dp = numero(l.Descuento_pct) || 0;
    if(dp < 0 || dp > 100) errores.push(ref + ': descuento de ' + dp + ' %.');
    if(txt(l.Como_se_suple).toUpperCase() === 'INVENTARIO' && w !== n && w > 0)
      avisos.push(ref + ': dice que salió de INVENTARIO pero se despacharon ' + w + ' de ' + n + '.');
  });
  var dg = numero(p.Descuento_global_pct) || 0;
  if(dg < 0 || dg > 100) errores.push('Descuento global de ' + dg + ' %.');

  /* ---- el total declarado contra el recalculado ---- */
  try{
    var f = apiFactura_(pid, ctx);
    var suma = 0;
    (f.lineas||[]).forEach(function(l){
      var bruto = numero(l.precio_unitario) * numero(l.cant_despachada);
      suma += bruto - bruto * (numero(l.descuento_pct)||0)/100;
    });
    if(dg) suma = suma - suma*dg/100;
    if(Math.abs(Math.round(suma) - Math.round(numero(f.total))) > 1)
      errores.push('El total del pedido (' + Math.round(numero(f.total)) + ') no cuadra con la suma de sus líneas (' +
        Math.round(suma) + ').');
  }catch(e){ avisos.push('No se pudo recalcular el total: ' + e.message); }

  /* ---- el pago del documento, si ya hay documento ---- */
  if(txt(ent.Doc_tipo)){
    var cp = cohPago_({ forma:ent.Forma_pago, medio:ent.Medio_pago, plazo:ent.Plazo_dias,
                        vence:ent.Vencimiento, fecha:ent.Doc_fecha }, 'documento de ' + pid);
    errores = errores.concat(cp.errores);
    avisos  = avisos.concat(cp.avisos);
  }

  /* ---- fechas en orden ---- */
  if(tc && tl && txt(tl) < txt(tc)) errores.push('El cierre (tl) es anterior al inicio de despacho (tc).');
  if(tl && txt(ent.te) && txt(ent.te) < txt(tl)) errores.push('La entrega (te) es anterior al cierre (tl).');

  return { ok:errores.length === 0, errores:errores, avisos:avisos,
           pedido:pid, estado:estado, etapa:etapa, lineas:det.length };
}

/* ---- APIs ---- */
function apiCoherenciaPedido(token, pid){
  sesionNativa_(token);
  try{ return cohPedido_(pid); }catch(e){ return { ok:false, errores:['Error al validar: ' + e.message] }; }
}

/* =====================================================================
   REVISION DE TODO EL LIBRO · para ejecutar desde el editor
   =====================================================================
   Recorre TODOS los pedidos y lista las contradicciones. Solo lee.
   Esto es lo que debi tener desde el principio: un sitio donde preguntar
   «que esta incoherente hoy» sin tener que mirar pantalla por pantalla.
   ===================================================================== */
function heralsaRevisarCoherencia(){
  var ini_ = new Date().getTime();
  var ctx_ = cohCtx_();                /* v5.3 · las cuatro hojas, una sola vez */
  var peds = ctx_.pedidos;
  Logger.log('===== REVISION DE COHERENCIA · ' + peds.length + ' pedidos · solo lectura =====');
  var conError = 0, conAviso = 0, limpios = 0;
  peds.forEach(function(p){
    var pid = txt(p.P_num);
    if(!pid) return;
    if(txt(p[COL_EST]).toUpperCase() === E_ANU) return;    /* los inhabilitados no cuentan */
    var r;
    try{ r = cohPedido_(pid, ctx_); }catch(e){ Logger.log(pid + ' · EXCEPCION: ' + e.message); return; }
    if(r.errores.length){
      conError++;
      Logger.log('');
      Logger.log('### ' + pid + ' · ' + r.estado + (r.etapa ? ' / ' + r.etapa : '') + ' · ' + r.lineas + ' linea(s)');
      r.errores.forEach(function(e){ Logger.log('   ERROR : ' + e); });
      r.avisos.forEach(function(a){ Logger.log('   aviso : ' + a); });
    }else if(r.avisos.length){
      conAviso++;
      Logger.log('');
      Logger.log('--- ' + pid + ' · ' + r.estado + ' · solo avisos');
      r.avisos.forEach(function(a){ Logger.log('   aviso : ' + a); });
    }else limpios++;
  });
  Logger.log('');
  Logger.log('===== RESUMEN =====');
  Logger.log('Con ERRORES (hay que corregir) : ' + conError);
  Logger.log('Solo con avisos               : ' + conAviso);
  Logger.log('Sin nada que reportar         : ' + limpios);
  var seg_ = ((new Date().getTime() - ini_) / 1000).toFixed(1);
  Logger.log('Tardo                         : ' + seg_ + ' s con ' + peds.length + ' pedido(s)');
  Logger.log('No se escribio nada.');
  return { conError:conError, conAviso:conAviso, limpios:limpios, segundos:Number(seg_) };
}


/* =====================================================================
   ENGANCHE · la validacion BLOQUEA el guardado del documento
   =====================================================================
   DEFECTO QUE SE CORRIGE: apiDocumento_ hacia
       var medio = txt(pago.medio) || 'Efectivo';
   es decir, si no llegaba medio de pago ponia «Efectivo» POR OMISION, sin
   mirar la forma de pago. Por eso salian facturas a credito a 30 dias con
   medio «Efectivo»: un documento que dice que entro plata que no entro.

   Esta envoltura se ejecuta ANTES del guardado. Si hay contradiccion, no
   guarda y devuelve el motivo en palabras. No se parchea la funcion
   original: se envuelve, asi que si manana cambia por dentro la
   validacion sigue puesta.
   ===================================================================== */
var apiDocumentoNativa_ = apiDocumento_;
apiDocumento_ = function(pid, tipo, operador, pago){
  pago = pago || {};
  var forma = txt(pago.forma) || 'Contado';
  var esCredito = forma.toUpperCase().indexOf('CRED') === 0;

  /* =====================================================================
     v5.4 · BUG_008 · a credito el medio lo FIJA el servidor
     =====================================================================
     Antes: si no llegaba medio se ponia «Credito», que cohPago_ aceptaba y
     AL_MEDIO rechazaba. Y si llegaba un medio concreto (porque el operador
     lo habia escogido antes de cambiar a credito), el documento se rechazaba
     por ilogico.
     Ahora, a credito, el medio es «Instrumento no definido» SIEMPRE, venga
     lo que venga del navegador. El servidor no confia en la pantalla para
     una regla de negocio; la impone. */
  if(esCredito) pago.medio = 'Instrumento no definido';

  /* v5.3 · RENDIMIENTO · un solo contexto para la validacion de pago, la
     del pedido y el recalculo de la factura. Antes esta envoltura leia R3 y
     CAT_Clientes, y despues cohPedido_ volvia a leer R3, R2_Preparacion,
     R2_Detalle, R4 y la factura: unas 17 lecturas completas por documento. */
  var ctxDoc_ = cohCtx_();
  var ped = ctxDoc_.pedPorNum[txt(pid)] || {};
  var cli = buscarEn(filas(H.clientes), 'Cliente', txt(ped.Cliente)) || {};
  var plazo = numero(pago.plazo !== undefined ? pago.plazo : cli.Plazo_dias) || 0;
  var venc  = txt(pago.vence) || (esCredito && plazo ? masDias(fechaHoy(), plazo) : '');

  var c = cohPago_({ forma:forma, medio:pago.medio, plazo:plazo, vence:venc, fecha:fechaHoy() },
                   'documento ' + txt(pid));
  if(!c.ok)
    return { ok:false, error:'No se guardo por incoherencia en los datos:\n· ' + c.errores.join('\n· ') };

  /* y la coherencia del pedido entero: no se documenta un pedido roto */
  var cp = cohPedido_(txt(pid), ctxDoc_);
  if(!cp.ok)
    return { ok:false, error:'No se guardo porque el pedido tiene contradicciones:\n· ' + cp.errores.join('\n· ') };

  return apiDocumentoNativa_(pid, tipo, operador, pago);
};


/* ####################################################################
   PRODUCCION
   #################################################################### */

/* =====================================================================
   HERALSA · VERIFICACION DE INTEGRIDAD Y PUESTA EN PRODUCCION
   =====================================================================
   PEGAR AL FINAL DE Codigo.gs.

   Tres funciones, en el orden en que hay que ejecutarlas:
     1. heralsaVerificarIntegridad()  · llaves, relaciones, expediente
     2. heralsaRecalcularIndicadores() · los diez, excluyendo anulados
     3. heralsaLimpiarParaProduccion() · BORRA. Pide confirmacion doble.

   Las dos primeras SOLO LEEN. La tercera borra, y por eso esta escrita
   para que no se pueda ejecutar por accidente.
   ===================================================================== */

/* =====================================================================
   1 · INTEGRIDAD · llaves primarias, foraneas y expediente
   ===================================================================== */
function heralsaVerificarIntegridad(){
  Logger.log('===== INTEGRIDAD DE LA BASE · solo lectura =====');
  var fallos = 0, avisos = 0;

  function dup(hojaN, llaves){
    var vistos = {}, dups = [];
    filas(hojaN).forEach(function(r){
      var k = llaves.map(function(c){ return low(r[c]); }).join('|');
      if(!k.replace(/\|/g,'')) return;
      if(vistos[k]) dups.push(k); else vistos[k] = 1;
    });
    Logger.log((dups.length ? 'FALLO ' : 'OK    ') + hojaN + ' · llave (' + llaves.join(',') + ') · ' +
      (dups.length ? dups.length + ' duplicada(s): ' + dups.slice(0,5).join(' · ') : 'sin duplicados'));
    return dups.length;
  }

  Logger.log('');
  Logger.log('--- LLAVES PRIMARIAS ---');
  fallos += dup(H.pedidos,     ['P_num']);
  fallos += dup(H.compras,     ['C_num']);
  fallos += dup(H.prep,        ['P_num','Tipo']);
  fallos += dup(H.prepDet,     ['P_num','Tipo','Referencia']);
  fallos += dup(H.detalle,     ['C_num','Codigo']);
  fallos += dup(H.productos,   ['Codigo']);
  fallos += dup(H.clientes,    ['Cliente']);
  fallos += dup(H.proveedores, ['Proveedor']);
  fallos += dup(H.mov,         ['Mov_num']);
  fallos += dup('MOV_Caja',    ['Caja_num']);
  fallos += dup('CAT_Usuarios',['Usuario_id']);

  Logger.log('');
  Logger.log('--- LLAVES FORANEAS ---');
  function fk(hijaN, campoHija, padreN, campoPadre){
    var padres = {};
    filas(padreN).forEach(function(r){ var v = low(r[campoPadre]); if(v) padres[v] = 1; });
    var huerf = [];
    filas(hijaN).forEach(function(r){
      var v = low(r[campoHija]);
      if(v && !padres[v]) huerf.push(txt(r[campoHija]));
    });
    var u = {}; huerf = huerf.filter(function(x){ if(u[x]) return false; u[x]=1; return true; });
    Logger.log((huerf.length ? 'FALLO ' : 'OK    ') + hijaN + '.' + campoHija + ' -> ' + padreN + '.' + campoPadre +
      ' · ' + (huerf.length ? huerf.length + ' sin padre: ' + huerf.slice(0,6).join(' · ') : 'todas resuelven'));
    return huerf.length;
  }
  fallos += fk(H.prep,     'P_num', H.pedidos, 'P_num');
  fallos += fk(H.prepDet,  'P_num', H.pedidos, 'P_num');
  fallos += fk(H.entregas, 'P_num', H.pedidos, 'P_num');
  fallos += fk(H.detalle,  'C_num', H.compras, 'C_num');
  fallos += fk(H.prepDet,  'Referencia', H.productos, 'Codigo');
  fallos += fk(H.detalle,  'Codigo',     H.productos, 'Codigo');
  fallos += fk(H.mov,      'Codigo',     H.productos, 'Codigo');

  Logger.log('');
  Logger.log('--- EXPEDIENTE · exactamente dos filas F/R por pedido ---');
  var porPed = {};
  filas(H.prep).forEach(function(r){
    var k = txt(r.P_num); if(!k) return;
    porPed[k] = porPed[k] || [];
    porPed[k].push(txt(r.Tipo).toUpperCase());
  });
  var malos = [];
  filas(H.pedidos).forEach(function(p){
    var pid = txt(p.P_num); if(!pid) return;
    if(txt(p[COL_EST]).toUpperCase() === E_ANU) return;
    var t = porPed[pid] || [];
    if(!t.length) return;                       /* sin preparacion todavia: legitimo */
    if(t.length !== 2 || t.indexOf('F') < 0 || t.indexOf('R') < 0)
      malos.push(pid + ' tiene [' + t.join(',') + ']');
  });
  Logger.log((malos.length ? 'FALLO ' : 'OK    ') + 'dos filas F/R · ' +
    (malos.length ? malos.length + ': ' + malos.slice(0,6).join(' · ') : 'todos los pedidos con preparacion tienen F y R'));
  fallos += malos.length;

  Logger.log('');
  Logger.log('--- TOTALES · R2_Detalle contra lo que muestra la app ---');
  var descuadres = [];
  filas(H.pedidos).forEach(function(p){
    var pid = txt(p.P_num); if(!pid) return;
    if(txt(p[COL_EST]).toUpperCase() === E_ANU) return;
    try{
      var f = apiFactura_(pid), suma = 0;
      (f.lineas||[]).forEach(function(l){
        var br = numero(l.precio_unitario) * numero(l.cant_despachada);
        suma += br - br * (numero(l.descuento_pct)||0)/100;
      });
      var dg = numero(p.Descuento_global_pct) || 0;
      if(dg) suma = suma - suma*dg/100;
      if(Math.abs(Math.round(suma) - Math.round(numero(f.total))) > 1)
        descuadres.push(pid + ': app ' + Math.round(numero(f.total)) + ' vs lineas ' + Math.round(suma));
    }catch(e){ avisos++; }
  });
  Logger.log((descuadres.length ? 'FALLO ' : 'OK    ') + 'totales · ' +
    (descuadres.length ? descuadres.join(' · ') : 'todos cuadran al peso'));
  fallos += descuadres.length;

  Logger.log('');
  Logger.log('--- TIPO DE DATO DEL CODIGO (D-26 · Alegra) ---');
  var sh = hoja(H.prepDet), ix = indices(sh), numericos = 0;
  if(sh.getLastRow() > 1 && ix.Referencia !== undefined){
    var col = sh.getRange(2, ix.Referencia+1, sh.getLastRow()-1, 1).getValues();
    col.forEach(function(r){ if(typeof r[0] === 'number') numericos++; });
  }
  Logger.log((numericos ? 'AVISO ' : 'OK    ') + 'R2_Detalle.Referencia · ' +
    (numericos ? numericos + ' fila(s) con el codigo como NUMERO. Alegra puede recibir «1035010.0» y no encontrar el item.'
               : 'todas como texto'));
  if(numericos) avisos++;

  Logger.log('');
  Logger.log('===== RESULTADO: ' + fallos + ' fallo(s), ' + avisos + ' aviso(s) =====');
  Logger.log(fallos ? 'NO esta listo: corrija los fallos antes de produccion.'
                    : 'Integridad correcta.');
  return { fallos:fallos, avisos:avisos };
}

/* =====================================================================
   2 · LOS DIEZ INDICADORES, EXCLUYENDO ANULADOS
   =====================================================================
   Se recalculan desde los hechos, y se cuenta cuantos registros anulados
   se dejaron fuera. Si un anulado entrara, el numero saldria distinto.
   ===================================================================== */
function heralsaRecalcularIndicadores(){
  Logger.log('===== LOS DIEZ INDICADORES · solo lectura =====');
  function vig(l){ return l.filter(function(r){ return txt(r[COL_EST]).toUpperCase() !== E_ANU; }); }
  var pedT = filas(H.pedidos), comT = filas(H.compras), detT = filas(H.detalle),
      preT = filas(H.prep),    prdT = filas(H.prepDet), entT = filas(H.entregas);
  var ped = vig(pedT), com = vig(comT), det = vig(detT), pre = vig(preT), prd = vig(prdT), ent = vig(entT);

  Logger.log('ANULADOS EXCLUIDOS: R3 ' + (pedT.length-ped.length) + ' · R1 ' + (comT.length-com.length) +
             ' · R1_Det ' + (detT.length-det.length) + ' · R2 ' + (preT.length-pre.length) +
             ' · R2_Det ' + (prdT.length-prd.length) + ' · R4 ' + (entT.length-ent.length));
  Logger.log('');

  function dias(a,b){ if(!a||!b) return null;
    var d1=new Date(String(a).substr(0,10)), d2=new Date(String(b).substr(0,10));
    return isNaN(d1)||isNaN(d2)?null:Math.round((d2-d1)/86400000); }
  function horas(a,b){ if(!a||!b) return null;
    var d1=new Date(String(a).replace(' ','T')), d2=new Date(String(b).replace(' ','T'));
    return isNaN(d1)||isNaN(d2)?null:(d2-d1)/3600000; }
  function prom(l){ return l.length ? l.reduce(function(a,b){return a+b;},0)/l.length : null; }
  function pct(a,b){ return b ? Math.round(a*1000/b)/10 : null; }
  function di(n,v,u,base){ Logger.log(' ' + n + ': ' + (v===null?'sin datos':(Math.round(v*100)/100)+(u||'')) +
    (base!==undefined?'   (n=' + base + ')':'')); }

  /* =====================================================================
     v5.5 · BUG_019 · LA MISMA GUARDA EN LOS TRES SITIOS
     =====================================================================
     El indicador 4 descartaba los tiempos negativos con h>=0. Los
     indicadores 1 y 8 solo comprobaban !==null, asi que ACEPTABAN dias
     negativos. Hoy P-012 tiene te anterior a tl y por eso metia un valor
     negativo en el promedio del indicador 8 y lo bajaba.
     Un promedio con un dato imposible no es un promedio: es un numero que
     parece bueno y esta mal. El dato negativo no se corrige aqui -- eso es
     una decision de negocio sobre que fecha esta equivocada -- pero no
     puede entrar en el promedio, y el n lo dice: si el pedido sale del
     denominador, el indicador avisa que lo midio sobre menos casos.
     ===================================================================== */
  /* 1 abastecimiento */ var l1=[]; det.forEach(function(r){var d=dias(r.tn,r.tr); if(d!==null&&d>=0)l1.push(d);});
  di('1 Abastecimiento        ', prom(l1), ' d', l1.length);
  /* 2 cumplimiento proveedor */ var ok2=det.filter(function(r){return txt(r.Estado_recepcion).toUpperCase()==='COMPLETA';}).length;
  di('2 Cumpl. proveedor      ', pct(ok2,det.length), ' %', det.length);
  /* 3 atrasado por insumo */ var ev3=ped.filter(function(p){return txt(p.Atrasado_por_insumo);}),
      s3=ev3.filter(function(p){return txt(p.Atrasado_por_insumo).toUpperCase()==='S';}).length;
  di('3 Atraso por insumo     ', pct(s3,ev3.length), ' %', ev3.length);
  /* 4 preparacion */ var l4=[]; pre.forEach(function(r){var h=horas(r.tc,r.tl); if(h!==null&&h>=0)l4.push(h);});
  di('4 Preparacion           ', prom(l4), ' h', l4.length);
  /* 5 surtido */ var ev5=pre.filter(function(r){return txt(r.Surtido_inventario);}),
      s5=ev5.filter(function(r){return txt(r.Surtido_inventario).toUpperCase()==='S';}).length;
  di('5 Surtido inventario    ', pct(s5,ev5.length), ' %', ev5.length);
  /* 6 despacho completo */ var ev6=ped.filter(function(p){return txt(p.Pedido_completo);}),
      s6=ev6.filter(function(p){return txt(p.Pedido_completo).toUpperCase()==='S';}).length;
  di('6 Despacho completo     ', pct(s6,ev6.length), ' %', ev6.length);
  /* 7 a tiempo */ var ev7=ped.filter(function(p){return txt(p.Listo_a_tiempo);}),
      s7=ev7.filter(function(p){return txt(p.Listo_a_tiempo).toUpperCase()==='S';}).length;
  di('7 Preparacion a tiempo  ', pct(s7,ev7.length), ' %', ev7.length);
  /* 8 entrega · v5.5 · BUG_019 · misma guarda que el 1 y el 4 */
  var l8=[], neg8=0; ent.forEach(function(r){var d=dias(r.tl,r.te); if(d===null)return; if(d<0){neg8++;return;} l8.push(d);});
  if(neg8) Logger.log(' >>> AVISO: ' + neg8 + ' entrega(s) con te ANTERIOR a tl quedaron fuera del indicador 8. ' +
    'Ejecute heralsaRevisarCoherencia para ver cuales: hay que corregir la fecha.');
  di('8 Entrega               ', prom(l8), ' d', l8.length);
  /* 9 costo de entrega */ var e9=ent.filter(function(r){return txt(r.te);}), g9=0;
  e9.forEach(function(r){ g9 += numero(r.Gasto_entrega)||0; });
  di('9 Costo entrega/pedido  ', e9.length?g9/e9.length:null, ' $', e9.length);
  /* 10 OTIF */ var ev10=ent.filter(function(r){return txt(r.te);}),
      s10=ev10.filter(function(r){ return ['Completa','A_tiempo','Sin_novedad','Documento_correcto']
        .every(function(c){ return txt(r[c]).toUpperCase()==='S'; }); }).length;
  di('10 OTIF                 ', pct(s10,ev10.length), ' %', ev10.length);

  Logger.log('');
  Logger.log('Cada indicador dice su n: si n=0 es «sin datos», NO cero por ciento.');
  Logger.log('Confundir las dos cosas es el error clasico de un tablero.');
  return { ok:true };
}

/* =====================================================================
   3 · LIMPIAR PARA PRODUCCION  ·  BORRA DATOS
   =====================================================================
   QUE BORRA: solo las hojas de OPERACION (R1..R4, MOV_*, LOG).
   QUE CONSERVA: los catalogos (productos, clientes, proveedores,
   materias), la configuracion y los usuarios. Esos son su activo.

   NO SE EJECUTA SOLA. Hay que:
     1. ejecutar heralsaLimpiarParaProduccion() -> solo SIMULA y dice que
        haria, sin borrar nada;
     2. leer el reporte;
     3. escribir la palabra de confirmacion dentro de la funcion y volver
        a ejecutar.
   Y antes de borrar hace una COPIA del libro completo.
   ===================================================================== */
function heralsaLimpiarParaProduccion(){
  var CONFIRMACION = '';     /* <- para borrar de verdad, escriba aqui: BORRAR DATOS DE PRUEBA */

  /* =====================================================================
     v5.5.6 · BUG_032 · LA LIMPIEZA SE OLVIDO DE DOS HOJAS
     =====================================================================
     LO QUE PASO, y lo vio el usuario en su propio registro: despues de
     limpiar, heralsaRevisarLogica dijo «las 4 venta(s) de mostrador
     cuadran con sus lineas». Quedaban 4 ventas en un libro que debia estar
     vacio, porque MOS_Ventas y MOS_Detalle NO ESTABAN EN NINGUNA DE LAS
     DOS LISTAS: ni en la que borra ni en la que conserva. Se olvidaron.

     Y era lo peor posible: una venta de mostrador escribe en CUATRO
     sitios -- MOS_Ventas, MOS_Detalle, MOV_Inventario y MOV_Caja. Se
     borraron los dos ultimos y se dejaron los dos primeros, asi que
     quedaron 4 ventas cuyo dinero y cuyo movimiento de inventario ya no
     existen. La simulacion no las mencionaba, asi que el operador no
     podia enterarse ni leyendola con cuidado.

     LA CORRECCION DE RAIZ no es añadir dos nombres a una lista: es que la
     funcion ya NO PUEDA olvidar una hoja. Ahora recorre TODAS las hojas
     del libro y exige que cada una este clasificada. Si encuentra una que
     no conoce, NO BORRA NADA y dice cual es. El dia que alguien agregue
     una hoja, esta funcion se detiene y pregunta en vez de dejarla atras
     en silencio.
     ===================================================================== */
  var operativas = [H.compras, H.detalle, H.prep, H.prepDet, H.pedidos, H.entregas, H.mov, 'MOV_Caja', H.log,
                    H_MOS, H_MOS_DET];
  var conserva   = [H.productos, H.clientes, H.proveedores, H.materias, H.cfg, 'CAT_Usuarios',
                    'TABLERO', 'LEEME'];
  var ss = libro();

  var sinClasificar = [];
  ss.getSheets().forEach(function(sh){
    var n = sh.getName();
    if(operativas.indexOf(n) < 0 && conserva.indexOf(n) < 0) sinClasificar.push(n);
  });
  if(sinClasificar.length){
    Logger.log('===== LIMPIEZA DETENIDA · NO SE BORRO NADA =====');
    Logger.log('');
    Logger.log('Hay hoja(s) que esta funcion no sabe clasificar:');
    sinClasificar.forEach(function(n){
      var sh = ss.getSheetByName(n);
      Logger.log('   ' + n + ': ' + (sh ? Math.max(0, sh.getLastRow()-1) : 0) + ' fila(s)');
    });
    Logger.log('');
    Logger.log('>>> No se borra nada hasta decidir que hacer con ellas. Una hoja sin');
    Logger.log('>>> clasificar en un «empezar de cero» es exactamente el defecto que');
    Logger.log('>>> dejo 4 ventas de mostrador huerfanas la vez anterior.');
    Logger.log('>>> Mande esta lista y se clasifican en una de las dos listas.');
    return { ok:false, sin_clasificar:sinClasificar };
  }

  Logger.log('===== LIMPIEZA PARA PRODUCCION =====');
  Logger.log('');
  Logger.log('SE BORRARIAN las filas de datos (la cabecera se conserva):');
  var total = 0;
  operativas.forEach(function(n){
    var sh = ss.getSheetByName(n);
    var f = sh ? Math.max(0, sh.getLastRow()-1) : 0;
    total += f;
    Logger.log('   ' + n + ': ' + f + ' fila(s)');
  });
  Logger.log('   TOTAL: ' + total + ' filas');
  Logger.log('');
  Logger.log('SE CONSERVAN intactas:');
  conserva.forEach(function(n){
    var sh = ss.getSheetByName(n);
    Logger.log('   ' + n + ': ' + (sh ? Math.max(0, sh.getLastRow()-1) : 0) + ' fila(s)');
  });

  if(CONFIRMACION !== 'BORRAR DATOS DE PRUEBA'){
    Logger.log('');
    Logger.log('>>> NO SE BORRO NADA. Esto fue una simulacion.');
    Logger.log('>>> Para borrar de verdad:');
    Logger.log('>>>   1. ejecute primero heralsaVerificarIntegridad y heralsaRecalcularIndicadores');
    Logger.log('>>>   2. anote los numeros que le interesen: se van a perder');
    Logger.log('>>>   3. en esta funcion, escriba en CONFIRMACION la frase:');
    Logger.log('>>>      BORRAR DATOS DE PRUEBA');
    Logger.log('>>>   4. guarde y vuelva a ejecutar');
    return { simulacion:true, filas:total };
  }

  /* ---- a partir de aqui SI borra ---- */
  var lock = LockService.getScriptLock();
  lock.waitLock(60000);
  try{
    var copia = ss.copy('HERALSA · RESPALDO antes de limpiar · ' + ahora().replace(/[: ]/g,'-'));
    Logger.log('');
    Logger.log('RESPALDO CREADO: ' + copia.getName());
    Logger.log('   (esta en su Google Drive; no lo borre hasta estar seguro)');

    var borradas = 0;
    operativas.forEach(function(n){
      var sh = ss.getSheetByName(n);
      if(!sh) return;
      var f = sh.getLastRow() - 1;
      if(f > 0){ sh.deleteRows(2, f); borradas += f; }
      Logger.log('   ' + n + ': ' + f + ' fila(s) borradas');
    });

    Logger.log('');
    Logger.log('===== LIMPIEZA TERMINADA · ' + borradas + ' filas borradas =====');
    Logger.log('Los catalogos y los usuarios NO se tocaron.');
    Logger.log('El siguiente pedido sera P-001 y la siguiente compra C-001.');
    Logger.log('');
    Logger.log('AHORA, antes de operar:');
    Logger.log('  1. ejecute heralsaVerificarIntegridad: debe dar 0 fallos');
    Logger.log('  2. cargue el inventario inicial con movimientos de entrada,');
    Logger.log('     NO escribiendo saldos a mano: el saldo se deriva del kardex.');
    return { ok:true, borradas:borradas, respaldo:copia.getName() };
  } finally { lock.releaseLock(); }
}


/* ####################################################################
   GUARDA DE ENTREGA
   #################################################################### */

/* ####################################################################
   v5.1 · LA ENTREGA NO SE PUEDE GUARDAR INCOHERENTE
   ####################################################################
   DIAGNOSTICO, separando lo que es dato viejo de lo que es defecto:

   P-001 · LISTO sin unidades -> DATO HEREDADO. El cierre YA esta
     protegido: apiPreparacion_ exige que LISTO no tenga faltantes y que
     INCOMPLETO tenga faltante real Y al menos una unidad despachada.
     P-001 entro con una version anterior del codigo. No hay nada que
     corregir en el codigo; hay que corregir el dato.

   P-012 · la entrega (te) es ANTERIOR al cierre (tl) -> DEFECTO REAL.
   P-007 · tiene te pero el estado sigue en LISTO      -> DEFECTO REAL.
   P-005 · ENTREGADO sin tl                            -> DEFECTO REAL.
     Los tres salen del mismo sitio: apiGuardar_ escribe R4_Entregas como
     una fila cualquiera, sin comprobar que las fechas vayan en orden ni
     que el estado del pedido acompañe al hecho. Una entrega anterior al
     cierre no existe en la realidad, y un pedido con fecha de entrega que
     sigue diciendo LISTO hace que el indicador 8 y el OTIF midan otra cosa.

   LO QUE SE CORRIGE AQUI: se envuelve apiGuardar_ y se valida ANTES de
   escribir. Si la entrega es incoherente, NO se guarda y se dice por que.
   Y si es coherente, el estado pasa a ENTREGADO en la misma operacion, de
   modo que no pueda quedar a medias.
   #################################################################### */
var apiGuardarNativa_ = apiGuardar_;
apiGuardar_ = function(datos){
  datos = datos || [];

  for(var i = 0; i < datos.length; i++){
    var d = datos[i];
    if(!d || d.hoja !== H.entregas) continue;
    var f = d.fila || {};
    var pid = txt((d.claves && d.claves[0] && d.claves[0].valor) || f.P_num);
    if(!pid) continue;

    var te = txt(f.te);
    if(!te) continue;                      /* no se esta registrando entrega */

    var ped = buscarEn(filas(H.pedidos), 'P_num', pid);
    if(!ped) return { ok:false, error:'El pedido ' + pid + ' no existe.' };
    if(txt(ped[COL_EST]).toUpperCase() === E_ANU)
      return { ok:false, error:pid + ' esta inhabilitado: no se puede registrar su entrega.' };

    /* ---- 1 · el pedido tiene que estar cerrado ---- */
    var partes = filas(H.prep).filter(function(r){
      return txt(r.P_num) === pid && txt(r[COL_EST]).toUpperCase() !== E_ANU;
    });
    var tl = txt(ped.Fecha_real_listo);
    if(!tl) partes.forEach(function(r){ if(txt(r.tl) && (!tl || txt(r.tl) > tl)) tl = txt(r.tl); });

    if(!tl)
      return { ok:false, error:'No se puede registrar la entrega de ' + pid +
        ': el pedido no tiene fecha de cierre (tl). Primero hay que cerrarlo en Finalizar. ' +
        'Sin cierre, el tiempo de preparacion y el de entrega no se pueden medir.' };

    /* ---- 2 · las fechas en orden ---- */
    if(txt(te).substr(0,10) < txt(tl).substr(0,10))
      return { ok:false, error:'No se guardo: la entrega de ' + pid + ' (' + txt(te).substr(0,10) +
        ') es ANTERIOR al cierre (' + txt(tl).substr(0,10) + '). ' +
        'Una entrega no puede ocurrir antes de que el pedido estuviera listo. Revise la fecha.' };

    /* ---- 3 · tiene que haber documento ---- */
    var entAnt = buscarEn(filas(H.entregas), 'P_num', pid) || {};
    var docTipo = txt(f.Doc_tipo) || txt(entAnt.Doc_tipo);
    if(!docTipo)
      return { ok:false, error:'No se puede registrar la entrega de ' + pid +
        ' sin documento. Emita la remision o la factura primero: sin documento no hay nada que el cliente reciba.' };

    /* ---- 4 · el estado acompaña al hecho, en la MISMA operacion ----
       asi no puede quedar un pedido con fecha de entrega que sigue
       diciendo LISTO, que es lo que le pasa hoy a P-007. */
    var yaTraeEstado = datos.some(function(x){
      return x && x.hoja === H.pedidos &&
             txt((x.claves && x.claves[0] && x.claves[0].valor) || (x.fila||{}).P_num) === pid &&
             txt((x.fila||{}).Estado).toUpperCase() === 'ENTREGADO';
    });
    if(!yaTraeEstado && txt(ped.Estado).toUpperCase() !== 'ENTREGADO')
      datos.push({ hoja:H.pedidos, claves:[{columna:'P_num', valor:pid}],
                   fila:{ P_num:pid, Estado:'ENTREGADO' } });

    /* ---- 5 · OTIF solo si sus cuatro condiciones se cumplen ----
       Un OTIF en S con una condicion en N es un indicador que miente. */
    var cuatro = ['Completa','A_tiempo','Sin_novedad','Documento_correcto'];
    var otif = txt(f.OTIF).toUpperCase();
    if(otif === 'S'){
      var fallan = cuatro.filter(function(c){
        var v = f[c] !== undefined ? f[c] : entAnt[c];
        return txt(v).toUpperCase() !== 'S';
      });
      if(fallan.length)
        return { ok:false, error:'No se guardo: la entrega de ' + pid + ' dice OTIF = S pero ' +
          fallan.join(', ') + ' no esta en S. OTIF solo es verdadero si la entrega es completa, ' +
          'a tiempo, sin novedad y con documento correcto.' };
    }
  }

  return apiGuardarNativa_(datos);
};


/* ####################################################################
   MOSTRADOR
   #################################################################### */

/* ####################################################################
   v5.2 · MOSTRADOR CON SU PROPIO EXPEDIENTE
   ####################################################################
   POR QUE SE SEPARA, y es la razon de fondo:
   una venta de mostrador NO tiene preparacion. No hay tc, ni tl, ni te,
   porque el cliente esta delante y se le entrega en el momento. Mientras
   compartia el consecutivo de R3_Pedidos pasaban dos cosas malas:
     1. consumia numeros de pedido (P-017 era una venta de mostrador);
     2. entraba en los indicadores 4, 7, 8 y 10 como un pedido con tiempos
        vacios, y eso NO es «sin datos»: es un cero que baja el promedio y
        miente.

   DECISIONES, que son las que el usuario confirmo:
     · consecutivo propio M-001, independiente de P- y de C-
     · dos registros por venta: cabecera en MOS_Ventas, lineas en MOS_Detalle
     · NO entra en los indicadores de preparacion ni de entrega
     · SI entra en caja (es dinero real) y SI descuenta inventario
     · precios de MINORISTA siempre
     · el numero de identificacion del cliente es OBLIGATORIO; nombre,
       correo, direccion y telefono son opcionales

   COMO QUEDA EXCLUIDA DE LOS INDICADORES: no escribiendo en R3_Pedidos.
   Los diez indicadores se calculan sobre R1..R4; si mostrador no esta
   ahi, queda fuera por construccion y no por un filtro que alguien pueda
   olvidar manana. Eso es mas seguro que excluirla con una condicion.
   #################################################################### */

var H_MOS     = 'MOS_Ventas';
var H_MOS_DET = 'MOS_Detalle';

var ESQUEMA_MOSTRADOR = {
  'MOS_Ventas': ['M_num','Fecha','Cliente','Cliente_id','Tipo_identificacion',
    'Numero_identificacion','Digito_verificacion','Correo','Telefono','Direccion',
    'Canal','Subtotal','Descuento_valor','IVA_valor','Total','Forma_pago','Medio_pago',
    'Doc_tipo','Doc_numero','Operador','Registrado_en',
    'Estado_registro','Motivo_anulacion','Anulado_por','Anulado_en'],
  /* v5.3 · ESPECIALES · un empaque fabricado a medida NO esta en el
     catalogo: no tiene codigo, no tiene precio de lista y no tiene saldo
     de inventario. Lo que SI tiene son las seis cosas que lo identifican,
     y son las que hay que poder buscar manana cuando el cliente vuelva
     pidiendo «el mismo de la vez pasada». Van como SEIS COLUMNAS en la
     misma hoja de detalle, no en una hoja nueva: una venta puede llevar
     productos de catalogo y especiales mezclados, y partirla en dos hojas
     obligaria a cruzarlas para saber cuanto se vendio. */
  'MOS_Detalle': ['M_num','Codigo','Descripcion','Cantidad','Precio_unitario',
    'Descuento_pct','IVA_pct','Total_linea','Costo_unitario','Registrado_en',
    'Es_especial','Esp_marca','Esp_parte','Esp_medida_x','Esp_medida_y','Esp_material',
    'Estado_registro','Motivo_anulacion','Anulado_por','Anulado_en']
};

/** Crea las dos hojas. Aditivo: si existen, no toca nada. Ejecutar una vez. */
function heralsaCrearHojasMostrador(){
  var ss = libro(), creadas = [];
  Object.keys(ESQUEMA_MOSTRADOR).forEach(function(n){
    var sh = ss.getSheetByName(n), cols = ESQUEMA_MOSTRADOR[n];
    if(!sh){
      sh = ss.insertSheet(n);
      sh.getRange(1,1,1,cols.length).setValues([cols]);
      creadas.push(n + ' (nueva, ' + cols.length + ' columnas)');
    }else{
      var enc = sh.getLastColumn() ? sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(txt) : [];
      var faltan = cols.filter(function(c){ return enc.indexOf(c) < 0; });
      faltan.forEach(function(c){ sh.getRange(1, sh.getLastColumn()+1).setValue(c); });
      if(faltan.length) creadas.push(n + ' (+' + faltan.length + ' columnas)');
    }
    if(typeof formatearHojaNativa_ === 'function') formatearHojaNativa_(sh);
    /* el codigo del producto como TEXTO: evita que 1035010 se vuelva 1035010.0 */
    if(n === 'MOS_Detalle'){
      var ix = indices(sh);
      if(ix.Codigo !== undefined) sh.getRange(2, ix.Codigo+1, Math.max(1, sh.getMaxRows()-1), 1).setNumberFormat('@');
    }
  });
  Logger.log(creadas.length ? 'LISTO: ' + creadas.join(' · ') : 'Las dos hojas ya estaban completas.');
  Logger.log('MOS_Ventas y MOS_Detalle NO entran en los diez indicadores: no viven en R1..R4.');
  return { ok:true, creadas:creadas };
}

/** Consecutivo propio: M-001, M-002… Nunca reutiliza un numero. */
function mosNuevoNum_(){
  var sh = libro().getSheetByName(H_MOS);
  if(!sh || sh.getLastRow() < 2) return 'M-' + ceros(1, DIGITOS);
  var ix = indices(sh);
  var col = sh.getRange(2, (ix.M_num||0)+1, sh.getLastRow()-1, 1).getValues();
  var max = 0;
  col.forEach(function(r){
    var m = String(r[0]||'').match(/(\d+)\s*$/);
    if(m) max = Math.max(max, parseInt(m[1],10));
  });
  return 'M-' + ceros(max+1, DIGITOS);
}

/* =====================================================================
   REGISTRAR UNA VENTA DE MOSTRADOR
   =====================================================================
   Un solo punto de entrada, dentro de un lock, con comprobante de
   idempotencia: si la respuesta se pierde y el vendedor reintenta, se
   devuelve la venta anterior en lugar de crear otra.
   ===================================================================== */
function apiMostradorVenta_(datos, operador){
  datos = datos || {};
  var lineas = datos.lineas || [];
  var errores = [];

  /* ---- 1 · la identificacion del cliente es OBLIGATORIA ---- */
  var numId = txt(datos.numId).replace(/\s+/g,'');
  if(!numId)
    return { ok:false, error:'Falta el numero de identificacion del cliente. ' +
      'Es obligatorio para una venta de mostrador: sin el no se puede documentar ni cobrar a nadie. ' +
      'El nombre, el correo y la direccion si son opcionales.' };
  var tipoId = txt(datos.tipoId) || 'CC';
  if(tipoId === 'NIT' && numId.indexOf('-') > 0){
    var pz = numId.split('-'), dv = dvNitDian(pz[0]);
    if(String(dv) !== txt(pz[1]))
      return { ok:false, error:'El digito de verificacion del NIT no corresponde: para ' + pz[0] +
        ' deberia ser ' + dv + '.' };
  }

  /* ---- 2 · lineas ---- */
  if(!lineas.length) return { ok:false, error:'La venta no tiene productos.' };
  var prods = {};
  filas(H.productos).forEach(function(r){ if(r.Codigo) prods[low(r.Codigo)] = r; });

  var detalle = [], subtotal = 0, descuento = 0, iva = 0, hayEspecial = false;
  lineas.forEach(function(l){
    var cod = txt(l.cod).toUpperCase();

    /* =================================================================
       v5.3 · UNA LINEA ESPECIAL · se fabrica a medida, no se busca
       =================================================================
       No pasa por el catalogo porque no esta en el catalogo, y eso es lo
       correcto: crear un producto nuevo por cada medida llenaria
       CAT_Productos de referencias que se venden una sola vez.
       Lo que SI se exige es que este completa. Un especial sin medidas o
       sin material es una linea que nadie va a poder reponer ni cotizar
       otra vez, y a los tres meses no se sabe que se vendio.
       ================================================================= */
    if(l.esp === true || txt(l.esp) === 'S'){
      var e = {
        marca:    txt(l.marca),
        parte:    txt(l.parte),
        x:        txt(l.mx),
        y:        txt(l.my),
        material: txt(l.material)
      };
      var faltaEsp = [];
      if(!e.marca)    faltaEsp.push('la marca del carro');
      if(!e.parte)    faltaEsp.push('la parte');
      if(!e.x)        faltaEsp.push('la medida X');
      if(!e.y)        faltaEsp.push('la medida Y');
      if(!e.material) faltaEsp.push('el material');
      if(faltaEsp.length){
        errores.push('Empaque especial incompleto: falta ' + faltaEsp.join(', ') +
          '. Sin eso no queda registro de que se fabrico.');
        return;
      }
      var cantE = numero(l.cant);
      if(!(cantE > 0)){ errores.push('Empaque especial ' + e.marca + ' ' + e.parte + ': cantidad invalida.'); return; }
      var precioE = numero(l.precio);
      if(!(precioE > 0)){
        errores.push('Empaque especial ' + e.marca + ' ' + e.parte +
          ': hay que ponerle precio. Un especial no tiene precio de lista.');
        return;
      }
      var dpctE = numero(l.dpct) || 0;
      if(dpctE < 0 || dpctE > 100){ errores.push('Empaque especial: descuento de ' + dpctE + ' %.'); return; }
      var ivaE   = numero(l.iva);
      if(!(ivaE >= 0)) ivaE = ESP_IVA_PCT;
      var brutoE = precioE * cantE;
      var descE  = brutoE * dpctE / 100;
      var netoE  = brutoE - descE;
      var ivaLE  = netoE * ivaE / 100;
      subtotal += brutoE; descuento += descE; iva += ivaLE;
      hayEspecial = true;
      detalle.push({ Codigo:COD_ESPECIAL,
        Descripcion:'ESPECIAL · ' + e.marca + ' · ' + e.parte + ' · ' + e.x + ' x ' + e.y + ' · ' + e.material,
        Cantidad:cantE, Precio_unitario:precioE, Descuento_pct:dpctE, IVA_pct:ivaE,
        Total_linea:Math.round(netoE + ivaLE), Costo_unitario:'',
        Es_especial:'S', Esp_marca:e.marca, Esp_parte:e.parte,
        Esp_medida_x:e.x, Esp_medida_y:e.y, Esp_material:e.material });
      return;
    }

    var p = prods[low(cod)];
    if(!p){ errores.push(cod + ' no esta en el catalogo.'); return; }
    var cant = numero(l.cant);
    if(!(cant > 0)){ errores.push(cod + ': cantidad invalida.'); return; }
    /* ---- EL PRECIO LO DECIDE EL CANAL DEL CLIENTE ----
       v5.2 · si la envoltura ya lo resolvio (cliente mayorista) viene en
       precioFijado. Si no, minorista, que es el caso conservador. */
    var precio = numero(l.precioFijado) > 0 ? numero(l.precioFijado) : numero(p.Precio_minorista);
    if(!(precio > 0)){ errores.push(cod + ' no tiene precio en el catalogo.'); return; }
    var dpct = numero(l.dpct) || 0;
    if(dpct < 0 || dpct > 100){ errores.push(cod + ': descuento de ' + dpct + ' %.'); return; }
    var ivaPct = numero(p.IVA) || 0;
    var bruto = precio * cant;
    var desc  = bruto * dpct / 100;
    var neto  = bruto - desc;
    var ivaL  = neto * ivaPct / 100;
    subtotal += bruto; descuento += desc; iva += ivaL;
    detalle.push({ Codigo:cod, Descripcion:txt(p.Descripcion), Cantidad:cant,
      Precio_unitario:precio, Descuento_pct:dpct, IVA_pct:ivaPct,
      Total_linea:Math.round(neto + ivaL), Costo_unitario:numero(p.Costo),
      Es_especial:'N' });
  });
  if(errores.length) return { ok:false, error:errores.join('\n') };

  var total = Math.round(subtotal - descuento + iva);
  if(!(total > 0)) return { ok:false, error:'La venta suma ' + total + '. No se puede registrar una venta sin valor.' };

  /* ---- 3 · forma y medio de pago coherentes ---- */
  var forma = txt(datos.forma) || 'Contado';
  var medio = txt(datos.medio) || (forma.toUpperCase().indexOf('CRED')===0 ? 'Credito' : 'Efectivo');
  if(typeof cohPago_ === 'function'){
    var cp = cohPago_({ forma:forma, medio:medio,
      plazo: forma.toUpperCase().indexOf('CRED')===0 ? (numero(datos.plazo)||30) : 0,
      vence: forma.toUpperCase().indexOf('CRED')===0 ? masDias(fechaHoy(), numero(datos.plazo)||30) : '',
      fecha: fechaHoy() }, 'venta de mostrador');
    if(!cp.ok) return { ok:false, error:'Incoherencia de pago:\n· ' + cp.errores.join('\n· ') };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try{
    /* ---- idempotencia: el mismo comprobante no se registra dos veces ---- */
    var sol = txt(datos.solicitud).substr(0,120);
    if(sol){
      var sh = libro().getSheetByName(H.log);
      if(sh && sh.getLastRow() > 1){
        var ixl = indices(sh);
        if(ixl.Registro !== undefined){
          var hall = sh.getRange(2, ixl.Registro+1, sh.getLastRow()-1, 1)
                       .createTextFinder('MOS / ' + sol).matchEntireCell(true).findAll();
          if(hall && hall.length){
            var prev = txt(sh.getRange(hall[0].getRow(), ixl.Valor_despues+1).getValue());
            return { ok:true, id:prev, idempotente:true, total:total,
                     nota:'Esta venta ya estaba registrada; no se duplico.' };
          }
        }
      }
    }

    var num = mosNuevoNum_(), marca = ahora();

    anexarBloque(H_MOS, ESQUEMA_MOSTRADOR['MOS_Ventas'], [{
      M_num:num, Fecha:marca, Cliente:txt(datos.cliente) || 'Mostrador',
      Cliente_id:txt(datos.clienteId), Tipo_identificacion:tipoId,
      Numero_identificacion:numId, Digito_verificacion:txt(datos.dv),
      Correo:txt(datos.correo), Telefono:txt(datos.telefono), Direccion:txt(datos.direccion),
      Canal:(txt(datos.canalResuelto) || 'R'), Subtotal:Math.round(subtotal), Descuento_valor:Math.round(descuento),
      IVA_valor:Math.round(iva), Total:total, Forma_pago:forma, Medio_pago:medio,
      Doc_tipo:txt(datos.docTipo) || 'TIRILLA', Doc_numero:txt(datos.docNumero),
      Operador:txt(operador), Registrado_en:marca, Estado_registro:E_VIG
    }]);

    detalle.forEach(function(d){ d.M_num = num; d.Registrado_en = marca; d.Estado_registro = E_VIG; });
    anexarBloque(H_MOS_DET, ESQUEMA_MOSTRADOR['MOS_Detalle'], detalle);

    /* ---- kardex: la venta de mostrador SI descuenta inventario ----
       v5.3 · PERO NO los especiales. Un empaque fabricado a medida no
       tiene saldo que descontar: no entro nunca a bodega. Si se le
       registrara una salida, MOV_Inventario quedaria con un codigo que no
       existe en CAT_Productos y el saldo de ese «producto» se iria a
       negativo para siempre. El consumo de la LAMINA con la que se corto
       es un movimiento de materia prima, que es otra cosa y hoy no se
       registra aqui: lo digo en claro en vez de inventar un movimiento. */
    var movs = detalle.filter(function(d){ return txt(d.Es_especial) !== 'S'; }).map(function(d){
      return { Codigo:d.Codigo, Descripcion:d.Descripcion, Tipo_mov:'SALIDA_VENTA',
               Cantidad:-Math.abs(d.Cantidad), Origen_doc:num, Origen_tipo:'MOSTRADOR',
               Observacion:'Venta de mostrador ' + num };
    });
    try{ apiMover_(movs, operador); }
    catch(e){ Logger.log('AVISO: el kardex no se pudo escribir: ' + e.message); }

    /* ---- caja: la venta de mostrador SI entra en caja ---- */
    if(forma.toUpperCase().indexOf('CRED') !== 0){
      try{
        anexarBloque('MOV_Caja', ESQUEMA_NATIVO.MOV_Caja, [{
          Caja_num:nuevoConsecutivo('MOV_Caja','CAJA',6), Fecha:marca, Tipo_mov:'INGRESO_VENTA',
          Medio_pago:medio, Valor:total, Tercero:txt(datos.cliente)||'Mostrador',
          Tercero_id:numId, Origen_tipo:'MOSTRADOR', Origen_doc:num, Operador:txt(operador),
          Observacion:'Venta de mostrador ' + num, Estado_registro:E_VIG }]);
      }catch(e){ Logger.log('AVISO: la caja no se pudo escribir: ' + e.message); }
    }

    /* ---- comprobante, para que un reintento no duplique ---- */
    if(sol){
      try{
        anexarBloque(H.log, HOJAS_F2['LOG_Cambios'], [{
          Log_num:nuevoConsecutivo(H.log,'L',4), Fecha:marca, Tabla:H_MOS,
          Registro:'MOS / ' + sol, Campo:'Mostrador_solicitud', Valor_antes:'',
          Valor_despues:num, Operador:txt(operador),
          Motivo:'Comprobante de venta de mostrador; permite reintentar sin duplicar' }]);
      }catch(e){}
    }

    return { ok:true, id:num, total:total, subtotal:Math.round(subtotal),
             descuento:Math.round(descuento), iva:Math.round(iva), lineas:detalle.length,
             especiales:detalle.filter(function(d){ return txt(d.Es_especial) === 'S'; }).length,
             fecha:marca, operador:txt(operador), detalle:detalle };
  } finally { lock.releaseLock(); }
}

/* =====================================================================
   PERMISOS DE PRECIO · solo ADMIN cambia precio, codigo o descuento
   ===================================================================== */
function mosPuedeCambiarPrecio_(s){ return s && s.rol === ROL_ADMIN; }

function apiMostradorVenta(token, datos){
  var s = sesionNativa_(token);
  if(typeof exigeClaveCambiada_ === 'function') exigeClaveCambiada_(s, 'apiMostradorVenta');
  datos = datos || {};
  /* si no es ADMIN, se ignora cualquier descuento que llegue del cliente:
     el precio minorista del catalogo es el que vale. No se rechaza la venta
     por eso -- se vende --, pero el descuento no se aplica. */
  /* v5.3 · EL PRECIO DE UN ESPECIAL NO ES UN DESCUENTO.
     Un empaque a medida no tiene precio de lista: si no lo pudiera poner
     el vendedor, no se podria vender. Lo que se sigue bloqueando a quien
     no es administrador es el DESCUENTO, que es lo que regala margen. El
     precio del especial queda registrado con nombre y hora en MOS_Detalle,
     que es lo que lo hace auditable. */
  if(!mosPuedeCambiarPrecio_(s))
    (datos.lineas||[]).forEach(function(l){ l.dpct = 0; });
  return apiMostradorVenta_(datos, s.nombre);
}
function apiMostradorPuedeDescuento(token){
  var s = sesionNativa_(token);
  return { ok:true, puede:mosPuedeCambiarPrecio_(s), rol:s.rol };
}

/* =====================================================================
   VERIFICACION · que mostrador quede fuera de los indicadores
   ===================================================================== */
function heralsaVerificarMostrador(){
  Logger.log('===== MOSTRADOR · verificacion · solo lectura =====');
  var v = filas(H_MOS), d = filas(H_MOS_DET);
  Logger.log('MOS_Ventas : ' + v.length + ' venta(s)');
  Logger.log('MOS_Detalle: ' + d.length + ' linea(s)');

  /* ninguna venta de mostrador debe estar en R3_Pedidos */
  var enR3 = filas(H.pedidos).filter(function(p){
    return txt(p.Tipo_venta).toUpperCase() === 'MOSTRADOR' || txt(p.Tipo_pedido).toUpperCase() === 'MOSTRADOR';
  });
  Logger.log('');
  Logger.log((enR3.length ? 'AVISO ' : 'OK    ') + 'ventas de mostrador en R3_Pedidos: ' + enR3.length +
    (enR3.length ? ' -> ' + enR3.map(function(p){return txt(p.P_num);}).slice(0,8).join(' · ') : ''));
  if(enR3.length){
    Logger.log('      Son registros ANTERIORES a la separacion. Estan contando como pedidos');
    Logger.log('      en los indicadores 4, 7, 8 y 10 con tiempos vacios. Al limpiar la base');
    Logger.log('      desaparecen; si no se limpia, conviene inhabilitarlos.');
  }

  /* huerfanas y totales */
  var nums = {}; v.forEach(function(r){ if(r.M_num) nums[txt(r.M_num)] = 1; });
  var huer = d.filter(function(r){ return txt(r.M_num) && !nums[txt(r.M_num)]; });
  Logger.log((huer.length ? 'FALLO ' : 'OK    ') + 'MOS_Detalle.M_num -> MOS_Ventas: ' +
    (huer.length ? huer.length + ' sin cabecera' : 'todas resuelven'));

  var malos = [];
  v.forEach(function(r){
    if(txt(r.Estado_registro).toUpperCase() === E_ANU) return;
    var suma = 0;
    d.forEach(function(l){ if(txt(l.M_num) === txt(r.M_num) && txt(l.Estado_registro).toUpperCase() !== E_ANU)
      suma += numero(l.Total_linea); });
    if(Math.abs(Math.round(suma) - Math.round(numero(r.Total))) > 1)
      malos.push(txt(r.M_num) + ': cabecera ' + Math.round(numero(r.Total)) + ' vs lineas ' + Math.round(suma));
  });
  Logger.log((malos.length ? 'FALLO ' : 'OK    ') + 'totales: ' + (malos.length ? malos.join(' · ') : 'cuadran'));

  var sinId = v.filter(function(r){ return !txt(r.Numero_identificacion); });
  Logger.log((sinId.length ? 'FALLO ' : 'OK    ') + 'identificacion obligatoria: ' +
    (sinId.length ? sinId.length + ' venta(s) sin numero' : 'todas la tienen'));

  Logger.log('');
  Logger.log('El consecutivo de mostrador es M-### e independiente de P- y C-.');
  Logger.log('Siguiente numero: ' + mosNuevoNum_());
  return { ventas:v.length, lineas:d.length, enR3:enR3.length };
}


/* ####################################################################
   MOSTRADOR · CLIENTE Y PRECIO
   #################################################################### */

/* ####################################################################
   v5.2 · MOSTRADOR · EL CLIENTE PRIMERO, Y EL PRECIO LO DECIDE SU CANAL
   ####################################################################
   CAMBIO DE LOGICA que pidio el usuario, y la razon es buena:
   un cliente MAYORISTA puede venir al mostrador por un solo producto, y
   debe pagar precio de mayorista. El canal es del CLIENTE, no del punto
   de venta. Antes el precio era siempre minorista por ser mostrador, y
   eso le cobraba de mas a sus clientes mayoristas.

   EL ORDEN NUEVO:
     1. se pide el NUMERO DE IDENTIFICACION
     2. se busca en CAT_Clientes
     3. si EXISTE  -> se cargan sus datos y su canal. El precio sale de
                      ahi: M = mayorista, R = minorista
     4. si NO EXISTE -> se crea como MINORISTA, y para crearlo hace falta
                      como minimo identificacion Y nombre
     5. si el cliente no quiere dar correo, telefono ni direccion, la
        venta se hace igual

   LO QUE NO SE ROMPE: no se toca apiCrearPedidoF2_ ni el flujo de
   pedidos. Los pedidos siguen leyendo el canal de CAT_Clientes como
   siempre. Aqui solo se agrega la busqueda por identificacion, que antes
   no existia porque el mostrador no preguntaba la cedula.
   #################################################################### */

/** Busca un cliente por su numero de identificacion. Devuelve su canal. */
function apiMostradorCliente(token, numId){
  var s = sesionNativa_(token);
  if(typeof exigeClaveCambiada_ === 'function') exigeClaveCambiada_(s, 'apiMostradorCliente');

  var n = txt(numId).replace(/[^0-9kK]/g, '');
  if(!n) return { ok:false, error:'Falta el numero de identificacion.' };

  var halla = null;
  filas(H.clientes).forEach(function(r){
    if(halla) return;
    if(txt(r[COL_EST]).toUpperCase() === E_ANU) return;
    var v = txt(r.Numero_identificacion).replace(/[^0-9kK]/g, '');
    if(v && v.split('-')[0] === n.split('-')[0]) halla = r;
  });

  if(!halla)
    return { ok:true, existe:false, numId:n,
      mensaje:'No esta registrado. Se creara como MINORISTA. Hace falta su nombre.' };

  var canal = canalDeClienteTexto_(halla.Canal_habitual || halla.Lista_precios);
  return { ok:true, existe:true, numId:n,
    cliente: txt(halla.Cliente),
    clienteId: txt(halla.Cliente_id),
    tipoId: txt(halla.Tipo_identificacion) || 'CC',
    canal: canal || 'R',
    canalDeclarado: !!canal,
    correo: txt(halla.Correo), telefono: txt(halla.Telefono),
    direccion: txt(halla.Direccion), municipio: txt(halla.Municipio),
    forma: txt(halla.Forma_pago), medio: txt(halla.Medio_pago),
    plazo: numero(halla.Plazo_dias) || 0,
    mensaje: txt(halla.Cliente) + ' · ' + (canal === 'M' ? 'MAYORISTA: precios de mayorista'
                                                         : 'MINORISTA: precios de minorista') };
}

/* =====================================================================
   v5.4 · BUG_002 · LA REGLA DEL CANAL · UNA ESPECIFICACION, DOS COPIAS
   =====================================================================
   Esta funcion y canalDeTexto_ del Index son LA MISMA REGLA escrita dos
   veces, y no se puede evitar: el navegador y Apps Script son dos tiempos
   de ejecucion separados y no comparten modulos. Lo que si se puede evitar
   es que se desincronicen sin que nadie lo note, asi que:

     · LA ESPECIFICACION, que es la unica fuente de verdad:
         vacio                      -> ''   (no se adivina: se PREGUNTA)
         M · MAY* · MAYORISTA       -> 'M'
         R · MIN* · DET*            -> 'R'
         cualquier otra cosa        -> ''   (no se adivina)
     · LA COLUMNA es CAT_Clientes.Canal_habitual, con Lista_precios como
       respaldo historico. Ojo: existe otra columna llamada `Canal` en
       R3_Pedidos y R4_Entregas, y NO es esta: esa es el canal con el que se
       cerro un pedido concreto.
     · SI SE CAMBIA AQUI hay que cambiar canalDeTexto_ en el Index, y
       heralsaVerificarCanal() comprueba que las dos digan lo mismo.
   ===================================================================== */
function canalDeClienteTexto_(v){
  var t = txt(v).toUpperCase();
  if(!t) return '';
  if(t === 'M' || t.indexOf('MAY') === 0) return 'M';
  if(t === 'R' || t.indexOf('MIN') === 0 || t.indexOf('DET') === 0) return 'R';
  return '';
}

/** Crea el cliente si no existe. Minimo: identificacion y nombre. */
function apiMostradorCrearCliente(token, datos){
  var s = operativo_(token, 'apiMostradorCrearCliente');
  datos = datos || {};
  var n = txt(datos.numId).replace(/[^0-9kK-]/g, '');
  var nombre = txt(datos.cliente).replace(/\s+/g, ' ');
  if(!n)      return { ok:false, error:'Falta el numero de identificacion.' };
  if(!nombre) return { ok:false, error:'Falta el nombre. Para crear un cliente hacen falta ' +
                                       'como minimo su identificacion y su nombre.' };

  var tipoId = txt(datos.tipoId) || 'CC';
  if(tipoId === 'NIT' && n.indexOf('-') > 0){
    var pz = n.split('-'), dv = dvNitDian(pz[0]);
    if(String(dv) !== txt(pz[1]))
      return { ok:false, error:'El digito de verificacion no corresponde: para ' + pz[0] +
               ' deberia ser ' + dv + '.' };
  }

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try{
    /* por si dos cajas lo crean a la vez */
    var ya = apiMostradorCliente(token, n);
    if(ya && ya.existe) return { ok:true, yaExistia:true, cliente:ya.cliente, canal:ya.canal };

    var repetido = buscarEn(filas(H.clientes), 'Cliente', nombre);
    if(repetido)
      return { ok:false, error:'Ya hay un cliente llamado "' + nombre + '" con otra identificacion. ' +
               'Use un nombre que lo distinga, o corrija la identificacion del existente.' };

    /* MINORISTA por omision: es lo que pidio el usuario. Un cliente nuevo
       de mostrador no es mayorista hasta que alguien lo decida en la hoja. */
    var r = apiAgregarCatalogo_('clientes', nombre, {
      canal:'R', tipoId:tipoId, numId:n,
      correo:txt(datos.correo), telefono:txt(datos.telefono),
      direccion:txt(datos.direccion), forma:'Contado'
    });
    if(!r || !r.ok) return { ok:false, error:'No se pudo crear el cliente.' };

    apiLogCambio_([{ Tabla:H.clientes, Registro:nombre, Campo:'Alta',
      Valor_antes:'', Valor_despues:tipoId + ' ' + n + ' · MINORISTA',
      Motivo:'Creado en mostrador por ' + s.nombre }], s.nombre);

    return { ok:true, creado:true, cliente:nombre, canal:'R', numId:n,
             mensaje:nombre + ' creado como MINORISTA.' };
  } finally { lock.releaseLock(); }
}

/* ####################################################################
   EL PRECIO SALE DEL CANAL DEL CLIENTE
   ####################################################################
   Se envuelve apiMostradorVenta_ para que el precio dependa del canal y
   no de que sea mostrador. Si no llega canal, se usa R, que es el caso
   conservador: cobrar precio de minorista a un mayorista se corrige con
   una nota; cobrarle de menos a quien no lo es, no.
   #################################################################### */
var apiMostradorVentaNativa_ = apiMostradorVenta_;
apiMostradorVenta_ = function(datos, operador){
  datos = datos || {};
  var canal = canalDeClienteTexto_(datos.canal) || 'R';

  /* se resuelve el precio AQUI y se pasa fijado, para que la funcion de
     abajo no tenga que adivinarlo */
  if(canal === 'M'){
    var prods = {};
    filas(H.productos).forEach(function(r){ if(r.Codigo) prods[low(r.Codigo)] = r; });
    var falta = [];
    (datos.lineas || []).forEach(function(l){
      if(l.esp === true || txt(l.esp) === 'S') return;   /* v5.3 · un especial no tiene precio de lista */
      var p = prods[low(txt(l.cod))];
      if(!p) return;
      var may = numero(p.Precio_mayorista);
      if(!(may > 0)){ falta.push(txt(l.cod)); return; }
      l.precioFijado = may;
    });
    if(falta.length)
      return { ok:false, error:'Estas referencias no tienen precio MAYORISTA en el catalogo: ' +
               falta.join(', ') + '. Corrijalo en CAT_Productos o venda a precio minorista.' };
  }
  datos.canalResuelto = canal;
  return apiMostradorVentaNativa_(datos, operador);
};

/* ####################################################################
   v5.3 · LAS PIEZAS NUEVAS, EN UN SOLO SITIO
   ####################################################################
   Cuatro cosas, y ninguna cambia una regla de negocio que ya estuviera
   funcionando:

     1. las constantes del empaque ESPECIAL
     2. heralsaCrearColumnasV53()  · crea las columnas nuevas. Aditivo.
     3. heralsaRevisarLogica()     · busca contradicciones de ESTRUCTURA.
     4. heralsaMedirGuardado()     · mide el coste real de leer y buscar.

   Las tres ultimas SOLO LEEN, salvo la primera, que solo AGREGA columnas
   al final de la fila de titulos y nunca mueve un dato.
   #################################################################### */

/* El codigo con el que se guarda un empaque fabricado a medida. NO existe
   en CAT_Productos a proposito: ver el comentario del esquema de
   MOS_Detalle. Es el mismo para todos los especiales; lo que distingue uno
   de otro son las seis columnas Esp_*. */
var COD_ESPECIAL = 'ESPECIAL';

/* El IVA por omision de un especial. Es el mismo 19 % que llevan las
   empaquetaduras del catalogo; se deja como constante y no escondido en
   el calculo para que el dia que cambie se cambie en un solo sitio. */
var ESP_IVA_PCT = 19;


/* =====================================================================
   2 · LAS COLUMNAS NUEVAS · ejecutar UNA vez, es re-ejecutable
   =====================================================================
   SIETE columnas, todas al FINAL de la fila de titulos. Como todo el acceso
   es por NOMBRE y nunca por posicion, agregar al final garantiza que
   ninguna celda que ya existe se mueva de sitio.

     R4_Entregas +1  Doc_vendedor                                (punto 3)
     MOS_Detalle +6  Es_especial y los cinco datos del especial   (punto 1)

   R2_Detalle NO LLEVA NINGUNA COLUMNA NUEVA: el precio corregido en
   Facturacion se escribe en Precio_unitario, que es la columna que ya
   existe, porque el pedido se vendio a ese precio. Lo que se protege es
   CAT_Productos, y eso no necesita columnas: necesita que ninguna ruta lo
   escriba, que es lo que comprueba heralsaRevisarLogica().

   Si ya estan, no hace nada y lo dice. No borra, no reordena, no formatea.
   ===================================================================== */
function heralsaCrearColumnasV53(){
  Logger.log('===== v5.3 · COLUMNAS NUEVAS =====');
  var plan = {};
  plan[H.entregas] = ['Doc_vendedor'];

  var creadas = 0, yaEstaban = 0;
  Object.keys(plan).forEach(function(nombre){
    var sh = libro().getSheetByName(nombre);
    if(!sh){ Logger.log('FALLO  no existe la hoja ' + nombre); return; }
    var enc = sh.getLastColumn() ? sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0].map(txt) : [];
    plan[nombre].forEach(function(c){
      if(enc.indexOf(c) >= 0){ yaEstaban++; Logger.log('OK     ' + nombre + ' · ' + c + ' ya existia'); return; }
      sh.getRange(1, sh.getLastColumn() + 1).setValue(c);
      enc.push(c); creadas++;
      Logger.log('CREADA ' + nombre + ' · ' + c);
    });
  });

  /* MOS_Detalle y MOS_Ventas las mantiene su propia funcion, que ya sabe
     agregar lo que falte del esquema. Se llama aqui para no tener que
     ejecutar dos cosas y acordarse del orden. */
  try{
    var r = heralsaCrearHojasMostrador();
    Logger.log('OK     MOS_Ventas / MOS_Detalle revisadas por heralsaCrearHojasMostrador()');
    if(r && r.creadas && r.creadas.length) Logger.log('       ' + r.creadas.join(' · '));
  }catch(e){ Logger.log('FALLO  mostrador: ' + e.message); }

  Logger.log('');
  Logger.log('Columnas creadas : ' + creadas);
  Logger.log('Ya estaban       : ' + yaEstaban);
  Logger.log('No se borro ni se movio ningun dato.');
  if(creadas) Logger.log('>>> Ahora ejecute heralsaRevisarLogica() para confirmar que todo cuadra.');
  return { ok:true, creadas:creadas, yaEstaban:yaEstaban };
}


/* =====================================================================
   3 · REVISION DE LOGICA · lo que heralsaRevisarCoherencia no ve
   =====================================================================
   POR QUE HACE FALTA, dicho sin adornos: los errores que se han corregido
   en este proyecto los encontro el usuario usando la aplicacion, no yo
   revisandola. El mas grave fue un pedido que no aparecia en NINGUNA
   seccion, porque las seis listas se construian con seis condiciones
   independientes y un pedido que no cumplia ninguna quedaba invisible. Eso
   no lo detecta una revision de coherencia de datos: los datos del pedido
   estaban bien. Lo que estaba mal era la ESTRUCTURA.

   Esta funcion comprueba invariantes de estructura: cosas que tienen que
   ser verdad siempre, y que si dejan de serlo significan que hay un
   defecto de programa, no un dato mal digitado.

   heralsaRevisarCoherencia  -> «este pedido se contradice a si mismo»
   heralsaRevisarLogica      -> «el sistema perdio o duplico algo»

   SOLO LEE. No escribe, no corrige, no borra.
   ===================================================================== */

/* v5.4.1 · AQUI HABIA UNA TERCERA COPIA DE LA CASCADA (logSeccionDe_), que
   heralsaRevisarLogica usaba para «poder compararla». Una copia para
   comparar es una copia que se desactualiza: se retira y la revision usa
   seccionDePedido_, la autoridad unica. Quien compara las dos
   implementaciones que de verdad existen -- la del servidor y la del
   navegador -- es heralsaVerificarSeccion(), con los datos reales. */

function heralsaRevisarLogica(){
  var ini = new Date().getTime();
  Logger.log('===== ' + VERSION_BACKEND + ' · REVISION DE LOGICA · solo lectura =====');
  var fallos = 0, avisos = 0;
  function F(t){ fallos++; Logger.log('FALLO  ' + t); }
  function A(t){ avisos++; Logger.log('aviso  ' + t); }
  function OK(t){ Logger.log('OK     ' + t); }

  var peds = filas(H.pedidos), prep = filas(H.prep), det = filas(H.prepDet), ents = filas(H.entregas);
  var movs = filas(H.mov), caja = filas('MOV_Caja'), prods = filas(H.productos), log = filas(H.log);
  var mosV = [], mosD = [];
  try{ mosV = filas(H_MOS); mosD = filas(H_MOS_DET); }catch(e){}

  var entPorNum = indicePor_(ents, 'P_num');
  var pedPorNum = indicePor_(peds, 'P_num');
  var vigentes = peds.filter(function(p){ return txt(p.P_num) && txt(p[COL_EST]).toUpperCase() !== E_ANU; });

  /* =====================================================================
     1 · LA REGLA DE LAS CINCO SECCIONES
     =====================================================================
     Un pedido ya creado esta SIEMPRE en uno de estos tres sitios, y en uno
     solo:

       · en una de las CINCO secciones donde un pedido espera trabajo:
         2 Organizar · 3 Despachar · 4 Finalizar · 5 Facturacion · 6 Entrega
         (la seccion 1, Crear, no es un sitio donde se espere: es el acto
          de crearlo)
       · en COMPLETADOS, si ya se entrego
       · en INHABILITADOS, si se anulo

     La unica razon para que un pedido pendiente o incompleto no aparezca
     en una de las cinco es un DEFECTO DE PROGRAMA, y eso es exactamente lo
     que paso con P-019: seis condiciones independientes y un pedido que no
     cumplia ninguna quedaba invisible. Por eso esto se cuenta y se suma:
     cinco secciones + completados + inhabilitados tiene que dar el total
     de pedidos de la hoja. Si no da, falta uno.
     ===================================================================== */
  Logger.log('');
  Logger.log('--- 1 · LAS CINCO SECCIONES + COMPLETADOS + INHABILITADOS ---');
  var porSeccion = { 0:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0 }, perdidos = [];
  /* v5.4.1 · se clasifica con la autoridad unica y con las hojas ya leidas,
     no con una copia local de la cascada. logSeccionDe_ queda retirada. */
  var prepPorPed_ = agrupaPor_(prep, 'P_num');
  var detPorPed_  = agrupaPor_(det, 'P_num');
  var todosPed = peds.filter(function(p){ return txt(p.P_num); });
  todosPed.forEach(function(p){
    var pid_ = txt(p.P_num);
    var n = seccionDePedido_(p, entPorNum[pid_] || {}, prepPorPed_[pid_] || [], detPorPed_[pid_] || []);
    if(porSeccion[n] === undefined){ perdidos.push(pid_ + ' (seccion ' + n + ')'); return; }
    porSeccion[n]++;
  });
  var enSecciones = porSeccion[2] + porSeccion[3] + porSeccion[4] + porSeccion[5] + porSeccion[6];
  var suma = enSecciones + porSeccion[7] + porSeccion[0];
  Logger.log('       2 Organizar     : ' + porSeccion[2]);
  Logger.log('       3 Despachar     : ' + porSeccion[3]);
  Logger.log('       4 Finalizar     : ' + porSeccion[4]);
  Logger.log('       5 Facturacion   : ' + porSeccion[5]);
  Logger.log('       6 Entrega       : ' + porSeccion[6]);
  Logger.log('       --------------------------');
  Logger.log('       en las 5 secciones (pendientes o incompletos) : ' + enSecciones);
  Logger.log('       COMPLETADOS (entregados)                      : ' + porSeccion[7]);
  Logger.log('       INHABILITADOS (anulados)                      : ' + porSeccion[0]);
  Logger.log('       TOTAL de pedidos en R3_Pedidos                : ' + todosPed.length);
  if(perdidos.length) F('hay ' + perdidos.length + ' pedido(s) que no caen en ningun sitio: ' + perdidos.join(' · ') +
    '. Es un defecto de programa: ningun pedido puede ser invisible.');
  else if(suma !== todosPed.length) F('la suma da ' + suma + ' y en la hoja hay ' + todosPed.length +
    ' pedido(s). Faltan ' + (todosPed.length - suma) + '.');
  else OK('los ' + todosPed.length + ' pedido(s) estan en exactamente un sitio: ' + enSecciones +
    ' en las 5 secciones, ' + porSeccion[7] + ' completados, ' + porSeccion[0] + ' inhabilitados');

  /* y se nombran los que estan en cada seccion, para poder cotejarlos con
     lo que muestra la pantalla sin tener que creerle a nadie */
  [2,3,4,5,6].forEach(function(n){
    var l = todosPed.filter(function(p){
      var pid_ = txt(p.P_num);
      return seccionDePedido_(p, entPorNum[pid_] || {}, prepPorPed_[pid_] || [], detPorPed_[pid_] || []) === n;
    }).map(function(p){ return txt(p.P_num); });
    if(l.length) Logger.log('       seccion ' + n + ' -> ' + l.join(' · '));
  });

  /* ---- 2 · los consecutivos no se repiten ni se cruzan ---- */
  Logger.log('');
  Logger.log('--- 2 · CONSECUTIVOS ---');
  function dupsDe(lista, campo){
    var v = {}, d = [];
    lista.forEach(function(r){ var k = low(r[campo]); if(!k) return; if(v[k]) d.push(txt(r[campo])); else v[k] = 1; });
    return d;
  }
  var dP = dupsDe(peds, 'P_num'), dM = dupsDe(mosV, 'M_num'), dC = dupsDe(filas(H.compras), 'C_num');
  if(dP.length) F('R3_Pedidos tiene P_num repetido: ' + dP.slice(0,8).join(' · ')); else OK('R3_Pedidos sin P_num repetido');
  if(dC.length) F('R1_Compras tiene C_num repetido: ' + dC.slice(0,8).join(' · ')); else OK('R1_Compras sin C_num repetido');
  if(dM.length) F('MOS_Ventas tiene M_num repetido: ' + dM.slice(0,8).join(' · ')); else OK('MOS_Ventas sin M_num repetido');

  var mezcla = mosV.filter(function(m){ return !/^M-/.test(txt(m.M_num)); });
  if(mezcla.length) F('MOS_Ventas tiene ' + mezcla.length + ' numero(s) que no empiezan por M-: una venta de mostrador no puede usar la numeracion de los pedidos.');
  else OK('toda venta de mostrador usa su propia numeracion M-###');

  var mosEnR3 = peds.filter(function(p){ return txt(p.Tipo_venta).toUpperCase() === 'MOSTRADOR' || txt(p.Tipo_pedido).toUpperCase() === 'MOSTRADOR'; });
  if(mosEnR3.length) A('hay ' + mosEnR3.length + ' venta(s) de mostrador dentro de R3_Pedidos (' +
    mosEnR3.map(function(p){ return txt(p.P_num); }).slice(0,6).join(' · ') +
    '). Son de antes de separar mostrador: cuentan como pedidos con tiempos vacios en los indicadores 4, 7, 8 y 10.');
  else OK('ninguna venta de mostrador contamina R3_Pedidos');

  /* ---- 3 · nada huerfano ---- */
  Logger.log('');
  Logger.log('--- 3 · FILAS HUERFANAS ---');
  function huerfanas(lista, campo, indice, nombre, padre){
    var h = lista.filter(function(r){ return txt(r[campo]) && !indice[txt(r[campo])]; });
    if(h.length) F(nombre + ' tiene ' + h.length + ' fila(s) cuyo ' + campo + ' no existe en ' + padre + ': ' +
      h.map(function(r){ return txt(r[campo]); }).slice(0,6).join(' · '));
    else OK(nombre + ' -> ' + padre + ' sin huerfanas');
    return h.length;
  }
  huerfanas(prep, 'P_num', pedPorNum, 'R2_Preparacion', 'R3_Pedidos');
  huerfanas(det,  'P_num', pedPorNum, 'R2_Detalle',     'R3_Pedidos');
  huerfanas(ents, 'P_num', pedPorNum, 'R4_Entregas',    'R3_Pedidos');
  if(mosV.length || mosD.length) huerfanas(mosD, 'M_num', indicePor_(mosV, 'M_num'), 'MOS_Detalle', 'MOS_Ventas');

  /* el expediente son CUATRO filas: R3 + dos de R2_Preparacion + R4 */
  var sinExpediente = [];
  vigentes.forEach(function(p){
    var id = txt(p.P_num);
    var np = prep.filter(function(r){ return txt(r.P_num) === id; }).length;
    if(np !== 2 || !entPorNum[id]) sinExpediente.push(id + ' (' + np + ' fila(s) en R2_Preparacion' + (entPorNum[id] ? '' : ', sin R4') + ')');
  });
  if(sinExpediente.length) F('el expediente espera 2 filas en R2_Preparacion y 1 en R4 por pedido; no cuadra en: ' + sinExpediente.slice(0,8).join(' · '));
  else OK('los ' + vigentes.length + ' expediente(s) tienen sus 4 filas');

  /* ---- 4 · un documento, un numero ---- */
  Logger.log('');
  Logger.log('--- 4 · DOCUMENTOS ---');
  var porNumDoc = {}, docDup = [];
  ents.forEach(function(e){
    var n = low(e.Doc_numero);
    if(!n || txt(e[COL_EST]).toUpperCase() === E_ANU) return;
    if(porNumDoc[n]) docDup.push(txt(e.Doc_numero) + ' en ' + porNumDoc[n] + ' y ' + txt(e.P_num));
    else porNumDoc[n] = txt(e.P_num);
  });
  if(docDup.length) F('el mismo numero de documento esta en dos pedidos: ' + docDup.slice(0,6).join(' · '));
  else OK('ningun numero de documento esta repetido');

  var docSinListo = ents.filter(function(e){
    if(!txt(e.Doc_tipo) || txt(e[COL_EST]).toUpperCase() === E_ANU) return false;
    var p = pedPorNum[txt(e.P_num)];
    return p && ['LISTO','ENTREGADO'].indexOf(txt(p.Estado).toUpperCase()) < 0;
  });
  if(docSinListo.length) F('hay ' + docSinListo.length + ' documento(s) emitido(s) sobre pedidos que no estan LISTO ni ENTREGADO: ' +
    docSinListo.map(function(e){ return txt(e.P_num); }).slice(0,6).join(' · '));
  else OK('todo documento cuelga de un pedido LISTO o ENTREGADO');

  /* ---- 5 · caja · D-10, el ingreso duplicado ---- */
  Logger.log('');
  Logger.log('--- 5 · CAJA ---');
  var porDoc = {}, cajaDup = [];
  caja.forEach(function(m){
    if(txt(m[COL_EST]).toUpperCase() === E_ANU) return;
    if(txt(m.Tipo_mov).toUpperCase() !== 'INGRESO_VENTA') return;
    var k = low(m.Origen_doc);
    if(!k) return;
    porDoc[k] = (porDoc[k] || 0) + 1;
  });
  Object.keys(porDoc).forEach(function(k){ if(porDoc[k] > 1) cajaDup.push(k + ' (' + porDoc[k] + ' ingresos)'); });
  if(cajaDup.length) F('el mismo documento entro a caja mas de una vez: ' + cajaDup.slice(0,8).join(' · ') +
    '. Es dinero contado dos veces.');
  else OK('ningun documento entro a caja dos veces');

  var cajaSinDoc = caja.filter(function(m){
    if(txt(m[COL_EST]).toUpperCase() === E_ANU) return false;
    if(txt(m.Tipo_mov).toUpperCase() !== 'INGRESO_VENTA') return false;
    var id = txt(m.Origen_doc);
    if(!id) return true;
    if(/^M-/.test(id)) return !indicePor_(mosV, 'M_num')[id];
    return !pedPorNum[id];
  });
  if(cajaSinDoc.length) F('hay ' + cajaSinDoc.length + ' ingreso(s) de caja cuyo documento de origen no existe: ' +
    cajaSinDoc.map(function(m){ return txt(m.Caja_num) + '->' + txt(m.Origen_doc); }).slice(0,6).join(' · '));
  else OK('todo ingreso de caja apunta a un documento que existe');

  /* =====================================================================
     v5.5.6 · BUG_033 · LA COMPROBACION QUE SOLO MIRABA HACIA UN LADO
     =====================================================================
     TODO lo de arriba pregunta «¿el origen de este movimiento existe?».
     NADIE preguntaba lo contrario: «¿esta venta dejo su rastro?». Y con
     una de las dos hojas vacia, la pregunta de un solo lado es
     VERDADERA POR FALTA DE DATOS.

     ASI SE ESCAPO, y lo vio el usuario y no yo: despues de limpiar la base
     quedaron 4 ventas de mostrador cuyo dinero y cuyo movimiento de
     inventario SI se habian borrado. Esta revision dijo «la estructura
     esta consistente» con 0 fallos, porque «todo ingreso de caja apunta a
     un documento que existe» es cierto cuando no hay ningun ingreso de
     caja. Un verificador que aprueba un libro incoherente es peor que no
     tener verificador.

     LA REGLA: toda comprobacion de relacion se hace en LAS DOS
     direcciones. Si una venta se cobro, su dinero tiene que estar; si
     saco unidades, el kardex tiene que decirlo.
     ===================================================================== */
  var ingPorDoc_ = {};
  caja.forEach(function(m){
    if(txt(m[COL_EST]).toUpperCase() === E_ANU) return;
    if(txt(m.Tipo_mov).toUpperCase() !== 'INGRESO_VENTA') return;
    ingPorDoc_[txt(m.Origen_doc)] = true;
  });

  /* ventas de mostrador de contado SIN su ingreso en caja */
  var mosSinCaja = mosV.filter(function(v){
    if(txt(v[COL_EST]).toUpperCase() === E_ANU) return false;
    if(txt(v.Forma_pago).toUpperCase().indexOf('CRED') === 0) return false;   /* a credito no entra en caja */
    return !ingPorDoc_[txt(v.M_num)];
  });
  if(mosSinCaja.length) F('hay ' + mosSinCaja.length + ' venta(s) de mostrador de contado SIN su ingreso en caja: ' +
    mosSinCaja.map(function(v){ return txt(v.M_num); }).slice(0,8).join(' · ') +
    '. Se cobro dinero que la caja no tiene registrado.');
  else OK('toda venta de mostrador de contado tiene su ingreso en caja');

  /* documentos de pedido de contado SIN su ingreso en caja */
  var docSinCaja = ents.filter(function(e){
    if(txt(e[COL_EST]).toUpperCase() === E_ANU) return false;
    if(!txt(e.Doc_tipo)) return false;
    if(txt(e.Forma_pago).toUpperCase().indexOf('CRED') === 0) return false;
    return !ingPorDoc_[txt(e.P_num)];
  });
  if(docSinCaja.length) F('hay ' + docSinCaja.length + ' documento(s) de pedido de contado SIN su ingreso en caja: ' +
    docSinCaja.map(function(e){ return txt(e.P_num) + ' ' + txt(e.Doc_numero); }).slice(0,8).join(' · ') +
    '. El documento dice que se cobro y la caja no lo tiene.');
  else OK('todo documento de pedido de contado tiene su ingreso en caja');

  /* ---- 6 · kardex ---- */
  Logger.log('');
  Logger.log('--- 6 · KARDEX ---');
  var codsCat = {};
  prods.forEach(function(p){ if(txt(p.Codigo)) codsCat[low(p.Codigo)] = 1; });
  filas(H.materias).forEach(function(m){ if(txt(m.Codigo)) codsCat[low(m.Codigo)] = 1; });
  var movHuerf = {}, nHuerf = 0;
  movs.forEach(function(m){
    if(txt(m[COL_EST]).toUpperCase() === E_ANU) return;
    var c = low(m.Codigo);
    if(!c || codsCat[c]) return;
    if(!movHuerf[c]){ movHuerf[c] = 1; nHuerf++; }
  });
  if(nHuerf) F('MOV_Inventario mueve ' + nHuerf + ' codigo(s) que no estan en ningun catalogo: ' +
    Object.keys(movHuerf).slice(0,8).join(' · ').toUpperCase() +
    '. Su saldo nunca va a cuadrar porque el producto no existe.');
  else OK('todo movimiento de kardex apunta a un codigo del catalogo');

  var espEnKardex = movs.filter(function(m){ return low(m.Codigo) === low(COD_ESPECIAL); });
  if(espEnKardex.length) F('hay ' + espEnKardex.length + ' movimiento(s) de kardex del codigo ' + COD_ESPECIAL +
    '. Un empaque fabricado a medida no tiene saldo de inventario: no puede tener movimientos.');
  else OK('ningun empaque especial toco el inventario');

  /* ---- 7 · mostrador ---- */
  Logger.log('');
  Logger.log('--- 7 · MOSTRADOR ---');
  if(!mosV.length && !mosD.length) OK('todavia no hay ventas de mostrador que revisar');
  else{
    var sinId = mosV.filter(function(m){ return !txt(m.Numero_identificacion); });
    if(sinId.length) F('hay ' + sinId.length + ' venta(s) de mostrador sin identificacion del cliente: ' +
      sinId.map(function(m){ return txt(m.M_num); }).slice(0,6).join(' · ') + '. Es obligatoria.');
    else OK('toda venta de mostrador tiene la identificacion del cliente');

    var espMal = mosD.filter(function(d){
      if(txt(d.Es_especial) !== 'S') return false;
      return !txt(d.Esp_marca) || !txt(d.Esp_parte) || !txt(d.Esp_medida_x) || !txt(d.Esp_medida_y) || !txt(d.Esp_material);
    });
    if(espMal.length) F('hay ' + espMal.length + ' empaque(s) especial(es) sin sus datos completos: ' +
      espMal.map(function(d){ return txt(d.M_num); }).slice(0,6).join(' · ') +
      '. Sin marca, parte, medidas y material no se puede volver a fabricar.');
    else OK('todo empaque especial tiene marca, parte, medidas y material');

    var cuadra = [], descuadra = [];
    mosV.forEach(function(v){
      var l = mosD.filter(function(d){ return txt(d.M_num) === txt(v.M_num) && txt(d[COL_EST]).toUpperCase() !== E_ANU; });
      if(!l.length){ descuadra.push(txt(v.M_num) + ' sin lineas'); return; }
      var s = 0;
      l.forEach(function(d){ s += numero(d.Total_linea) || 0; });
      if(Math.abs(Math.round(s) - Math.round(numero(v.Total))) > l.length + 1)
        descuadra.push(txt(v.M_num) + ' dice ' + Math.round(numero(v.Total)) + ' y sus lineas suman ' + Math.round(s));
      else cuadra.push(txt(v.M_num));
    });
    if(descuadra.length) F('el total de la venta no cuadra con sus lineas en: ' + descuadra.slice(0,6).join(' · '));
    else OK('las ' + cuadra.length + ' venta(s) de mostrador cuadran con sus lineas');

    /* v5.5.6 · BUG_033 · la otra direccion: la venta saco unidades de
       bodega, asi que el kardex tiene que decirlo. Los especiales no
       cuentan: no entraron nunca a bodega y por eso no mueven kardex. */
    var kardexPorDoc_ = {};
    movs.forEach(function(m){
      if(txt(m[COL_EST]).toUpperCase() === E_ANU) return;
      kardexPorDoc_[txt(m.Origen_doc)] = true;
    });
    var mosSinKardex = mosV.filter(function(v){
      if(txt(v[COL_EST]).toUpperCase() === E_ANU) return false;
      var lin = mosD.filter(function(d){
        return txt(d.M_num) === txt(v.M_num) && txt(d[COL_EST]).toUpperCase() !== E_ANU
               && txt(d.Es_especial) !== 'S';
      });
      if(!lin.length) return false;        /* solo especiales: no mueve kardex, es correcto */
      return !kardexPorDoc_[txt(v.M_num)];
    });
    if(mosSinKardex.length) F('hay ' + mosSinKardex.length + ' venta(s) de mostrador que sacaron producto de catalogo ' +
      'y NO dejaron movimiento en el kardex: ' + mosSinKardex.map(function(v){ return txt(v.M_num); }).slice(0,8).join(' · ') +
      '. El saldo de inventario esta mas alto que la realidad.');
    else OK('toda venta de mostrador con producto de catalogo dejo su movimiento de kardex');
  }

  /* ---- 8 · PUNTO 4 · el catalogo no se edita desde Facturacion ---- */
  Logger.log('');
  Logger.log('--- 8 · PRECIOS · el pedido cambia, el catalogo no ---');
  var ixEnt = indices(hoja(H.entregas));
  if(ixEnt['Doc_vendedor'] === undefined)
    F('R4_Entregas no tiene la columna Doc_vendedor. Ejecute heralsaCrearColumnasV53() una vez.');
  else OK('R4_Entregas tiene la columna Doc_vendedor (vendedor del documento)');

  /* a · todo cambio de precio de una linea tiene que estar registrado */
  var regLinea = {};
  log.forEach(function(l){
    if(txt(l.Tabla) !== 'R2_Detalle') return;
    if(['Precio_unitario','Descuento_pct'].indexOf(txt(l.Campo)) < 0) return;
    regLinea[low(l.Registro)] = txt(l.Motivo);
  });
  var sinMotivo = [];
  Object.keys(regLinea).forEach(function(k){ if(!regLinea[k]) sinMotivo.push(k); });
  if(sinMotivo.length) F('hay ' + sinMotivo.length + ' cambio(s) de precio de línea sin motivo escrito: ' +
    sinMotivo.slice(0,6).join(' · ') + '. Un precio cambiado sin motivo no se puede defender.');
  else OK(Object.keys(regLinea).length + ' cambio(s) de precio de línea, todos con motivo');

  /* b · LO IMPORTANTE DEL PUNTO 4: ninguna correccion de factura puede
         haber tocado CAT_Productos. Se mira al contrario de lo habitual:
         no se busca lo que falta, se busca lo que NO deberia estar. */
  var catTocado = log.filter(function(l){
    if(txt(l.Tabla) !== H.productos) return false;
    var m = low(l.Motivo);
    return m.indexOf('factur') >= 0 || m.indexOf('documento') >= 0 || m.indexOf('remision') >= 0 || m.indexOf('remisión') >= 0;
  });
  if(catTocado.length) F('hay ' + catTocado.length + ' cambio(s) en CAT_Productos cuyo motivo viene de una ' +
    'facturación: ' + catTocado.map(function(l){ return txt(l.Registro) + '/' + txt(l.Campo); }).slice(0,6).join(' · ') +
    '. Corregir el precio de UNA venta no puede cambiar el precio del catálogo.');
  else OK('ninguna corrección de factura modificó CAT_Productos');

  /* c · y los precios del catalogo que cambiaron, con su motivo propio */
  var catCambios = log.filter(function(l){
    return txt(l.Tabla) === H.productos &&
      ['Precio_minorista','Precio_mayorista','Costo'].indexOf(txt(l.Campo)) >= 0;
  });
  Logger.log('       cambios de precio en el catálogo (ruta propia, con motivo): ' + catCambios.length);
  catCambios.slice(0,5).forEach(function(l){
    Logger.log('         ' + txt(l.Registro) + ' · ' + txt(l.Campo) + ' · ' +
      txt(l.Valor_antes) + ' -> ' + txt(l.Valor_despues) + ' · ' + txt(l.Operador));
  });

  /* ---- 9 · v5.4 · BUG_004 · la cabecera no se contradice ---- */
  Logger.log('');
  Logger.log('--- 9 · CABECERA DEL PEDIDO · Estado contra Etapa (BUG_004) ---');
  var contra = [];
  peds.forEach(function(cab){
    var pid = txt(cab.P_num);
    if(!pid || txt(cab[COL_EST]).toUpperCase() === E_ANU) return;
    var est = txt(cab.Estado).toUpperCase(), eta = txt(cab.Etapa_preparacion).toUpperCase();
    var cerrado = (est === 'LISTO' || est === 'ENTREGADO');
    var conocida = ['ORGANIZAR','DESPACHAR','FINALIZAR','LISTO'].indexOf(eta) >= 0;
    var teCab = txt((entPorNum[pid] || {}).te);
    var cual = (eta === 'LISTO' && !cerrado) ? 'C1 etapa cerrada con estado abierto'
             : (cerrado && eta !== 'LISTO')  ? 'C2 estado cerrado con etapa abierta'
             : !conocida                     ? 'C3 etapa vacia o desconocida'
             : (eta === 'FINALIZAR' && !txt(cab.tc)) ? 'C4 etapa FINALIZAR sin inicio de despacho'
             : (teCab && est !== 'ENTREGADO') ? 'C5 tiene entrega y el estado no dice ENTREGADO'
             : '';
    if(cual) contra.push(pid + ' · ' + est + ' / ' + (eta || '(vacia)') + ' · ' + cual);
  });
  if(contra.length){
    F('hay ' + contra.length + ' cabecera(s) con Estado y Etapa_preparacion contradictorios. ' +
      'Son las que pueden dejar un pedido visible en una seccion y rechazado por el servidor.');
    contra.slice(0,10).forEach(function(t){ Logger.log('       ' + t); });
    Logger.log('       Se sanean solas la proxima vez que se toque el pedido.');
    Logger.log('       Para sanearlas todas ahora: heralsaRepararEtapas() simula, repararEtapas_(false) escribe.');
  }else OK('ninguna cabecera se contradice: Estado y Etapa_preparacion van de acuerdo');

  /* ---- resumen ---- */
  Logger.log('');
  Logger.log('===== RESUMEN =====');
  Logger.log('FALLOS (defecto de estructura, hay que corregir) : ' + fallos);
  Logger.log('Avisos (revisar, no bloquea)                     : ' + avisos);
  Logger.log('Tardo                                            : ' + ((new Date().getTime() - ini) / 1000).toFixed(1) + ' s');
  Logger.log('No se escribio nada.');
  if(!fallos) Logger.log('>>> La estructura esta consistente.');
  return { ok:fallos === 0, fallos:fallos, avisos:avisos, secciones:porSeccion, vigentes:vigentes.length };
}


/* =====================================================================
   4 · MEDIR · el coste real, en segundos, de lo que de verdad se hace
   =====================================================================
   El dueno dijo que guardar tardaba 20 segundos y que su Excel era mas
   rapido. Antes de tocar nada hay que saber DONDE se van esos segundos,
   porque optimizar lo que no cuesta no sirve de nada y arriesga gratis.

   Esto NO ESCRIBE NADA: mide lecturas y busquedas, que es donde esta el
   coste. En particular compara la busqueda nueva (createTextFinder, del
   lado de Sheets) contra la de antes (traer la hoja entera), que es la que
   se hacia UNA VEZ POR CADA FILA QUE SE ESCRIBE.

   Ejecutela ANTES y DESPUES de pegar esta version y compare los numeros.
   ===================================================================== */
function heralsaMedirGuardado(){
  Logger.log('===== v5.3 · MEDICION · solo lectura =====');
  Logger.log('Cada numero es lo que tarda UNA operacion. Lo que importa son las');
  Logger.log('que se repiten: una lectura de 0,4 s hecha 24 veces son 10 segundos.');
  Logger.log('');

  function mide(etiqueta, fn){
    var t = new Date().getTime(), r = null, err = '';
    try{ r = fn(); }catch(e){ err = e.message; }
    var ms = new Date().getTime() - t;
    Logger.log('  ' + ms + ' ms · ' + etiqueta + (err ? ' · ERROR: ' + err : ''));
    return { ms:ms, r:r, err:err };
  }

  Logger.log('--- LECTURA DE CADA HOJA (una vez) ---');
  var hojas = [H.pedidos, H.prep, H.prepDet, H.entregas, H.compras, H.detalle,
               H.mov, 'MOV_Caja', H.cfg, H.log, H.productos, H.clientes, H.proveedores, H.materias];
  var totalLectura = 0, filasPorHoja = {};
  hojas.forEach(function(n){
    var m = mide('leer ' + n, function(){ return filas(n); });
    totalLectura += m.ms;
    filasPorHoja[n] = m.r ? m.r.length : 0;
    Logger.log('           ' + filasPorHoja[n] + ' fila(s)');
  });
  Logger.log('  TOTAL leer las ' + hojas.length + ' hojas una vez: ' + totalLectura + ' ms');

  Logger.log('');
  Logger.log('--- EL CICLO DE SINCRONIZACION ---');
  var mLig = mide('apiEstado LIGERO (lo que pide el ciclo de 30 s)', function(){ return apiEstado_(true); });
  var mCom = mide('apiEstado COMPLETO (lo que se pedia despues de guardar)', function(){ return apiEstado_(false); });
  Logger.log('  Diferencia: ' + (mCom.ms - mLig.ms) + ' ms que se pagaban en cada guardado.');

  Logger.log('');
  Logger.log('--- LA BUSQUEDA DE UNA FILA · es lo que mas se repite ---');
  var ped = filas(H.pedidos);
  var pid = ped.length ? txt(ped[ped.length - 1].P_num) : '';
  if(!pid) Logger.log('  No hay pedidos todavia: no se puede medir la busqueda.');
  else{
    var sh = hoja(H.pedidos), ix = indices(sh), ult = sh.getLastRow();
    var claves = [{ columna:'P_num', valor:pid }];
    var mNueva = mide('buscar ' + pid + ' en R3_Pedidos · metodo NUEVO (createTextFinder)',
      function(){ return buscarFilaIndexada_(sh, ix, claves, ult); });
    var mVieja = mide('buscar ' + pid + ' en R3_Pedidos · metodo VIEJO (traer la hoja entera)',
      function(){ return buscarFilaLeyendo_(sh, ix, claves, ult); });
    Logger.log('  Las dos tienen que dar la MISMA fila: nueva=' + mNueva.r + ' vieja=' + mVieja.r +
      (String(mNueva.r) === String(mVieja.r) ? ' · COINCIDEN' : ' · *** NO COINCIDEN: no use la version nueva ***'));
    var ahorro = mVieja.ms - mNueva.ms;
    Logger.log('  Ahorro por fila escrita: ' + ahorro + ' ms.');
    Logger.log('  Un pedido de 8 referencias escribe 12 filas -> ' + (ahorro * 12) + ' ms menos,');
    Logger.log('  y antes ademas releia R3_Pedidos 12 veces -> ' + (filasPorHoja[H.pedidos] ? (11 * (mVieja.ms)) : 0) + ' ms mas.');

    Logger.log('');
    Logger.log('--- LA FACTURA DE UN PEDIDO ---');
    mide('apiFactura_(' + pid + ') SIN contexto (lee 2 hojas completas)', function(){ return apiFactura_(pid); });
    var ctx = null;
    var mCtx = mide('cohCtx_() · leer las 4 hojas del expediente una vez', function(){ ctx = cohCtx_(); return ctx; });
    mide('apiFactura_(' + pid + ') CON contexto (0 lecturas)', function(){ return apiFactura_(pid, ctx); });
    mide('cohPedido_(' + pid + ') CON contexto', function(){ return cohPedido_(pid, ctx); });
    mide('cohPedido_(' + pid + ') SIN contexto (6 hojas completas)', function(){ return cohPedido_(pid); });
    Logger.log('  Con ' + ped.length + ' pedidos, revisar la coherencia de todos cuesta');
    Logger.log('  CON contexto: una sola lectura de ' + mCtx.ms + ' ms mas el calculo.');
  }

  Logger.log('');
  Logger.log('===== COMO LEER ESTO =====');
  Logger.log('Si "leer CAT_Productos" tarda 400 ms, cada vez que algo lo lee sin');
  Logger.log('necesitarlo son 400 ms regalados. apiPreparacion lo leia en TODAS las');
  Logger.log('acciones, incluso en DESPACHAR, que no consulta ningun producto.');
  Logger.log('No se escribio nada.');
  return { lectura_total_ms:totalLectura, estado_ligero_ms:mLig.ms, estado_completo_ms:mCom.ms,
           filas:filasPorHoja };
}


/* =====================================================================
   v5.3 · REIMPRIMIR UNA TIRILLA · solo lectura
   =====================================================================
   POR QUE HACE FALTA: una venta de mostrador ya no vive en R3_Pedidos, asi
   que la app no la tiene cargada. Sin esto, la tirilla solo se podia
   imprimir en el momento: si el papel se atascaba y el operador salia de
   la pantalla, la venta quedaba bien escrita pero sin forma de volver a
   sacar el papel.

   NO CREA NADA. No toca el consecutivo, no escribe en caja ni en kardex.
   Devuelve exactamente lo que ya esta escrito, con la misma forma que
   devuelve apiMostradorVenta_, para que la pantalla de la tirilla sea UNA
   sola y no dos que se parecen.

   PERMISOS: un vendedor de mostrador solo puede reimprimir SUS ventas.
   Operacion y administracion pueden reimprimir cualquiera, porque son las
   que atienden un reclamo.
   ===================================================================== */
function apiMostradorTirilla(token, mnum){
  var s = sesionNativa_(token);
  if(typeof exigeClaveCambiada_ === 'function') exigeClaveCambiada_(s, 'apiMostradorTirilla');
  var num = txt(mnum).toUpperCase();
  if(!/^M-\d+$/.test(num))
    return { ok:false, error:'«' + num + '» no es un número de venta de mostrador. Son M-### (M-001, M-012…).' };

  var v = buscarEn(filas(H_MOS), 'M_num', num);
  if(!v) return { ok:false, error:'La venta ' + num + ' no existe en MOS_Ventas.' };
  if(txt(v[COL_EST]).toUpperCase() === E_ANU)
    return { ok:false, error:'La venta ' + num + ' está anulada (' + txt(v.Motivo_anulacion) +
             '). Una venta anulada no se reimprime.' };
  if(s.rol === ROL_MOSTRADOR && low(v.Operador) !== low(s.nombre))
    return { ok:false, error:'La venta ' + num + ' la registró ' + txt(v.Operador) +
             '. Un vendedor solo reimprime sus propias ventas; pida ayuda a operación.' };

  var det = filas(H_MOS_DET).filter(function(d){
    return txt(d.M_num) === num && txt(d[COL_EST]).toUpperCase() !== E_ANU;
  });

  /* se comprueba al reimprimir, no solo al vender: si la cabecera y las
     lineas no suman lo mismo, se dice. Un papel que no cuadra con la hoja
     es peor que no tener papel. */
  var suma = 0;
  det.forEach(function(d){ suma += numero(d.Total_linea) || 0; });
  var aviso = '';
  if(det.length && Math.abs(Math.round(suma) - Math.round(numero(v.Total))) > det.length + 1)
    aviso = 'AVISO: la venta dice ' + Math.round(numero(v.Total)) + ' y sus líneas suman ' +
            Math.round(suma) + '. Revise MOS_Detalle antes de entregar este papel.';

  return { ok:true, id:num, reimpresion:true,
    total:numero(v.Total), subtotal:numero(v.Subtotal), descuento:numero(v.Descuento_valor),
    iva:numero(v.IVA_valor), lineas:det.length,
    especiales:det.filter(function(d){ return txt(d.Es_especial) === 'S'; }).length,
    fecha:txt(v.Fecha), operador:txt(v.Operador),
    cliente:txt(v.Cliente), tipoId:txt(v.Tipo_identificacion), numId:txt(v.Numero_identificacion),
    canal:txt(v.Canal) || 'R', forma:txt(v.Forma_pago), medio:txt(v.Medio_pago),
    docTipo:txt(v.Doc_tipo), detalle:det, aviso:aviso };
}


/* ####################################################################
   v5.4 · BUG_004 · LA AUTORIDAD UNICA DE LA SECCION
   ####################################################################
   EL DEFECTO, con nombre y apellido: la pregunta «¿en que seccion esta
   este pedido?» estaba contestada en CINCO sitios distintos que no se
   consultaban entre si.

     1. h6SeccionDe_        (frontend) · la cascada buena
     2. S.preSel            (frontend) · exigia que Etapa dijera literalmente
                                         la etapa buscada
     3. porFacturarHoy / S.enSel (frontend) · por Estado
     4. h6EtapaReal_        (frontend) · derivada de los hechos
     5. apiPreparacion_     (backend)  · Etapa con respaldo a DESPACHAR

   Con Etapa_preparacion='LISTO' y Estado distinto de LISTO, la tarjeta del
   carril contaba el pedido en Finalizar, la lista de Finalizar no lo
   encontraba, y el servidor rechazaba TODA accion sobre el. El pedido
   quedaba visible, contado y sin salida. Comprobado en produccion con
   P-009 y P-020.

   LO QUE SE HACE AQUI: una sola cascada, identica a la del frontend, mas
   la derivacion del par (Estado, Etapa) a partir de los HECHOS, mas la
   normalizacion que lo corrige cuando se contradice.

   POR QUE NORMALIZAR Y NO SOLO VALIDAR: porque el usuario lo dijo claro --
   «que un pedido genere conflictos o se atasque por decisiones del
   operador no puede pasar, el sistema debe estar blindado». Validar avisa;
   normalizar arregla. Un sistema infalible no es uno donde la escritura
   nunca se corta: es uno que converge al estado correcto la proxima vez
   que se le toca.
   #################################################################### */

/** Los nombres de las siete posiciones. Un solo sitio los escribe. */
var SECCIONES_ = { 0:'Inhabilitados', 2:'2 Organizar', 3:'3 Despachar',
                   4:'4 Finalizar', 5:'5 Facturacion', 6:'6 Entrega', 7:'Completados' };
function nombreSeccion_(n){ return SECCIONES_[n] || ('seccion ' + n); }

/* =====================================================================
   LA CASCADA · exhaustiva y exclusiva, IDENTICA a h6SeccionDe_
   =====================================================================
   Devuelve SIEMPRE 0, 2, 3, 4, 5, 6 o 7. La ultima linea no tiene
   condicion: nada puede quedar fuera. Si esta funcion y la del frontend
   dejan de coincidir, heralsaRevisarLogica() lo detecta, porque las dos
   cuentan sobre los mismos datos y la suma tiene que dar el total.
   ===================================================================== */
/* =====================================================================
   v5.4.1 · EL CLASIFICADOR NO LEE COLUMNAS: CLASIFICA SOBRE LOS HECHOS
   =====================================================================
   ANTES leia Estado y Etapa_preparacion tal como estaban en la hoja. El
   frontend, en cambio, DEDUCE el estado de los hechos y lo dice en su
   propio comentario: «el estado NO se lee de la hoja: se DEDUCE de los
   hechos». Resultado medido con los datos reales del usuario: para P-007
   -- que tiene fecha de entrega y la columna Estado en LISTO -- el servidor
   decia seccion 6 y la pantalla decia Completados. Dos autoridades.

   AHORA las dos derivan primero el par (Estado, Etapa) con la MISMA
   especificacion y clasifican sobre el resultado. La columna de la hoja
   deja de poder mentirle al clasificador: si dice una cosa y los hechos
   dicen otra, manda el hecho, y normalizarCabecera_ corrige la columna.

   Los parametros partes y det son opcionales: sin ellos la derivacion usa
   lo que tenga (Fecha_real_listo de R3 y el documento), que es suficiente
   para los tres estados cerrados. Pasarlos es mejor y es lo que hacen los
   recorridos en lote, que ya tienen las hojas leidas.
   ===================================================================== */
function seccionDePedido_(cab, entOdoc, partes, det){
  if(!cab) return 0;
  if(txt(cab[COL_EST]).toUpperCase() === E_ANU) return 0;

  /* compatibilidad: algunas llamadas pasan un booleano «tieneDoc» en vez de
     la fila de R4. Las dos formas se admiten para no romper nada. */
  var ent = (entOdoc && typeof entOdoc === 'object') ? entOdoc
          : (entOdoc === true ? { Doc_tipo:'REMISION' } : {});
  var doc = !!txt(ent.Doc_tipo);

  var c = cabeceraCoherente_(cab, partes || [], det || [], ent);
  var est = c.estado, eta = c.etapa;

  if(est === 'ENTREGADO') return 7;
  if(est === 'LISTO')     return doc ? 6 : 5;
  if(doc)                 return 6;
  if(eta === 'FINALIZAR') return 4;
  if(eta === 'DESPACHAR') return 3;
  if(eta === 'LISTO')     return 4;
  return 2;
}

/** ¿Tiene documento emitido? Una sola lectura de R4 por llamada. */
function docDePedido_(pid, ctx){
  var e = ctx && ctx.entPorNum ? ctx.entPorNum[txt(pid)]
                               : buscarEn(filas(H.entregas), 'P_num', txt(pid));
  return !!(e && txt(e.Doc_tipo));
}

/** La etapa que el servidor debe usar para trabajar, derivada y nunca vacia. */
function etapaDeCabecera_(cab){
  var eta = txt(cab && cab.Etapa_preparacion).toUpperCase();
  if(['ORGANIZAR','DESPACHAR','FINALIZAR','LISTO'].indexOf(eta) >= 0) return eta;
  /* una etapa vacia o desconocida NO se adivina con un respaldo fijo: se
     deduce del hecho de si el despacho empezo. Antes el respaldo era
     'DESPACHAR' siempre, y por eso un pedido con etapa vacia aceptaba
     GUARDAR y rechazaba DESPACHAR con «ya salio de Organizar». */
  return txt(cab && cab.tc) ? 'DESPACHAR' : 'ORGANIZAR';
}

/** La etapa que le corresponde a un Estado. Tabla de equivalencia, un sitio. */
function etapaParaEstado_(estado){
  var e = txt(estado).toUpperCase();
  if(e === 'LISTO' || e === 'ENTREGADO') return 'LISTO';
  if(e === 'NUEVO') return 'ORGANIZAR';
  return '';     /* EN_PREPARACION admite DESPACHAR o FINALIZAR: no se fuerza */
}

/* =====================================================================
   EL PAR COHERENTE · derivado de los HECHOS, no de lo que diga una celda
   =====================================================================
   Los hechos, en orden de autoridad:
     te  (R4)              -> el cliente ya lo recibio
     tl / Fecha_real_listo -> el pedido se cerro
     Doc_tipo (R4)         -> se emitio documento, asi que estaba cerrado
     tc                    -> el despacho empezo
     lineas en R2_Detalle  -> hay algo que preparar

   Un dato derivable no se cree: se calcula. Esta funcion NO escribe; solo
   dice cual seria el par correcto y por que.
   ===================================================================== */
function cabeceraCoherente_(cab, partes, det, ent){
  var estado = txt(cab.Estado).toUpperCase();
  var etapa  = txt(cab.Etapa_preparacion).toUpperCase();
  ent = ent || {};
  var te  = !!txt(ent.te);
  var doc = !!txt(ent.Doc_tipo);
  var tl  = !!(txt(cab.Fecha_real_listo) || (partes || []).some(function(r){ return txt(r.tl); }));
  var tc  = !!txt(cab.tc);
  var vivas = (det || []).filter(function(r){ return txt(r[COL_EST]).toUpperCase() !== E_ANU; });
  var hayLineas = vivas.length > 0;

  var d = derivarPar_(te, tl, doc, hayLineas, tc, etapa);
  return { estado:d.estado, etapa:d.etapa, porque:d.porque,
           coincide:(estado === d.estado && etapa === d.etapa) };
}

/* =====================================================================
   derivarPar_ · LA ESPECIFICACION, EN UNA FUNCION PURA
   =====================================================================
   Entra solo lo que son HECHOS (si existen o no) y la etapa guardada. Sale
   el par que le corresponde. Sin leer hojas, sin efectos: por eso se puede
   comprobar caso por caso contra la copia del Index, y por eso existe
   heralsaVerificarSeccion().

   LA MISMA FUNCION, CON EL MISMO NOMBRE, ESTA EN Index.html. Si se cambia
   una hay que cambiar la otra, y la comprobacion lo detecta.
   ===================================================================== */
function derivarPar_(hayEntrega, hayTl, hayDoc, hayLineas, hayTc, etapaGuardada){
  var eta = String(etapaGuardada || '').toUpperCase();
  if(hayEntrega) return { estado:'ENTREGADO', etapa:'LISTO', porque:'tiene fecha de entrega (te)' };
  if(hayTl)      return { estado:'LISTO',     etapa:'LISTO', porque:'tiene fecha de cierre (tl)' };
  if(hayDoc)     return { estado:'LISTO',     etapa:'LISTO', porque:'ya tiene documento emitido' };
  if(!hayLineas) return { estado:'NUEVO',     etapa:'ORGANIZAR', porque:'no tiene lineas que preparar' };
  if(!hayTc){
    /* con lineas y sin iniciar el despacho las dos etapas son legitimas:
       ORGANIZAR (cargando) y DESPACHAR (enviado, sin iniciar). Se respeta la
       guardada; cualquier otra cosa cae en ORGANIZAR. */
    var t1 = (eta === 'DESPACHAR') ? 'DESPACHAR' : 'ORGANIZAR';
    return { estado:(t1 === 'ORGANIZAR') ? 'NUEVO' : 'EN_PREPARACION', etapa:t1,
             porque:'tiene lineas y no ha iniciado el despacho (no hay tc)' };
  }
  /* iniciado y sin cerrar: DESPACHAR o FINALIZAR, se respeta la guardada */
  return { estado:'EN_PREPARACION', etapa:(eta === 'FINALIZAR') ? 'FINALIZAR' : 'DESPACHAR',
           porque:'el despacho esta iniciado (tc) y no se ha cerrado' };
}

/* =====================================================================
   LA NORMALIZACION · solo actua cuando hay CONTRADICCION
   =====================================================================
   Deliberadamente conservadora. No reescribe una cabecera que ya se puede
   clasificar sin ambiguedad: solo las cuatro contradicciones reales que
   dejan un pedido sin salida o en dos sitios a la vez.

     C1  Etapa LISTO y Estado abierto      -> el atasco total de P-020
     C2  Estado cerrado y Etapa abierta    -> el pedido en dos secciones
     C3  Etapa vacia o desconocida         -> clasificado por respaldo fijo
     C4  Etapa FINALIZAR sin tc            -> no pudo cerrar lo que no abrio

   Todo cambio queda en LOG_Cambios con el hecho que lo justifico, asi que
   es auditable y reversible. Si no hay contradiccion, no escribe nada y
   devuelve cambio:false.
   ===================================================================== */
function normalizarCabecera_(pid, cab, operador, motivo){
  pid = txt(pid);
  if(!cab) return { cambio:false };
  if(txt(cab[COL_EST]).toUpperCase() === E_ANU) return { cambio:false, cab:cab };

  var estado = txt(cab.Estado).toUpperCase();
  var etapa  = txt(cab.Etapa_preparacion).toUpperCase();
  var cerrado = (estado === 'LISTO' || estado === 'ENTREGADO');
  var etapaConocida = ['ORGANIZAR','DESPACHAR','FINALIZAR','LISTO'].indexOf(etapa) >= 0;

  /* =====================================================================
     v5.4.1 · C5 · LA CONTRADICCION QUE SE ME ESCAPO
     =====================================================================
     P-007 tiene fecha de entrega (te) y la columna Estado dice LISTO. Las
     cuatro contradicciones anteriores solo miraban el par Estado/Etapa
     entre si, asi que esta no la veian: el par era coherente consigo mismo
     y mentia respecto a los HECHOS. Era justo la que hacia que el servidor
     y la pantalla clasificaran P-007 en sitios distintos.
     cohPedido_ ya lo reportaba como aviso («tiene fecha de entrega pero su
     estado es LISTO»); lo que faltaba era corregirlo, no solo avisarlo.
     ===================================================================== */
  var partes = filas(H.prep).filter(function(r){ return txt(r.P_num) === pid; });
  var det    = filas(H.prepDet).filter(function(r){ return txt(r.P_num) === pid; });
  var ent    = buscarEn(filas(H.entregas), 'P_num', pid) || {};

  var C1 = (etapa === 'LISTO' && !cerrado);
  var C2 = (cerrado && etapa !== 'LISTO');
  var C3 = !etapaConocida;
  var C4 = (etapa === 'FINALIZAR' && !txt(cab.tc));
  var C5 = (!!txt(ent.te) && estado !== 'ENTREGADO');
  if(!C1 && !C2 && !C3 && !C4 && !C5) return { cambio:false, cab:cab };

  var c = cabeceraCoherente_(cab, partes, det, ent);
  if(c.coincide) return { cambio:false, cab:cab };

  var cual = C1 ? 'C1 etapa cerrada con estado abierto'
           : C2 ? 'C2 estado cerrado con etapa abierta'
           : C3 ? 'C3 etapa vacia o desconocida'
           : C4 ? 'C4 etapa FINALIZAR sin inicio de despacho'
                : 'C5 tiene fecha de entrega y el estado no dice ENTREGADO';

  var logs = [], f = { P_num:pid };
  if(estado !== c.estado){
    logs.push({ Tabla:H.pedidos, Registro:pid, Campo:'Estado',
      Valor_antes:txt(cab.Estado), Valor_despues:c.estado,
      Motivo:'Saneado automatico (' + cual + ') porque ' + c.porque + ' · ' + txt(motivo) });
    f.Estado = c.estado;
  }
  if(etapa !== c.etapa){
    logs.push({ Tabla:H.pedidos, Registro:pid, Campo:'Etapa_preparacion',
      Valor_antes:txt(cab.Etapa_preparacion), Valor_despues:c.etapa,
      Motivo:'Saneado automatico (' + cual + ') porque ' + c.porque + ' · ' + txt(motivo) });
    f.Etapa_preparacion = c.etapa;
  }
  if(!logs.length) return { cambio:false, cab:cab };

  /* atomico: las dos columnas del par, en una sola escritura */
  escribirFila({ hoja:H.pedidos, atomico:true, noSello:true,
                 claves:[{ columna:'P_num', valor:pid }], fila:f });
  try{ apiLogCambio_(logs, operador || 'sistema'); }catch(e){}

  var nuevo = {};
  Object.keys(cab).forEach(function(k){ nuevo[k] = cab[k]; });
  nuevo.Estado = c.estado;
  nuevo.Etapa_preparacion = c.etapa;
  return { cambio:true, cab:nuevo, contradiccion:cual, porque:c.porque,
           antes:{ estado:estado, etapa:etapa }, despues:{ estado:c.estado, etapa:c.etapa } };
}

/** Lo que la app necesita saber de una cabecera, en un solo objeto. */
function apiSeccionPedido(token, pid){
  sesionNativa_(token);
  var cab = buscarEn(filas(H.pedidos), 'P_num', txt(pid));
  if(!cab) return { ok:false, error:'El pedido ' + txt(pid) + ' no existe.' };
  var doc = docDePedido_(pid);
  var sec = seccionDePedido_(cab, doc);
  return { ok:true, pedido:txt(pid), seccion:sec, nombre:nombreSeccion_(sec),
           estado:txt(cab.Estado), etapa:etapaDeCabecera_(cab), documento:doc };
}


/* =====================================================================
   REPARACION EN LOTE · por omision SIMULA
   =====================================================================
   Recorre todas las cabeceras y normaliza las que se contradigan. Igual
   que las otras reparaciones de este archivo: ejecutada desde el editor
   sin argumentos SOLO SIMULA, y para escribir hay que llamarla a
   proposito con false.
   ===================================================================== */
function heralsaRepararEtapas(){ return repararEtapas_(true); }
function repararEtapas_(soloSimular){
  if(soloSimular === undefined) soloSimular = true;
  Logger.log(soloSimular ? '===== SIMULACION · saneo de cabeceras · NO escribe ====='
                         : '===== SANEO DE CABECERAS · ESCRIBE =====');
  var peds = filas(H.pedidos);
  var ents = indicePor_(filas(H.entregas), 'P_num');
  var partes = agrupaPor_(filas(H.prep), 'P_num');
  var dets = agrupaPor_(filas(H.prepDet), 'P_num');
  var tocar = [], ok = 0;

  peds.forEach(function(cab){
    var pid = txt(cab.P_num);
    if(!pid) return;
    if(txt(cab[COL_EST]).toUpperCase() === E_ANU) return;
    var estado = txt(cab.Estado).toUpperCase(), etapa = txt(cab.Etapa_preparacion).toUpperCase();
    var cerrado = (estado === 'LISTO' || estado === 'ENTREGADO');
    var conocida = ['ORGANIZAR','DESPACHAR','FINALIZAR','LISTO'].indexOf(etapa) >= 0;
    var hay = (etapa === 'LISTO' && !cerrado) || (cerrado && etapa !== 'LISTO')
           || !conocida || (etapa === 'FINALIZAR' && !txt(cab.tc))
           || (!!txt((ents[pid]||{}).te) && estado !== 'ENTREGADO');   /* v5.4.1 · C5 */
    if(!hay){ ok++; return; }
    var c = cabeceraCoherente_(cab, partes[pid] || [], dets[pid] || [], ents[pid] || {});
    if(c.coincide){ ok++; return; }
    tocar.push({ pid:pid, antes:estado + ' / ' + (etapa || '(vacia)'),
                 despues:c.estado + ' / ' + c.etapa, porque:c.porque,
                 seccionAntes:seccionDePedido_(cab, !!txt((ents[pid]||{}).Doc_tipo)) });
  });

  Logger.log('Cabeceras coherentes          : ' + ok);
  Logger.log('Cabeceras que se contradicen  : ' + tocar.length);
  tocar.forEach(function(t){
    Logger.log('  ' + t.pid + ' · ' + t.antes + '  ->  ' + t.despues +
      '   (estaba en ' + nombreSeccion_(t.seccionAntes) + '; ' + t.porque + ')');
  });
  if(!tocar.length){ Logger.log('Nada que sanear. Ninguna cabecera se contradice.'); return { ok:true, tocadas:0 }; }
  if(soloSimular){
    Logger.log('');
    Logger.log('=== FIN DE LA SIMULACION · no se escribio nada ===');
    Logger.log('Para aplicarlo de verdad ejecute en el editor:  repararEtapas_(false)');
    return { ok:true, simulado:true, tocadas:tocar.length, detalle:tocar };
  }
  var hechas = 0;
  tocar.forEach(function(t){
    var cab = buscarEn(filas(H.pedidos), 'P_num', t.pid);
    var r = normalizarCabecera_(t.pid, cab, 'sistema', 'Saneo en lote heralsaRepararEtapas');
    if(r.cambio) hechas++;
  });
  Logger.log('');
  Logger.log('=== SANEO TERMINADO · ' + hechas + ' cabecera(s) corregida(s) ===');
  Logger.log('Cada cambio quedo en LOG_Cambios con el hecho que lo justifico.');
  return { ok:true, tocadas:hechas };
}


/* ####################################################################
   v5.4 · BUG_007 · RENOVAR LA CLAVE DE ALEGRA · paso a paso
   ####################################################################
   La clave de prueba de Alegra caduca. Esto no es un defecto del codigo:
   es una decision de Alegra. Lo que si era un defecto es que la aplicacion
   no lo dijera con claridad y que no hubiera un procedimiento escrito.

   Esta funcion NO llama a Alegra ni cambia nada: imprime el procedimiento y
   dice en que estado esta el token que hay guardado. Es de solo lectura.
   #################################################################### */
function heralsaAlegraRenovar(){
  Logger.log('========== RENOVAR LA CLAVE DE ALEGRA ==========');
  var jwt = PropertiesService.getScriptProperties().getProperty('ALEGRA_JWT') || '';
  Logger.log('');
  Logger.log('--- ESTADO DE LA CLAVE QUE HAY GUARDADA ---');
  if(!jwt){
    Logger.log('NO hay ninguna clave guardada.');
  }else{
    Logger.log('Hay una clave guardada de ' + jwt.length + ' caracteres.');
    /* Un JWT lleva su fecha de expiracion DENTRO, en el campo exp del
       segundo bloque. Se lee sin llamar a Alegra y sin exponer la clave. */
    try{
      var partes = jwt.split('.');
      if(partes.length >= 2){
        var b64 = partes[1].replace(/-/g,'+').replace(/_/g,'/');
        while(b64.length % 4) b64 += '=';
        var cuerpo = JSON.parse(Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString());
        if(cuerpo.exp){
          var vence = new Date(Number(cuerpo.exp) * 1000);
          var dias = Math.floor((vence.getTime() - new Date().getTime()) / 86400000);
          Logger.log('Vence el : ' + Utilities.formatDate(vence, tzLibro_(), 'yyyy-MM-dd HH:mm'));
          Logger.log(dias >= 0 ? 'Le quedan ' + dias + ' dia(s).'
                               : '>>> VENCIDA hace ' + Math.abs(dias) + ' dia(s). Hay que renovarla.');
        }else Logger.log('La clave no declara fecha de vencimiento.');
      }
    }catch(e){ Logger.log('No se pudo leer la fecha de vencimiento de la clave: ' + e.message); }
  }

  Logger.log('');
  Logger.log('--- PASO A PASO PARA RENOVARLA ---');
  Logger.log('1. Entre a Alegra con su cuenta.');
  Logger.log('2. Arriba a la derecha, su nombre -> Configuracion.');
  Logger.log('3. Busque «Integraciones» o «API» -> «Tokens» / «Claves de API».');
  Logger.log('4. Cree un token NUEVO. Donde pregunte para que es, escoja «Otro».');
  Logger.log('5. MARQUE SOLO ESTOS TRES PERMISOS:');
  Logger.log('      · Facturas   (leer y crear)');
  Logger.log('      · Contactos  (leer y crear)');
  Logger.log('      · Items      (leer)');
  Logger.log('   NO marque «Configuraciones generales»: no hace falta y da acceso de mas.');
  Logger.log('6. Copie el token completo. Empieza por «eyJ» y son unos 1.600 caracteres.');
  Logger.log('7. En este editor, abra la funcion heralsaAlegraGuardarToken, pegue el');
  Logger.log('   token donde dice PEGUE_AQUI, ejecutela, y BORRE el token del codigo.');
  Logger.log('8. Ejecute heralsaAlegraProbar2() para comprobar los permisos.');
  Logger.log('9. Si da 4/4, ya se puede facturar.');
  Logger.log('');
  Logger.log('AVISO IMPORTANTE: el token NO se guarda en el codigo ni en el repositorio.');
  Logger.log('Vive en Propiedades del script, que no se comparte. Si alguna vez queda');
  Logger.log('pegado dentro de Codigo.gs, borrelo: con esa clave cualquiera puede emitir');
  Logger.log('facturas a nombre de HERALSA.');
  return { ok:true, hayClave:!!jwt, largo:jwt.length };
}


/* ####################################################################
   v5.4 · BUG_002 · LAS DOS COPIAS DE LA REGLA DEL CANAL DICEN LO MISMO
   ####################################################################
   canalDeClienteTexto_ (aqui) y canalDeTexto_ (en el Index) son la misma
   regla en dos tiempos de ejecucion distintos. No se pueden fundir en una
   funcion, pero SI se puede comprobar que no se hayan desincronizado.

   Esta funcion prueba las dos con los mismos casos. La del Index se lee del
   propio archivo HTML y se evalua, asi que lo que se comprueba es el codigo
   que de verdad se sirve, no una copia.
   #################################################################### */
function heralsaVerificarCanal(){
  Logger.log('===== v5.4 · LA REGLA DEL CANAL · solo lectura =====');
  var casos = [
    ['', ''], ['   ', ''],
    ['M','M'], ['m','M'], ['MAY','M'], ['Mayorista','M'], ['MAYORISTA','M'],
    ['R','R'], ['r','R'], ['MIN','R'], ['Minorista','R'], ['DETAL','R'],
    ['X',''], ['MOSTRADOR',''], ['1',''], ['MY','']
  ];
  var fallos = 0;
  Logger.log('');
  Logger.log('--- BACKEND · canalDeClienteTexto_ ---');
  casos.forEach(function(c){
    var r = canalDeClienteTexto_(c[0]);
    var ok = (r === c[1]);
    if(!ok) fallos++;
    Logger.log((ok ? 'OK    ' : 'FALLO ') + '«' + c[0] + '» -> «' + r + '»' + (ok ? '' : ' (esperado «' + c[1] + '»)'));
  });

  /* ---- y la del Index, leida del archivo que se sirve ---- */
  Logger.log('');
  Logger.log('--- FRONTEND · canalDeTexto_ del Index ---');
  try{
    var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
    var m = html.match(/function canalDeTexto_\(v\)\{[\s\S]*?\n\}/);
    if(!m){ Logger.log('FALLO no se encontro canalDeTexto_ en el Index.'); fallos++; }
    else{
      var fn = eval('(' + m[0].replace('function canalDeTexto_', 'function') + ')');
      casos.forEach(function(c){
        var r = fn(c[0]);
        var ok = (r === c[1]);
        if(!ok) fallos++;
        Logger.log((ok ? 'OK    ' : 'FALLO ') + '«' + c[0] + '» -> «' + r + '»' + (ok ? '' : ' (esperado «' + c[1] + '»)'));
      });
    }
  }catch(e){ Logger.log('No se pudo comprobar la del Index: ' + e.message); fallos++; }

  Logger.log('');
  Logger.log(fallos ? '>>> ' + fallos + ' FALLO(S): las dos copias de la regla NO dicen lo mismo.'
                    : '>>> Las dos copias de la regla del canal coinciden en los ' + casos.length + ' casos.');
  Logger.log('No se escribio nada.');
  return { ok:fallos === 0, fallos:fallos, casos:casos.length };
}


/* ####################################################################
   v5.4.1 · LA COMPROBACION QUE FALTABA
   ####################################################################
   Ejecuta las DOS implementaciones de la regla -- la del servidor y la que
   de verdad se sirve en el Index -- con todas las combinaciones posibles, y
   despues con los datos reales del libro. Si dejan de coincidir, lo dice
   con el caso exacto y con el numero de pedido.

   Esto es lo que convierte «las escribi iguales» en «estan iguales».
   #################################################################### */
function heralsaVerificarSeccion(){
  Logger.log('===== ' + VERSION_BACKEND + ' · SERVIDOR CONTRA NAVEGADOR · solo lectura =====');
  var fallos = 0;

  /* ---- se extraen del Index las dos funciones puras ---- */
  var fnDer = null, fnSec = null;
  try{
    var html = HtmlService.createHtmlOutputFromFile('Index').getContent();
    var mD = html.match(/function derivarPar_\(hayEntrega[\s\S]*?\n\}/);
    var mS = html.match(/function h6SeccionDe_\(p\)\{[\s\S]*?\n\}/);
    if(!mD){ Logger.log('FALLO  no se encontro derivarPar_ en el Index.'); fallos++; }
    else fnDer = eval('(' + mD[0].replace('function derivarPar_', 'function') + ')');
    if(!mS){ Logger.log('FALLO  no se encontro h6SeccionDe_ en el Index.'); fallos++; }
    else{
      /* h6SeccionDe_ usa anulado(p); se le da una version equivalente */
      var anulado = function(p){ return !!(p && p.anulado); };
      fnSec = eval('(' + mS[0].replace('function h6SeccionDe_', 'function') + ')');
    }
  }catch(e){ Logger.log('FALLO  no se pudo leer el Index: ' + e.message); fallos++; }

  /* ---- 1 · la derivacion, con TODAS las combinaciones ---- */
  Logger.log('');
  Logger.log('--- 1 · derivarPar_ · las 192 combinaciones posibles ---');
  var etapas = ['', 'ORGANIZAR', 'DESPACHAR', 'FINALIZAR', 'LISTO', 'BASURA'];
  var n = 0, difD = [];
  if(fnDer){
    [false,true].forEach(function(te){ [false,true].forEach(function(tl){
    [false,true].forEach(function(doc){ [false,true].forEach(function(lin){
    [false,true].forEach(function(tc){ etapas.forEach(function(eta){
      n++;
      var a = derivarPar_(te, tl, doc, lin, tc, eta);
      var b = fnDer(te, tl, doc, lin, tc, eta);
      if(a.estado !== b.estado || a.etapa !== b.etapa)
        difD.push('te=' + te + ' tl=' + tl + ' doc=' + doc + ' lin=' + lin + ' tc=' + tc +
                  ' etapa=«' + eta + '» · servidor ' + a.estado + '/' + a.etapa +
                  ' · navegador ' + b.estado + '/' + b.etapa);
    }); }); }); }); }); });
    if(difD.length){
      fallos += difD.length;
      Logger.log('FALLO  ' + difD.length + ' de ' + n + ' combinaciones NO coinciden:');
      difD.slice(0,8).forEach(function(t){ Logger.log('       ' + t); });
    }else Logger.log('OK     las ' + n + ' combinaciones dan el mismo par en los dos lados');
  }

  /* ---- 2 · la cascada de secciones, sobre el par derivado ---- */
  Logger.log('');
  Logger.log('--- 2 · la cascada de secciones · 7 estados x 6 etapas x documento ---');
  var difS = [], m = 0;
  if(fnSec){
    ['','NUEVO','EN_PREPARACION','LISTO','ENTREGADO','INCOMPLETO','BASURA'].forEach(function(est){
      etapas.forEach(function(eta){ [false,true].forEach(function(doc){ [false,true].forEach(function(anu){
        m++;
        var cab = {}; cab.Estado = est; cab.Etapa_preparacion = eta; cab[COL_EST] = anu ? E_ANU : E_VIG;
        /* se clasifica el PAR tal cual, sin derivar, para comparar las dos cascadas */
        var a = (function(){
          if(anu) return 0;
          if(est === 'ENTREGADO') return 7;
          if(est === 'LISTO')     return doc ? 6 : 5;
          if(doc)                 return 6;
          if(eta === 'FINALIZAR') return 4;
          if(eta === 'DESPACHAR') return 3;
          if(eta === 'LISTO')     return 4;
          return 2;
        })();
        var b = fnSec({ estado:est, etapa:eta, anulado:anu, doc:doc ? { tipo:'REMISION' } : null });
        if(a !== b) difS.push('estado=«' + est + '» etapa=«' + eta + '» doc=' + doc + ' anulado=' + anu +
                              ' · servidor ' + a + ' · navegador ' + b);
      }); }); }); });
    if(difS.length){
      fallos += difS.length;
      Logger.log('FALLO  ' + difS.length + ' de ' + m + ' combinaciones NO coinciden:');
      difS.slice(0,8).forEach(function(t){ Logger.log('       ' + t); });
    }else Logger.log('OK     las ' + m + ' combinaciones caen en la misma seccion en los dos lados');
  }

  /* ---- 3 · y con los pedidos REALES del libro ---- */
  Logger.log('');
  Logger.log('--- 3 · los pedidos reales de R3_Pedidos ---');
  var peds = filas(H.pedidos);
  var ents = indicePor_(filas(H.entregas), 'P_num');
  var prep = agrupaPor_(filas(H.prep), 'P_num');
  var dets = agrupaPor_(filas(H.prepDet), 'P_num');
  var difR = [], cuenta = { 0:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0 };
  peds.forEach(function(cab){
    var pid = txt(cab.P_num);
    if(!pid) return;
    var ent = ents[pid] || {}, pa = prep[pid] || [], de = dets[pid] || [];
    var sec = seccionDePedido_(cab, ent, pa, de);
    if(cuenta[sec] !== undefined) cuenta[sec]++;
    if(!fnSec || !fnDer) return;
    /* se arma el pedido como lo veria el navegador y se clasifica alli */
    var vivas = de.filter(function(r){ return txt(r[COL_EST]).toUpperCase() !== E_ANU; });
    var d = fnDer(!!txt(ent.te),
                  !!(txt(cab.Fecha_real_listo) || pa.some(function(r){ return txt(r.tl); })),
                  !!txt(ent.Doc_tipo), vivas.length > 0, !!txt(cab.tc),
                  txt(cab.Etapa_preparacion));
    var secNav = fnSec({ estado:d.estado, etapa:d.etapa,
                         anulado:txt(cab[COL_EST]).toUpperCase() === E_ANU,
                         doc:txt(ent.Doc_tipo) ? { tipo:txt(ent.Doc_tipo) } : null });
    if(sec !== secNav)
      difR.push(pid + ' · hoja dice ' + txt(cab.Estado) + '/' + (txt(cab.Etapa_preparacion) || '(vacia)') +
                ' · servidor ' + nombreSeccion_(sec) + ' · navegador ' + nombreSeccion_(secNav));
  });
  Logger.log('       reparto del servidor: 2=' + cuenta[2] + ' 3=' + cuenta[3] + ' 4=' + cuenta[4] +
             ' 5=' + cuenta[5] + ' 6=' + cuenta[6] + ' · completados=' + cuenta[7] + ' · inhabilitados=' + cuenta[0]);
  if(difR.length){
    fallos += difR.length;
    Logger.log('FALLO  ' + difR.length + ' pedido(s) se clasifican distinto:');
    difR.forEach(function(t){ Logger.log('       ' + t); });
  }else Logger.log('OK     los ' + peds.length + ' pedido(s) caen en la misma seccion en los dos lados');

  Logger.log('');
  Logger.log(fallos ? '>>> ' + fallos + ' FALLO(S). El servidor y la pantalla NO dicen lo mismo.'
                    : '>>> El servidor y la pantalla coinciden en todo. Una sola autoridad.');
  Logger.log('No se escribio nada.');
  return { ok:fallos === 0, fallos:fallos, reparto:cuenta };
}


/* ####################################################################
   v5.4.1 · SANEAR LAS CABECERAS · version que SI escribe
   ####################################################################
   heralsaRepararEtapas() simula. Esta escribe. Esta aparte y con nombre
   explicito porque el editor de Apps Script ejecuta sin argumentos, y una
   funcion que borra o reescribe no puede quedar a un clic de distancia de
   la que solo mira.

   Antes de escribir vuelve a simular e imprime lo que va a hacer, asi que
   el registro queda con el antes y el despues de cada cabecera.
   #################################################################### */
function heralsaSanearCabecerasAHORA(){
  Logger.log('########## SANEO DE CABECERAS · ESTA FUNCION ESCRIBE ##########');
  Logger.log('Primero se vuelve a revisar lo que hay:');
  Logger.log('');
  var sim = repararEtapas_(true);
  if(!sim || !sim.tocadas){
    Logger.log('');
    Logger.log('>>> No habia nada que sanear. No se escribio nada.');
    return { ok:true, tocadas:0 };
  }
  Logger.log('');
  Logger.log('########## AHORA SE ESCRIBE ##########');
  var r = repararEtapas_(false);
  Logger.log('');
  Logger.log('>>> Ejecute heralsaRevisarLogica() para confirmar que el bloque 9 queda en OK.');
  Logger.log('>>> Y heralsaVerificarSeccion() para confirmar que servidor y pantalla coinciden.');
  return r;
}


/* ####################################################################
   v5.4.1 · BUG_008 · EL RASTRO QUE DEJO EN LOS DOCUMENTOS YA EMITIDOS
   ####################################################################
   La correccion de BUG_008 evita que vuelva a pasar, pero los documentos
   que se emitieron antes siguen escritos con la contradiccion: forma de
   pago CREDITO y medio de pago concreto, normalmente «Efectivo» porque el
   codigo viejo lo ponia por omision.

   QUE HACE: deja la forma de pago INTACTA y corrige el medio a «Instrumento
   no definido», que es lo que significa «a credito todavia no han pagado».
   Por omision SIMULA.

   QUE NO HACE, Y HAY QUE DECIRLO: no decide si la venta fue de verdad a
   credito. Si a usted le pagaron de contado y la forma de pago quedo mal,
   lo que hay que corregir es la FORMA, no el medio, y eso cambia la cartera
   -- ese pedido estaria apareciendo como cuenta por cobrar sin serlo --.
   Esa es una decision de negocio y se hace a mano, con conocimiento de la
   venta. Esta funcion solo arregla la contradiccion tecnica.
   #################################################################### */
function heralsaRepararPagos(){ return repararPagos_(true); }

/* =====================================================================
   v5.4.2 · LA PAREJA VISIBLE DE repararPagos_
   =====================================================================
   Apps Script oculta del desplegable las funciones que terminan en «_», asi
   que repararPagos_(false) no se podia ejecutar desde el editor sin escribir
   codigo. A las cabeceras les hice su version visible y a los pagos no: el
   mismo criterio tiene que valer para los dos.

   Antes de escribir vuelve a simular e imprime lo que va a hacer, igual que
   heralsaSanearCabecerasAHORA. La forma de pago NO se toca nunca: solo el
   medio, que es el que no debia existir en una venta a credito.
   ===================================================================== */
function heralsaRepararPagosAHORA(){
  Logger.log('########## CORRECCION DE MEDIOS DE PAGO · ESTA FUNCION ESCRIBE ##########');
  Logger.log('Primero se vuelve a revisar lo que hay:');
  Logger.log('');
  var sim = repararPagos_(true);
  if(!sim || !sim.tocadas){
    Logger.log('');
    Logger.log('>>> No habia nada que corregir. No se escribio nada.');
    return { ok:true, tocadas:0 };
  }
  Logger.log('');
  Logger.log('########## AHORA SE ESCRIBE ##########');
  Logger.log('RECUERDE: esto corrige el MEDIO de pago. La FORMA de pago queda');
  Logger.log('intacta. Si alguna de esas ventas NO fue a credito, lo que esta mal');
  Logger.log('es la forma, y eso se corrige a mano porque cambia su cartera.');
  Logger.log('');
  var r = repararPagos_(false);
  Logger.log('');
  Logger.log('>>> Ejecute heralsaRevisarCoherencia() para confirmar que no queda');
  Logger.log('>>> ninguna «Incoherencia de pago».');
  return r;
}
function repararPagos_(soloSimular){
  if(soloSimular === undefined) soloSimular = true;
  Logger.log(soloSimular ? '===== SIMULACION · medios de pago a credito · NO escribe ====='
                         : '===== CORRECCION DE MEDIOS DE PAGO · ESCRIBE =====');
  var ents = filas(H.entregas);
  var tocar = [], ok = 0, sinDoc = 0;
  var VALIDOS = ['INSTRUMENTO NO DEFINIDO', 'CREDITO', 'POR DEFINIR'];

  ents.forEach(function(e){
    var pid = txt(e.P_num);
    if(!pid || txt(e[COL_EST]).toUpperCase() === E_ANU) return;
    if(!txt(e.Doc_tipo)){ sinDoc++; return; }
    var forma = txt(e.Forma_pago), medio = txt(e.Medio_pago);
    if(forma.toUpperCase().indexOf('CRED') !== 0){ ok++; return; }
    if(!medio || VALIDOS.indexOf(medio.toUpperCase()) >= 0){ ok++; return; }
    tocar.push({ pid:pid, doc:txt(e.Doc_tipo) + ' ' + txt(e.Doc_numero),
                 forma:forma, medio:medio, plazo:numero(e.Plazo_dias) || 0,
                 vence:txt(e.Vencimiento) });
  });

  Logger.log('Documentos sin problema          : ' + ok);
  Logger.log('Pedidos sin documento (se saltan): ' + sinDoc);
  Logger.log('Documentos a credito con medio concreto: ' + tocar.length);
  tocar.forEach(function(t){
    Logger.log('  ' + t.pid + ' · ' + t.doc + ' · ' + t.forma + ' a ' + t.plazo + ' dias' +
      (t.vence ? ' (vence ' + t.vence + ')' : '') +
      ' · medio «' + t.medio + '»  ->  «Instrumento no definido»');
  });
  if(!tocar.length){
    Logger.log('Nada que corregir: ningun documento a credito declara un medio de pago concreto.');
    return { ok:true, tocadas:0 };
  }
  Logger.log('');
  Logger.log('ANTES DE APLICARLO, PREGUNTESE POR CADA UNO: ¿esa venta fue de verdad a credito?');
  Logger.log('  SI fue a credito  -> esta correccion es la buena: el medio no debia existir.');
  Logger.log('  NO, le pagaron ya -> lo que esta mal es la FORMA de pago, no el medio. Ese');
  Logger.log('     pedido esta en su cartera como cuenta por cobrar sin serlo, y eso se');
  Logger.log('     corrige a mano en R4_Entregas (Forma_pago, Plazo_dias y Vencimiento).');

  if(soloSimular){
    Logger.log('');
    Logger.log('=== FIN DE LA SIMULACION · no se escribio nada ===');
    Logger.log('Para aplicarlo: repararPagos_(false)');
    return { ok:true, simulado:true, tocadas:tocar.length, detalle:tocar };
  }

  var hechas = 0, logs = [];
  tocar.forEach(function(t){
    escribirFila({ hoja:H.entregas, noSello:true,
      claves:[{ columna:'P_num', valor:t.pid }],
      fila:{ Medio_pago:'Instrumento no definido' } });
    logs.push({ Tabla:H.entregas, Registro:t.pid, Campo:'Medio_pago',
      Valor_antes:t.medio, Valor_despues:'Instrumento no definido',
      Motivo:'BUG_008 · documento a credito no puede declarar medio de pago; ' +
             'el medio se registra con el abono. La forma de pago no se toco.' });
    hechas++;
  });
  try{ apiLogCambio_(logs, 'sistema'); }catch(e){}
  Logger.log('');
  Logger.log('=== CORREGIDOS ' + hechas + ' documento(s) ===');
  Logger.log('Cada cambio quedo en LOG_Cambios. La forma de pago quedo intacta.');
  return { ok:true, tocadas:hechas };
}

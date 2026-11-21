/* =====================================================================
   HERALSA · DIAGNOSTICO DEL DOCUMENTO QUE NO QUEDA ESCRITO
   =====================================================================
   ESTA FUNCION SOLO LEE. No escribe ni una celda, no emite nada, no borra
   nada. Se puede ejecutar con el libro abierto y repetir las veces que
   haga falta.

   PARA QUE SIRVE: el pedido P-021 mostro en pantalla «Remision R-004» y la
   hoja quedo sin documento. Hay CUATRO explicaciones posibles y son
   mutuamente excluyentes. Esta funcion dice cual de las cuatro es, con la
   fila fisica de la hoja como prueba:

     A  la escritura cayo en una fila NUEVA sin P_num (invisible para todo
        el sistema, porque filas() descarta la fila si su PRIMERA columna
        esta vacia y apiDocumento_ no escribe la clave)
     B  hay DOS filas de P-021 en R4 y cada lector mira una distinta
     C  la escritura si quedo en la fila correcta y algo la BORRO despues
        (la unica cosa que reescribe esa fila completa es la cola del
        navegador: enviar(packEntrega) justo despues de emitir)
     D  la escritura nunca ocurrio porque una guarda la paro, y la funcion
        igual respondio ok:true (apiDocumento_ no comprueba r.escrita)

   COMO SE USA
     1. En el editor de Apps Script: Archivo + > Script, nombrelo
        Diagnostico, pegue TODO esto y guarde.
     2. Arriba, en el desplegable de funciones, elija
        heralsaDiagnosticarDocumento y pulse Ejecutar.
     3. Copie el registro completo (Ver > Registro) y mandelo.

   Para revisar otro pedido cambie la linea de abajo.
   ===================================================================== */

var DIAG_PEDIDO = 'P-021';

function heralsaDiagnosticarDocumento(){
  var pid = txt(DIAG_PEDIDO);
  function L(s){ Logger.log(s === undefined ? '' : s); }

  L('===== DIAGNOSTICO DE DOCUMENTO · ' + pid + ' · SOLO LECTURA =====');
  L('Libro: ' + libro().getName());
  L('Fecha: ' + ahora());
  L('');

  /* ---------------------------------------------------------------
     1 · ESTRUCTURA FISICA DE R4_Entregas
     Importa porque filas() descarta la fila si la PRIMERA columna de la
     hoja esta vacia, no si P_num esta vacio. Si alguien inserto una
     columna a la izquierda, las dos cosas dejan de ser la misma.
     --------------------------------------------------------------- */
  var sh = hoja(H.entregas);
  var idx = indices(sh);
  var ancho = idx.__ancho, ultima = sh.getLastRow();
  var cabe = sh.getRange(1, 1, 1, ancho).getValues()[0];

  L('--- 1 · R4_Entregas, estructura fisica ---');
  L('ultima fila con datos: ' + ultima + '   ·   columnas: ' + ancho);
  L('PRIMERA columna de la hoja: "' + txt(cabe[0]) + '"');
  L('   filas() descarta toda fila que tenga ESTA columna vacia.');
  if(txt(cabe[0]) !== 'P_num')
    L('   >>> ATENCION: la primera columna NO es P_num. Eso solo ya puede');
  L('columna P_num: ' + (idx['P_num'] === undefined ? '>>> NO EXISTE <<<' : 'la numero ' + (idx['P_num'] + 1)));
  ['Doc_tipo','Doc_numero','Doc_fecha','Doc_estado','Doc_vendedor',
   'Forma_pago','Medio_pago','Plazo_dias','Vencimiento','te',COL_EST].forEach(function(c){
    L('   ' + c + ': ' + (idx[c] === undefined ? '>>> FALTA <<<' : 'columna ' + (idx[c] + 1)));
  });
  L('');

  /* ---------------------------------------------------------------
     2 · RECORRIDO CRUDO, FILA FISICA POR FILA FISICA
     Se lee con getValues() directo, NO con filas(), para ver tambien las
     filas que filas() esconde. Esa diferencia es el nucleo del asunto.
     --------------------------------------------------------------- */
  function g(fila, col){ return col === undefined ? '' : txt(fila[col]); }
  function pad(v, n){ var s = String(v === '' || v === null || v === undefined ? '-' : v);
                      while(s.length < n) s += ' '; return s; }
  var cP = idx['P_num'], cT = idx['Doc_tipo'], cN = idx['Doc_numero'],
      cD = idx['Doc_estado'], cTe = idx['te'], cS = idx[COL_EST];

  var crudo = ultima > 1 ? sh.getRange(2, 1, ultima - 1, ancho).getValues() : [];
  var invisibles = [], porPnum = {}, conDoc = [], docnums = [], filasDelPedido = [];

  L('--- 2 · R4_Entregas, todas las filas fisicas ---');
  L('fila | vis | P_num      | Doc_tipo  | Doc_numero | Doc_estado | te         | Estado_registro');
  for(var i = 0; i < crudo.length; i++){
    var f = i + 2, r = crudo[i];
    var visible = !!txt(r[0]);                    /* el criterio exacto de filas() */
    var p = g(r, cP), dt = g(r, cT), dn = g(r, cN), de = g(r, cD),
        te = g(r, cTe), es = g(r, cS);
    L(' ' + pad(f, 4) + '|  ' + (visible ? 'si' : 'NO')
      + ' | ' + pad(p || '(vacio)', 11)
      + '| ' + pad(dt, 10)
      + '| ' + pad(dn, 11)
      + '| ' + pad(de, 11)
      + '| ' + pad(te, 11)
      + '| ' + pad(es || '(vacio)', 1));
    if(!visible) invisibles.push({fila:f, p:p, dt:dt, dn:dn});
    if(p){ porPnum[low(p)] = (porPnum[low(p)] || []).concat([f]); }
    if(low(p) === low(pid)) filasDelPedido.push(f);
    if(dt) conDoc.push({fila:f, p:p, dt:dt, dn:dn, visible:visible});
    var m = String(dn).match(/^([A-Za-z]+)-(\d+)$/);
    if(m) docnums.push({fila:f, num:dn, n:parseInt(m[2], 10), pref:m[1], visible:visible, p:p});
  }
  L('');
  L('filas fisicas: ' + crudo.length + '   ·   visibles para filas(): ' + (crudo.length - invisibles.length)
    + '   ·   INVISIBLES: ' + invisibles.length);
  if(invisibles.length){
    L('>>> HAY FILAS INVISIBLES. Estas filas existen en la hoja y NINGUNA');
    L('>>> parte del sistema las ve (ni filas(), ni el consecutivo, ni el');
    L('>>> clasificador de secciones). Es la huella de la hipotesis A.');
    invisibles.forEach(function(x){
      L('    fila ' + x.fila + ' · P_num="' + x.p + '" · Doc_tipo="' + x.dt + '" · Doc_numero="' + x.dn + '"');
    });
  }
  var duplicados = [];
  for(var k in porPnum) if(porPnum[k].length > 1) duplicados.push(k.toUpperCase() + ' en filas ' + porPnum[k].join(', '));
  L('P_num repetidos en R4: ' + (duplicados.length ? duplicados.join(' · ') + '   <<< hipotesis B' : 'ninguno'));
  L('');

  /* ---------------------------------------------------------------
     3 · LA PRUEBA DECISIVA · LOS DOS BUSCADORES
     apiDocumento_ comprueba las guardas con buscarEn(filas(...)) y
     ESCRIBE con buscarFila(), que es otro algoritmo. Si los dos no
     devuelven la MISMA fila fisica, el documento se comprueba en un sitio
     y se escribe en otro. Esto es exactamente lo que hay que saber.
     --------------------------------------------------------------- */
  L('--- 3 · PRUEBA DECISIVA · los dos buscadores de la misma fila ---');
  var viaFilas = buscarEn(filas(H.entregas), 'P_num', pid);
  var filaLectura = viaFilas ? viaFilas.__fila : null;
  var filaEscritura = buscarFila(sh, idx, [{ columna:'P_num', valor:pid }]);

  L('lo que usan las GUARDAS  · buscarEn(filas(R4),P_num,' + pid + ') -> ' +
    (filaLectura === null ? 'NO ENCUENTRA NADA' : 'fila ' + filaLectura));
  L('lo que usa la ESCRITURA  · buscarFila(R4, P_num=' + pid + ')      -> ' +
    (filaEscritura === null ? 'NO ENCUENTRA NADA (null)' : 'fila ' + filaEscritura));
  L('filas fisicas con P_num=' + pid + ': ' + (filasDelPedido.length ? filasDelPedido.join(', ') : 'NINGUNA'));

  if(filaEscritura === null){
    L('');
    L('>>> CONFIRMADO, HIPOTESIS A · buscarFila devuelve null, asi que');
    L('>>> escribirFila AÑADE una fila nueva en la ' + (sh.getLastRow() + 1) + '. Y como el');
    L('>>> objeto filaDoc de apiDocumento_ NO lleva P_num y escribirFila no');
    L('>>> escribe las columnas clave, esa fila nueva queda SIN P_num:');
    L('>>> invisible para filas(), para el consecutivo y para las secciones.');
    L('>>> El servidor devuelve ok:true con el numero y la hoja no lo tiene.');
  }else if(filaLectura !== null && filaLectura !== filaEscritura){
    L('');
    L('>>> CONFIRMADO, HIPOTESIS B · la guarda lee la fila ' + filaLectura +
      ' y la escritura va a la ' + filaEscritura + '.');
  }else if(filaLectura !== null && filaLectura === filaEscritura){
    L('');
    L('    Los dos buscadores coinciden en la fila ' + filaLectura + '. La escritura va');
    L('    donde debe, asi que A y B quedan DESCARTADAS. Mire el bloque 4:');
    L('    si esa fila no tiene Doc_tipo, el documento se escribio y algo lo');
    L('    BORRO despues (hipotesis C), o una guarda lo paro (hipotesis D).');
  }
  L('');

  /* ---------------------------------------------------------------
     4 · LA FILA DEL PEDIDO, DATO POR DATO
     --------------------------------------------------------------- */
  L('--- 4 · la fila de ' + pid + ' en R4_Entregas ---');
  if(!viaFilas){
    L('NO HAY FILA para ' + pid + ' en R4_Entregas.');
    L('>>> Con esto, apiDocumento_ para en su guarda y responde');
    L('>>> «El pedido ' + pid + ' todavia no esta LISTO. Primero termina Finalizar»,');
    L('>>> que es un mensaje EQUIVOCADO: la causa real es que falta la fila.');
  }else{
    ['P_num','Cliente','Canal','tl','te','Doc_tipo','Doc_numero','Doc_fecha','Doc_estado',
     'Doc_vendedor','Forma_pago','Medio_pago','Plazo_dias','Vencimiento',COL_EST].forEach(function(c){
      if(idx[c] !== undefined) L('   ' + c + ' = "' + txt(viaFilas[c]) + '"');
    });
    L('   (fila fisica ' + viaFilas.__fila + ')');
    L('');
    L('   tiene documento segun el sistema (docDePedido_): ' + (docDePedido_(pid) ? 'SI' : 'NO'));
  }
  L('');

  /* ---------------------------------------------------------------
     5 · CONSECUTIVOS DE REMISION
     El numero NO se guarda en ningun contador: se deduce contando las
     filas VISIBLES de R4. Por eso, si la escritura se pierde, el mismo
     numero se vuelve a entregar, y dos pedidos distintos pueden recibirlo.
     --------------------------------------------------------------- */
  L('--- 5 · consecutivos de remision ---');
  var pref = apiConfig_().prefijo_remision || 'R';
  L('prefijo configurado: ' + pref);
  if(!docnums.length) L('no hay ningun Doc_numero con forma PREFIJO-### en la hoja');
  docnums.forEach(function(x){
    L('   ' + x.num + ' · fila ' + x.fila + ' · pedido ' + (x.p || '(sin P_num)') +
      (x.visible ? '' : '   <<< INVISIBLE: no cuenta para el consecutivo'));
  });
  var maxVis = 0, maxTodo = 0, repes = {};
  docnums.forEach(function(x){
    if(x.pref.toUpperCase() !== pref.toUpperCase()) return;
    if(x.visible) maxVis = Math.max(maxVis, x.n);
    maxTodo = Math.max(maxTodo, x.n);
    repes[x.num] = (repes[x.num] || 0) + 1;
  });
  L('maximo entre las filas VISIBLES: ' + maxVis + '  ->  el proximo numero seria ' + pref + '-' + ceros2(maxVis + 1, 3));
  L('maximo contando TODAS las filas: ' + maxTodo);
  if(maxTodo > maxVis)
    L('>>> Hay numeros ya usados que el sistema NO VE: va a volver a entregar el mismo.');
  var dobles = [];
  for(var kk in repes) if(repes[kk] > 1) dobles.push(kk);
  if(dobles.length) L('>>> NUMERO REPETIDO en dos filas: ' + dobles.join(', '));
  L('lo que devuelve apiNuevaRemision_() ahora mismo: ' + apiNuevaRemision_());
  L('');

  /* ---------------------------------------------------------------
     6 · LA CABECERA DEL PEDIDO EN R3
     --------------------------------------------------------------- */
  L('--- 6 · ' + pid + ' en R3_Pedidos ---');
  var cab = buscarEn(filas(H.pedidos), 'P_num', pid);
  if(!cab){
    L('>>> NO EXISTE el pedido ' + pid + ' en R3_Pedidos.');
  }else{
    ['P_num','Cliente','Canal','Estado','Etapa_preparacion','tc','Fecha_real_listo',
     'Revision','Finalizado_en',COL_EST].forEach(function(c){
      if(cab[c] !== undefined) L('   ' + c + ' = "' + txt(cab[c]) + '"');
    });
    L('   (fila fisica ' + cab.__fila + ')');
  }
  L('');

  /* ---------------------------------------------------------------
     7 · SIMULACION DE apiDocumento_ · NO ESCRIBE
     Se recorren sus guardas en el MISMO orden y con el MISMO pago que
     manda la pantalla para una venta a credito, para ver cual para y en
     que punto se habria consumido el numero.
     --------------------------------------------------------------- */
  L('--- 7 · simulacion de la emision · NO ESCRIBE NADA ---');
  var pago = { forma:'Credito', medio:'Instrumento no definido', plazo:30 };
  L('pago simulado (el mismo que manda la pantalla): ' + pago.forma + ' · ' +
    pago.medio + ' · ' + pago.plazo + ' dias');
  var paro = null;
  if(AL_FORMA.indexOf(pago.forma) < 0) paro = 'la forma de pago no esta en la lista de Alegra';
  if(!paro && AL_MEDIO.indexOf(pago.medio) < 0) paro = 'el medio de pago no esta en la lista de Alegra';
  var fac = null;
  if(!paro){
    fac = apiFactura_(pid);
    L('lineas que se cobrarian: ' + fac.lineas.length + ' · total ' + fac.total);
    if(!fac.lineas.length) paro = 'el pedido no tiene ninguna linea despachada';
  }
  if(!paro){
    var faltan = ['Doc_tipo','Doc_numero','Doc_fecha','Doc_estado']
      .filter(function(c){ return idx[c] === undefined; });
    if(faltan.length) paro = 'R4_Entregas no tiene las columnas ' + faltan.join(', ');
  }
  if(!paro && (!viaFilas || !cab)) paro = 'falta la fila de R4 o la cabecera de R3 (el mensaje dira «todavia no esta LISTO»)';
  if(!paro && txt(cab.Estado).toUpperCase() !== 'LISTO' && txt(cab.Estado).toUpperCase() !== 'ENTREGADO')
    paro = 'la columna Estado de R3 dice "' + txt(cab.Estado) + '", y la guarda exige LISTO o ENTREGADO';
  if(!paro && (txt(viaFilas['Doc_tipo']) || txt(viaFilas['Doc_numero'])))
    paro = 'ya tiene decision documental: ' + txt(viaFilas['Doc_tipo']) + ' ' + txt(viaFilas['Doc_numero']);

  if(paro){
    L('>>> LA EMISION SE PARARIA. Motivo: ' + paro);
    L('>>> En este caso el numero NO se consume y el navegador recibe ok:false,');
    L('>>> asi que la pantalla de exito NO deberia aparecer. Si aparecio, el');
    L('>>> error se perdio: el aviso de los 30 s pisa el toast del error.');
  }else{
    L('    Todas las guardas PASAN. La emision llegaria a escribir, y se');
    L('    consumiria el numero ' + apiNuevaRemision_() + ' ANTES de escribir la fila.');
    L('    Si la escritura falla despues de ese punto, el numero se pierde');
    L('    y apiDocumento_ igual responde ok:true, porque no comprueba');
    L('    r.escrita. Esa es la hipotesis D.');
  }
  L('');

  /* ---------------------------------------------------------------
     8 · DONDE CREE EL SERVIDOR QUE ESTA EL PEDIDO
     --------------------------------------------------------------- */
  L('--- 8 · clasificacion de ' + pid + ' ---');
  if(cab){
    var partes = filas(H.prep).filter(function(r){ return txt(r.P_num) === pid; });
    var det    = filas(H.prepDet).filter(function(r){ return txt(r.P_num) === pid; });
    var ent    = viaFilas || {};
    var coh = cabeceraCoherente_(cab, partes, det, ent);
    var sec = seccionDePedido_(cab, ent, partes, det);
    L('   seccion segun el servidor: ' + sec + ' · ' + nombreSeccion_(sec));
    L('   par derivado de los hechos: Estado=' + coh.estado + ' · Etapa=' + coh.etapa + '  (' + coh.porque + ')');
    L('   par guardado en la hoja  : Estado=' + txt(cab.Estado) + ' · Etapa=' + txt(cab.Etapa_preparacion));
    L('   coinciden: ' + (coh.coincide ? 'SI' : 'NO'));
    L('   lineas vivas en R2_Detalle: ' + det.filter(function(r){ return txt(r[COL_EST]).toUpperCase() !== E_ANU; }).length);
  }
  L('');

  /* ---------------------------------------------------------------
     9 · LAS INCONSISTENCIAS DE R3 Y R4
     El aviso «N dato(s) de la hoja necesitan revision» lo calcula el
     NAVEGADOR sobre seis hojas. Aqui se reproduce el pedazo de R3 y R4,
     que es el que importa para este asunto. El listado completo lo puede
     ver en la pantalla de Inicio, en el cuadro rojo (muestra los 6
     primeros).
     --------------------------------------------------------------- */
  L('--- 9 · inconsistencias de R3 y R4 (subconjunto del aviso de pantalla) ---');
  var av = [], vistos = {};
  filas(H.pedidos).forEach(function(r){
    var id = txt(r.P_num); if(!id) return;
    if(vistos[id]) av.push('R3_Pedidos: ' + id + ' esta dos veces.');
    vistos[id] = 1;
  });
  filas(H.entregas).forEach(function(r){
    var id = txt(r.P_num); if(!id) return;
    if(!vistos[id]){ av.push('R4_Entregas: ' + id + ' no existe en R3_Pedidos (fila huerfana).'); return; }
    var dt = txt(r.Doc_tipo).toUpperCase(), es = txt(r[COL_EST]).toUpperCase();
    if(!txt(r.te)){
      if(es === E_VIG && !dt) av.push('R4_Entregas: ' + id + ' dice VIGENTE pero no tiene te ni documento.');
      return;
    }
    if(es === E_PEND || es === E_NA) av.push('R4_Entregas: ' + id + ' dice ' + es + ' pero ya tiene te.');
    if(dt === 'FE' && txt(r.Doc_numero) && txt(r.Doc_estado).toUpperCase() !== 'FACTURADO')
      av.push('R4_Entregas: ' + id + ' es FE y ya trae numero sin estar facturada.');
  });
  if(!av.length) L('   ninguna en R3/R4');
  av.forEach(function(t){ L('   · ' + t); });
  L('');

  L('===== FIN · no se escribio nada =====');
  return { ok:true, pedido:pid, filaLectura:filaLectura, filaEscritura:filaEscritura,
           invisibles:invisibles.length, duplicados:duplicados, paro:paro };
}


/* =====================================================================
   HERALSA · ESPEJO DE LA BASE DE DATOS PARA REVISION
   =====================================================================
   PARA QUE: hoy, cuando algo falla, yo solo veo lo que usted alcanza a
   copiar de un registro. Eso es lento y parcial, y en el ultimo defecto
   fue decisivo: la fila 22 de R4 tenia la huella, pero hasta que usted no
   ejecuto el diagnostico yo no podia verla. Esto hace con la BASE DE DATOS
   lo que ya hacemos con el CODIGO en GitHub: dejar una copia que las dos
   partes pueden mirar.

   COMO FUNCIONA: exporta cada hoja a JSON y la sube a un repositorio
   PRIVADO suyo, con la API de GitHub. Cada ejecucion es un commit, asi que
   queda el historial: se puede comparar el antes y el despues de una
   operacion. De paso es un respaldo con fecha.

   LAS TRES PROTECCIONES, y ninguna es opcional:

   1. SE NIEGA A SUBIR A UN REPOSITORIO PUBLICO. Lo comprueba preguntandole
      a GitHub antes de subir nada. El repositorio del codigo es publico; el
      de los datos TIENE que ser privado, porque aqui hay nombres de
      clientes, NIT, telefonos y direcciones. Un dato publicado no se
      despublica: queda en cachés y en copias ajenas.

   2. NUNCA SUBE CAT_Usuarios. Esa hoja tiene Clave_hash y Sal. Una copia
      de eso fuera del libro es material para atacar las contraseñas con
      calma y sin que nadie lo note. La lista de exclusion esta en el
      codigo y no se puede desactivar con un parametro.

   3. LA CLAVE NO VIVE EN EL CODIGO. Vive en las propiedades del proyecto,
      que no se publican en GitHub ni se ven en la hoja. Y es una clave de
      alcance fino: un solo repositorio, solo Contenido, solo lectura y
      escritura. Se revoca en cualquier momento sin tocar nada mas.

   PREPARACION, una sola vez:
     1. En GitHub: New repository, nombre «Heralsa-datos», marque PRIVATE.
     2. En GitHub: Settings de su cuenta > Developer settings >
        Personal access tokens > Fine-grained tokens > Generate new token.
          Repository access : Only select repositories > Heralsa-datos
          Permissions       : Repository permissions > Contents >
                              Read and write
          Expiration        : 30 dias (se renueva igual que la de Alegra)
     3. En el editor de Apps Script: Configuracion del proyecto (el
        engranaje) > Propiedades de la secuencia de comandos >
        Agregar propiedad:
          GITHUB_TOKEN        = la clave que acaba de generar
          GITHUB_REPO_DATOS   = chrisalfonso-02/Heralsa-datos
     4. Ejecute heralsaPublicarSnapshot().

   Si prefiere no crear ninguna clave, no pasa nada: seguimos con los
   registros pegados a mano. Es mas lento y yo veo menos, pero funciona y
   no expone nada. La decision es suya.
   ===================================================================== */

/* Hojas que NO se copian NUNCA. No es configurable a proposito. */
var SNAPSHOT_PROHIBIDAS_ = ['CAT_Usuarios'];

function heralsaPublicarSnapshot(){
  function L(s){ Logger.log(s === undefined ? '' : s); }
  var P = PropertiesService.getScriptProperties();
  var tok  = txt(P.getProperty('GITHUB_TOKEN'));
  var repo = txt(P.getProperty('GITHUB_REPO_DATOS'));

  L('===== ESPEJO DE LA BASE DE DATOS =====');
  if(!tok || !repo){
    L('NO ESTA CONFIGURADO, y por eso no se subio nada.');
    L('Falta: ' + (!tok ? 'GITHUB_TOKEN ' : '') + (!repo ? 'GITHUB_REPO_DATOS' : ''));
    L('Lea el procedimiento en el comentario que esta justo encima de esta');
    L('funcion: son cuatro pasos y se hacen una sola vez.');
    return { ok:false, falta_configuracion:true };
  }
  if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)){
    L('GITHUB_REPO_DATOS tiene que ser «usuario/repositorio». Llego: ' + repo);
    return { ok:false };
  }

  function gh(ruta, metodo, cuerpo){
    var op = { method: metodo || 'get', muteHttpExceptions: true,
               contentType: 'application/json',
               headers: { 'Authorization': 'Bearer ' + tok,
                          'Accept': 'application/vnd.github+json',
                          'X-GitHub-Api-Version': '2022-11-28' } };
    if(cuerpo) op.payload = JSON.stringify(cuerpo);
    var r = UrlFetchApp.fetch('https://api.github.com' + ruta, op);
    var cod = r.getResponseCode(), txto = r.getContentText(), dat = null;
    try{ dat = JSON.parse(txto); }catch(e){}
    return { codigo: cod, datos: dat, texto: txto };
  }

  /* ---- PROTECCION 1 · el repositorio tiene que ser PRIVADO ---- */
  var info = gh('/repos/' + repo);
  if(info.codigo === 401 || info.codigo === 403){
    L('LA CLAVE NO SIRVE (' + info.codigo + '). Puede estar vencida, revocada, o sin el');
    L('permiso Contents: Read and write sobre ' + repo + '.');
    L('Genere otra y actualice GITHUB_TOKEN. Respuesta: ' + info.texto.substring(0,200));
    return { ok:false };
  }
  if(info.codigo === 404){
    L('NO EXISTE o la clave no lo alcanza: ' + repo);
    L('Compruebe el nombre, y que al generar la clave escogiera ESE repositorio.');
    return { ok:false };
  }
  if(info.codigo >= 400){ L('GitHub respondio ' + info.codigo + ': ' + info.texto.substring(0,300)); return { ok:false }; }
  if(!info.datos || info.datos.private !== true){
    L('>>> NO SE SUBIO NADA, Y ESTA BIEN QUE NO SE HAYA SUBIDO.');
    L('>>> ' + repo + ' es PUBLICO.');
    L('>>> Aqui van nombres de clientes, NIT, telefonos y direcciones. Un dato');
    L('>>> publicado no se despublica: queda en cachés y en copias ajenas.');
    L('>>> Ponga el repositorio en Private (Settings > General > Change');
    L('>>> visibility) o cree uno privado, y vuelva a ejecutar.');
    return { ok:false, repositorio_publico:true };
  }
  L('Repositorio: ' + repo + ' · privado: SI');

  /* ---- armado del espejo ---- */
  var nombres = [];
  libro().getSheets().forEach(function(sh){ nombres.push(sh.getName()); });
  var copiadas = [], omitidas = [], espejo = { generado: ahora(), libro: libro().getName(), hojas: {} };

  nombres.forEach(function(nom){
    if(SNAPSHOT_PROHIBIDAS_.indexOf(nom) >= 0){ omitidas.push(nom); return; }
    var sh = libro().getSheetByName(nom);
    var ult = sh.getLastRow(), anc = Math.max(sh.getLastColumn(), 1);
    if(ult < 1){ espejo.hojas[nom] = { columnas: [], filas: [] }; copiadas.push(nom + ' (vacia)'); return; }
    var todo = sh.getRange(1, 1, ult, anc).getValues();
    var cols = todo[0].map(function(c){ return txt(c); });
    var tz = tzLibro_(), fil = [];
    /* se copian TODAS las filas tal como estan, incluidas las que filas()
       esconde: justo esas son las que hay que poder ver. La fila fisica va
       en el espejo para poder señalarla sin ambiguedad. */
    for(var i = 1; i < todo.length; i++){
      var o = { __fila: i + 1 };
      for(var j = 0; j < cols.length; j++){
        var v = todo[i][j];
        o[cols[j] || ('col' + (j + 1))] = (v instanceof Date) ? fechaTexto(v, tz) : v;
      }
      fil.push(o);
    }
    espejo.hojas[nom] = { columnas: cols, filas: fil };
    copiadas.push(nom + ' (' + fil.length + ')');
  });

  var cuerpoJson = JSON.stringify(espejo, null, 1);
  L('Hojas copiadas : ' + copiadas.join(' · '));
  L('Hojas OMITIDAS : ' + (omitidas.join(' · ') || 'ninguna') + '   <- proteccion 2, no es configurable');
  L('Tamaño         : ' + cuerpoJson.length + ' caracteres');

  /* ---- subida: un archivo fijo (el estado de ahora) y uno con fecha ---- */
  function subir(ruta, texto){
    var actual = gh('/repos/' + repo + '/contents/' + ruta);
    var cuerpo = { message: 'Espejo de la base de datos · ' + ahora(),
                   content: Utilities.base64Encode(texto, Utilities.Charset.UTF_8) };
    if(actual.codigo === 200 && actual.datos && actual.datos.sha) cuerpo.sha = actual.datos.sha;
    var r = gh('/repos/' + repo + '/contents/' + ruta, 'put', cuerpo);
    if(r.codigo >= 400){ L('   FALLA ' + ruta + ' · ' + r.codigo + ' · ' + r.texto.substring(0,200)); return false; }
    L('   OK    ' + ruta + ' · commit ' + ((r.datos && r.datos.commit && r.datos.commit.sha) || '').substring(0,10));
    return true;
  }

  var sello = Utilities.formatDate(new Date(), tzLibro_(), 'yyyy-MM-dd_HHmm');
  L('');
  var ok1 = subir('espejo/ahora.json', cuerpoJson);
  var ok2 = subir('espejo/historial/' + sello + '.json', cuerpoJson);

  L('');
  if(ok1) L('>>> LISTO. El estado de ahora esta en espejo/ahora.json y queda el');
  if(ok1) L('>>> historial fechado al lado. Cada ejecucion es un commit, asi que se');
  if(ok1) L('>>> puede comparar el antes y el despues de cualquier operacion.');
  return { ok: ok1, repositorio: repo, hojas: copiadas.length, omitidas: omitidas, sello: sello };
}

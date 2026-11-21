/* INSTALACIÓN ADITIVA · no borra datos ni ejecuta migrarHeralsa_. */
function simularInstalacionHeralsa(){
  var ss=libro(), reporte=[];
  Object.keys(ESQUEMA_NATIVO).forEach(function(n){
    var sh=ss.getSheetByName(n), faltantes=ESQUEMA_NATIVO[n];
    if(sh && sh.getLastColumn()){
      var enc=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(txt);
      faltantes=ESQUEMA_NATIVO[n].filter(function(c){return enc.indexOf(c)<0;});
    }
    reporte.push({hoja:n,existe:!!sh,filas:sh?Math.max(0,sh.getLastRow()-1):0,columnas_faltantes:faltantes});
  });
  return {ok:true,solo_simulacion:true,escribe:false,reporte:reporte};
}

function instalarHeralsa(){
  var lock=LockService.getScriptLock();lock.waitLock(30000);
  try{
    var ss=libro(), copia=ss.copy('HERALSA · respaldo antes de instalar · '+ahora().replace(/[: ]/g,'-'));
    Object.keys(ESQUEMA_NATIVO).forEach(function(n){asegurarEsquemaNativo_(ss,n);});
    completarAliasNativos_(ss);
    asegurarConfigNativa_();
    var alta=asegurarUsuariosNativos_();
    var integridad=verificarIntegridadNativa_();
    return {ok:true,respaldo:copia.getName(),usuarios_creados:alta.creados,
      /* v5.1 · se devuelven UNA vez y no quedan guardadas en ninguna parte. */
      claves_temporales:alta.claves,
      aviso:alta.creados?'ANOTE LAS CLAVES TEMPORALES AHORA: no se pueden recuperar despues.':'',
      integridad:integridad,
      mensaje:'Instalación aditiva terminada. No se borraron filas ni se cargaron datos demo.'};
  }finally{lock.releaseLock();}
}

function asegurarEsquemaNativo_(ss,n){
  var sh=ss.getSheetByName(n), cols=ESQUEMA_NATIVO[n];
  if(!sh){sh=ss.insertSheet(n);sh.getRange(1,1,1,cols.length).setValues([cols]);formatearHojaNativa_(sh);return;}
  if(!sh.getLastColumn()){sh.getRange(1,1,1,cols.length).setValues([cols]);formatearHojaNativa_(sh);return;}
  var enc=sh.getRange(1,1,1,sh.getLastColumn()).getDisplayValues()[0].map(txt);
  cols.forEach(function(c){
    if(enc.indexOf(c)>=0)return;
    var pos=enc.indexOf(COL_EST);
    if(pos>=0 && [COL_EST,COL_MOT,COL_POR,COL_CUA].indexOf(c)<0){sh.insertColumnBefore(pos+1);sh.getRange(1,pos+1).setValue(c);enc.splice(pos,0,c);}
    else{sh.getRange(1,enc.length+1).setValue(c);enc.push(c);}
  });
  formatearHojaNativa_(sh);
}

/* Presentación aditiva: no cambia valores, columnas ni registros. */
function formatearHojaNativa_(sh){
  if(!sh || !sh.getLastColumn())return;
  sh.getRange(1,1,1,sh.getLastColumn()).setFontWeight('bold')
    .setBackground('#15455e').setFontColor('#ffffff');
  sh.setFrozenRows(1);
  if(!sh.getFilter())sh.getRange(1,1,Math.max(1,sh.getLastRow()),sh.getLastColumn()).createFilter();
}

/* =====================================================================
   v5.1 · C1 · NI UNA LECTURA DE HOJA DENTRO DE UN BUCLE
   =====================================================================
   Las dos lineas de H.entregas hacian buscarEn(filas(H.pedidos), ...)
   DENTRO del callback, es decir una lectura completa de R3_Pedidos por
   cada fila de R4_Entregas. Con 8 entregas son 8 lecturas; con 800 son
   800, y la instalacion se queda sin tiempo de ejecucion.
   Ahora R3 se lee UNA vez y se indexa por P_num.
   ===================================================================== */
function completarAliasNativos_(ss){
  var clientes={},proveedores={},productos={},pedidosPorNum={};
  filas(H.clientes).forEach(function(r){if(r.Cliente_id)clientes[txt(r.Cliente_id)]=txt(r.Cliente);});
  filas(H.proveedores).forEach(function(r){if(r.Proveedor_id)proveedores[txt(r.Proveedor_id)]=txt(r.Proveedor);});
  filas(H.productos).forEach(function(r){if(r.Codigo)productos[txt(r.Codigo)]=txt(r.Descripcion);});
  filas(H.pedidos).forEach(function(r){if(r.P_num)pedidosPorNum[txt(r.P_num)]=r;});   /* v5.1 · una sola lectura */
  aliasColumna_(H.compras,'Proveedor',function(r){return r.Proveedor||proveedores[txt(r.Proveedor_id)]||'';});
  aliasColumna_(H.pedidos,'Cliente',function(r){return r.Cliente||clientes[txt(r.Cliente_id)]||'';});
  aliasColumna_(H.pedidos,'Tipo_venta',function(r){return r.Tipo_venta||(String(r.Operador).toLowerCase()==='mostrador'?'MOSTRADOR':'');});
  aliasColumna_(H.prepDet,'Referencia',function(r){return r.Referencia||r.Codigo||'';});
  aliasColumna_(H.prepDet,'Codigo',function(r){return r.Codigo||r.Referencia||'';});
  aliasColumna_(H.prepDet,'Descripcion',function(r){return r.Descripcion||r.Descripcion_producto||productos[txt(r.Referencia||r.Codigo)]||'';});
  aliasColumna_(H.detalle,'Descripcion',function(r){return r.Descripcion||productos[txt(r.Codigo)]||'';});
  aliasColumna_(H.detalle,'Proveedor',function(r){return r.Proveedor||'';});
  aliasColumna_(H.entregas,'Cliente',function(r){var p=pedidosPorNum[txt(r.P_num)];return r.Cliente||(p&&p.Cliente)||'';});
  aliasColumna_(H.entregas,'Canal',function(r){var p=pedidosPorNum[txt(r.P_num)];return r.Canal||(p&&p.Canal)||'';});
  aliasColumna_(H.mov,'Descripcion',function(r){return r.Descripcion||productos[txt(r.Codigo)]||'';});
}

/* v5.1 · C1 · escribe por TRAMOS CONTIGUOS en vez de celda por celda.
   Se conserva la regla exacta de antes: solo se rellenan celdas que
   estaban VACIAS, nunca se pisa un valor escrito. Lo unico que cambia es
   que 40 celdas seguidas pasan de 40 llamadas a 1. */
function aliasColumna_(nombre,campo,calc){
  var sh=hoja(nombre);if(sh.getLastRow()<2)return;
  var ix=indices(sh);if(ix[campo]===undefined)return;
  var datos=sh.getRange(2,1,sh.getLastRow()-1,ix.__ancho).getValues(),cambios=[];
  var llaves=Object.keys(ix).filter(function(k){return k!=='__ancho';});
  for(var i=0;i<datos.length;i++){
    if(txt(datos[i][ix[campo]])!=='')continue;
    var r={};llaves.forEach(function(k){r[k]=datos[i][ix[k]];});
    var valor=calc(r);if(txt(valor)!=='')cambios.push({fila:i+2,valor:valor});
  }
  if(!cambios.length)return;
  var col=ix[campo]+1,j=0;
  while(j<cambios.length){
    var k=j;
    while(k+1<cambios.length && cambios[k+1].fila===cambios[k].fila+1) k++;
    var tramo=cambios.slice(j,k+1).map(function(x){return [x.valor];});
    sh.getRange(cambios[j].fila,col,tramo.length,1).setValues(tramo);
    j=k+1;
  }
}

function asegurarConfigNativa_(){
  var defs={inventario_modo:'SHEETS',mostrar_iva:'S',permitir_venta_sin_stock:'S',doc_offline:'REMISION',prefijo_remision:'R',canal_precio_M:'Precio_mayorista',canal_precio_R:'Precio_minorista',doc_tamano:'AUTO',doc_lineas_media:'6'};
  Object.keys(defs).forEach(function(k){
    if(!buscarEn(filas(H.cfg),'Clave',k))anexarBloque(H.cfg,HOJAS_F2[H.cfg],[{Clave:k,Valor:defs[k],Descripcion:'Configuración HERALSA'}]);
  });
}

/* =====================================================================
   v5.1 · LA CLAVE TEMPORAL YA NO ESTA ESCRITA EN EL CODIGO
   =====================================================================
   Antes habia una clave fija escrita aqui en claro, y cualquiera que
   abriera el proyecto podia entrar con ella. Ahora se genera una distinta
   por usuario, se devuelve UNA sola vez en el resultado de
   instalarHeralsa() y no queda en ningun sitio mas: ni en el codigo, ni
   en la hoja, donde solo queda el hash derivado.
   ANOTELAS CUANDO LAS VEA. No hay forma de recuperarlas despues; si se
   pierden hay que asignar una clave nueva desde la pantalla de usuarios.

   NOTA PARA SU CASO CONCRETO: esta funcion solo actua si CAT_Usuarios
   esta VACIA. Su libro ya tiene cuatro usuarios, asi que no se va a
   ejecutar y sus claves actuales no cambian. Esto protege la proxima
   instalacion, no la suya.
   ===================================================================== */
function claveTemporalNueva_(){
  var MAY='ABCDEFGHJKLMNPQRSTUVWXYZ',   /* sin I ni O: se confunden con 1 y 0 */
      MIN='abcdefghijkmnpqrstuvwxyz',   /* sin l */
      NUM='23456789',                   /* sin 0 ni 1 */
      SIG='!@#$%&*+-';
  function de(s){return s.charAt(Math.floor(Math.random()*s.length));}
  var c=[de(MAY),de(MAY),de(MIN),de(MIN),de(MIN),de(MIN),de(NUM),de(NUM),de(NUM),de(SIG),de(SIG)];
  for(var i=c.length-1;i>0;i--){var j=Math.floor(Math.random()*(i+1)),t=c[i];c[i]=c[j];c[j]=t;}
  return c.join('');   /* 11 caracteres: cumple validarClaveNativa_ */
}

function asegurarUsuariosNativos_(){
  if(filas('CAT_Usuarios').length)return {creados:0,claves:[]};
  var usuarios=[['crstian','Crstian','ADMIN'],['hernando','Hernando','OPERACION'],['deyana','Deyana','OPERACION'],['mostrador','Vendedor mostrador','MOSTRADOR']];
  var claves=[];
  usuarios.forEach(function(u,i){
    var clave=claveTemporalNueva_();
    crearUsuarioNativo_(u[0],u[1],u[2],clave,i+1);
    claves.push(u[0]+' = '+clave);
  });
  return {creados:usuarios.length,claves:claves};
}

function verificarIntegridadNativa_(){
  var errores=[],duplicados=0,huerfanos=0;
  Object.keys(PK_NATIVO).forEach(function(n){
    var keys=PK_NATIVO[n];if(!keys.length)return;
    var vistos={};filas(n).forEach(function(r){
      var k=keys.map(function(c){return low(r[c]);}).join('|');if(!k.replace(/\|/g,''))return;
      if(vistos[k]){duplicados++;errores.push(n+': llave duplicada '+k);}vistos[k]=true;
    });
  });
  RELACIONES_NATIVAS.forEach(function(rel){
    var a=rel.desde.split('.'),b=rel.hacia.split('.'),padres={};
    filas(b[0]).forEach(function(r){padres[low(r[b[1]])]=true;});
    filas(a[0]).forEach(function(r){var v=low(r[a[1]]);if(v&&!padres[v]){huerfanos++;errores.push(rel.desde+': no existe '+v+' en '+rel.hacia);}});
  });
  return {ok:errores.length===0,duplicados:duplicados,huerfanos:huerfanos,errores:errores.slice(0,100)};
}

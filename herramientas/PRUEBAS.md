# Repetir las pruebas del navegador

Las pruebas de flujo **no necesitan la hoja de cálculo**. Se corren sobre el
`Index.html` del repositorio con un arnés que simula las respuestas del servidor.
Sirven para comprobar un cambio antes de pegarlo en Apps Script, y para
reproducir un defecto sin tocar datos reales.

## Montar la página de pruebas

```bash
python3 - <<'PY'
import io
t = io.open('Index.html', encoding='utf-8').read()
h = io.open('herramientas/arnes-pruebas.js', encoding='utf-8').read()
io.open('prueba.html','w',encoding='utf-8',newline='').write(
    t.replace('</body>', '<script>\n'+h+'\n</script>\n</body>'))
PY
```

Abra `prueba.html` en el navegador y, en la consola, entre con
`A.demoEntrar('ADMIN')`.

## Qué hace el arnés

- Pone `ONLINE = true` y **reemplaza `srv()`**, el único punto por el que la
  aplicación habla con el servidor. Nada más se toca: el código que se prueba es
  el mismo que se despliega.
- Responde `apiMostradorCliente`, `apiMostradorCrearCliente`,
  `apiMostradorVenta`, `apiMostradorTirilla`, `apiDocumento`, `apiGuardar`,
  `apiEditarFactura`, `apiGuardarCliente`, `apiCajaResumen` y `apiEstado`.
- Los precios y el IVA **salen del catálogo que la propia página tiene cargado**
  (`precioDe`, `ivaDe`, `desc`), no de valores inventados: así el arnés no puede
  «aprobar» un cálculo con datos que la aplicación no tiene.
- Anula `window.print()` y cuenta las impresiones en `window.__IMPRESO`.
- Deja lo enviado al servidor en `window.__DOC`, `__EDITAR`, `__CLI`,
  `__GUARDAR`, `__VENTAS` y `__ESTADO`, para poder afirmar **qué se envió**, no
  solo qué se pintó.

## Las tres pruebas que no se deben omitir

### 1 · La tarjeta y la lista dicen lo mismo (BUG_004)

Genera los 168 pedidos posibles (estado × etapa × documento × anulado,
incluyendo valores basura) y compara el contador de cada tarjeta con la cantidad
de pedidos que su lista pinta de verdad.

```js
DB.pedidos = [];
['','NUEVO','EN_PREPARACION','LISTO','ENTREGADO','INCOMPLETO','BASURA'].forEach(function(es){
 ['','ORGANIZAR','DESPACHAR','FINALIZAR','LISTO','ESPERANDO'].forEach(function(et){
  [false,true].forEach(function(doc){ [false,true].forEach(function(anu){
   var n = DB.pedidos.length + 1;
   DB.pedidos.push({ id:'T-'+n, cliente:'C'+n, canal:'R', solicitud:today(), compromiso:today(),
     creado:nowT(), op:'x', tipo:'R', tc:(et==='DESPACHAR'||et==='FINALIZAR'||et==='LISTO')?nowT():null,
     estado:es, etapa:et, revision:1, descGlobal:0,
     partes:[{ t:'R', td:'', tl:'', surtido:true, mp:null, refFalta:[], mpFalta:[], faltante:[],
       completo:true, reproceso:false, defecto:'', op:'x', reg:nowT(), meta:{},
       lin:[{ cod:(DB.refs||[])[0], n:1, w:1, como:'INVENTARIO', precio:12000, dpct:0, iva:19 }] }],
     entrega:null, doc:doc?{tipo:'REMISION',numero:'R-'+n,fecha:today(),estado:'EMITIDO'}:null,
     anulado:anu, motivo:anu?'x':'', anulPor:'', anulEn:'' });
  }); }); }); });
save();

var s = h6Secciones_();
[[2,'ORGANIZAR',s.org],[3,'DESPACHAR',s.des],[4,'FINALIZAR',s.fin]].forEach(function(x){
  var lista = (S.preSel({etapa:x[1]}).body.match(/A\.preStart\(/g)||[]).length;
  console.log('sec'+x[0], 'tarjeta='+x[2].length, 'lista='+lista, x[2].length===lista?'OK':'DISCREPAN');
});
console.log('sec5', s.fac.length, (S.fsel().body.match(/A\.facStart\(/g)||[]).length);
console.log('sec6', s.ent.length, (S.enSel().body.match(/A\.enStart\(/g)||[]).length);
```

**Esperado:** tarjeta = lista en las cinco, y la suma de las cinco secciones más
completados más inhabilitados igual al total.

### 2 · Ningún pedido queda sin salida

```js
var malos = [];
DB.pedidos.forEach(function(p){
  var sec = h6SeccionDe_(p);
  if([2,3,4].indexOf(sec) < 0) return;
  A.preStart(p.id);
  if(cur.n === 'detP') malos.push(p.id + ' sec' + sec);
});
console.log('sin poder abrir:', malos.length ? malos : 'ninguno');
```

**Esperado:** `ninguno`. Un pedido visible en una sección y que no se puede abrir
es el defecto de BUG_004.

### 3 · Ninguna pantalla falla · comparación contra la versión anterior

```js
var malas = [], ok = 0;
var ctx = { fact:{id:'T-1'}, detP:{id:'T-1'}, fedit:{id:'T-1'},
            preSel:{etapa:'ORGANIZAR'}, hojas:{v:'leyenda'} };
Object.keys(S).sort().forEach(function(n){
  try { var s = S[n](ctx[n]||{}); (s && typeof s.body === 'string') ? ok++ : malas.push(n); }
  catch(e){ malas.push(n); }
});
console.log('pantallas='+Object.keys(S).length, 'OK='+ok, 'FALLAN=' + malas.join(','));
```

Varias pantallas fallan **al llamarlas en frío** porque necesitan un estado de
trabajo que construye su propio flujo. Eso es normal. **Lo que importa es
comparar la lista con la de la versión anterior:** si aparece una pantalla nueva
en la lista, es una regresión. Monte la página de pruebas con el `Index.html` del
commit anterior y compare las dos listas.

## Qué NO prueban

- Nada que dependa de la hoja real: consecutivos, candados, idempotencia,
  permisos por perfil, rendimiento.
- Que la impresión salga bien en papel.
- Las verificaciones `heralsa*`, que corren en el servidor.

Para todo eso está [`../docs/VERIFICACION.md`](../docs/VERIFICACION.md).

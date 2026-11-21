# Historial de versiones

Cada versión dice **qué defecto cerró**, **por qué ocurría** y **cómo se
comprueba**. Un cambio sin las tres cosas no se registra aquí.

---

## v5.4.1

### El servidor y la pantalla vuelven a ser una sola autoridad

**Lo encontraron los datos reales**, cruzando dos registros que se contradecían:

```
heralsaRevisarLogica : seccion 6 -> P-007 · P-010 · COMPLETADOS 2
la pantalla          : Completos 3, con P-007 dentro
```

**Causa.** El frontend no lee `R3_Pedidos.Estado`: lo deduce de los hechos. El
clasificador del servidor sí leía la columna. P-007 tiene fecha de entrega y la
columna en `LISTO`: el navegador lo daba por ENTREGADO y el servidor por LISTO
con documento. Había dos autoridades donde se había prometido una.

**Corrección.**
- `derivarPar_(...)` pasa a ser una función **pura**, byte por byte idéntica en
  los dos archivos. La derivación se escribe una vez.
- `seccionDePedido_` deja de leer columnas: clasifica sobre el par derivado.
- Se retira `logSeccionDe_`, una **tercera** copia de la cascada que la revisión
  usaba «para comparar». Una copia para comparar es una copia que se desactualiza.
- La etapa vacía ya no se rellena con el *estado* (ponía valores que no son
  etapas, como `EN_PREPARACION`, y el clasificador los mandaba a Organizar por
  descarte). Ahora se deriva del hecho: con `tc`, la etapa es `DESPACHAR`.
- **C5** nuevo en la normalización: hay fecha de entrega y el `Estado` no dice
  `ENTREGADO`. `cohPedido_` ya lo avisaba; faltaba corregirlo.

**Cómo se comprueba.** `heralsaVerificarSeccion()`.

**Herramientas nuevas.** `heralsaSanearCabecerasAHORA()`, `heralsaRepararPagos()`.

---

## v5.4 · cierra los 7 hallazgos de la matriz

### BUG_004 (Alta) · un pedido incompleto se perdía y no aparecía

**Causa.** Cinco fuentes de verdad para la sección de un pedido: la cascada
buena, `S.preSel` (exigía que la etapa dijera *literalmente* el nombre de la
sección), `porFacturarHoy`/`S.enSel` (por estado), `h6EtapaReal_` y el servidor
(etapa con respaldo fijo a `DESPACHAR`). Con `Etapa_preparacion='LISTO'` y
estado abierto, la tarjeta contaba el pedido en Finalizar, la lista no lo
encontraba y el servidor rechazaba toda acción.

El desalineamiento venía de tres sitios: `escribirFila` partía la cabecera de R3
en **cinco** `setValues` (`Estado` es la columna 15 y `Etapa_preparacion` la 26),
el atajo idempotente del cierre confirmaba sin escribir la etapa, y `packPedido`
podía mover `Estado` sin tocar `Etapa_preparacion`.

**Corrección.** Una sola autoridad; escritura **atómica** de la cabecera; y
`normalizarCabecera_`, que si el par queda contradictorio lo corrige con los
hechos como juez la próxima vez que se toque el pedido, dejando el motivo en
`LOG_Cambios`. No se confía en que la escritura no se corte: el sistema converge.

**Cómo se comprueba.** `heralsaRevisarLogica()` bloques 1 y 9.

### BUG_008 (Alta) · no se podía emitir ninguna venta a crédito

**Causa.** Dos guardas propias se contradecían: `cohPago_` exigía que a crédito
el medio fuera `Credito` o `Por definir`; `apiDocumento_` exigía que estuviera en
`AL_MEDIO`, la lista literal de Alegra, **que no contiene ninguno de los dos**.

**Corrección.** Las dos usan `Instrumento no definido`, el único valor de Alegra
que significa «todavía no definido». La pantalla deja de pedir el medio cuando la
forma es crédito. El servidor lo **fija**, no lo adivina.

### BUG_007 (Alta) · la clave de Alegra caducó

No es un defecto del código: la clave de prueba de Alegra caduca. Lo que sí era
defecto: el mensaje metía caducidad, permiso faltante y clave inválida en una
sola frase. Ahora se distinguen, y `heralsaAlegraRenovar()` lee la caducidad
*dentro* del token guardado e imprime el procedimiento.

### BUG_001 · un cliente nuevo no aparecía en el buscador

**Causa.** `A.addCat` pasaba `null` como callback de éxito: nunca resincronizaba.
Y `sincronizar()` **descartaba en silencio** la petición completa si había otra
lectura en vuelo, con el ciclo de 30 s leyendo constantemente.

**Corrección.** `sincronizar` recuerda la petición y la relanza; una petición
completa gana sobre una ligera. Si la hoja rechaza el alta, la entrada local se
retira: antes quedaba un cliente fantasma.

### BUG_002 · no se preseleccionaba el canal del cliente

**Causa.** `A.npCli` sí lo preseleccionaba desde `CAT_Clientes.Canal_habitual`,
pero la pantalla nunca leía `W.canal` y la acción siguiente lo sobreescribía: era
código muerto. Y la lista blanca del rol MOSTRADOR recortaba la columna.

**Corrección.** Se muestra con **Confirmar** o **Editar** (editar: ADMIN y
OPERACIÓN); si no lo tiene, pregunta; si se escoge otro, pregunta si se le cambia
al cliente. `Canal_habitual` llega a todos los perfiles.

**Cómo se comprueba.** `heralsaVerificarCanal()`.

### BUG_003 · al escribir la cantidad, la pantalla sacaba al operador

**Causa.** La cantidad vive solo en memoria hasta Guardar, y el ciclo de fondo
reasignaba el estado de trabajo y navegaba. La guarda miraba el tipo del elemento
con foco, así que no protegía con los botones **+ / −** ni al cerrar el teclado
del móvil; y empezaba por `silencioso &&`, así que `vaciarCola` la desactivaba.

**Corrección.** Bandera explícita del estado del trabajo. Repintado por partes.
`A.preStart` fusiona en vez de reasignar cuando es el mismo pedido.

### BUG_005 · cualquier edición exigía razón

Ahora el motivo se pide solo cuando cambia un **precio**. Un descuento se guarda
sin preguntar y queda registrado igual: se quita la fricción, no la trazabilidad.

### Código muerto retirado

La `S.pedidos` vieja con sus cuatro condiciones independientes, y las tres
condiciones de pertenencia duplicadas.

---

## v5.3.1

- **Punto 4 corregido según la regla del negocio:** editar el precio en
  Facturación **sí** cambia el precio del pedido, su detalle y su total — se
  vendió a ese precio. Lo que no cambia nunca es `CAT_Productos`. Se retiraron
  las dos columnas que había inventado para lo contrario.
- La regla de las cinco secciones queda escrita en el código y visible en
  pantalla, con el conteo del día y la palabra «cuadra».

## v5.3

- **Mostrador:** cédula primero, empaques **ESPECIALES** (marca, parte, medidas,
  material) mezclables con productos de catálogo, y la venta `M-###` se crea **al
  imprimir la tirilla**, no antes. Reimpresión por número.
- **Vendedor del documento** (`R4_Entregas.Doc_vendedor`), separado del vendedor
  habitual del cliente.
- **Rendimiento.** `buscarFila` leía la hoja entera **por cada fila escrita**:
  guardar un pedido de 8 referencias eran 24 lecturas completas. Ahora busca del
  lado de Sheets con respaldo. `apiGuardar` lee R3 una vez. El contexto que ya
  existía se pasa a `apiFactura_`: la revisión de coherencia pasa de 91 lecturas
  a ~5. `heralsaMedirGuardado()` mide el antes y el después en su hoja.
- `heralsaRevisarLogica()`: invariantes de estructura, incluida la caja contada
  dos veces.

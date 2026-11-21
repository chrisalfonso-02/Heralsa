# Historial de versiones

Cada versión dice **qué defecto cerró**, **por qué ocurría** y **cómo se
comprueba**. Un cambio sin las tres cosas no se registra aquí.

---

## v5.5

### El documento que se emitía bien y después se borraba solo

**Lo encontró el usuario operando**: P-021 pasó por 5 Facturación, la pantalla
mostró «Remisión R-004», y el pedido siguió en Facturación sin llegar a Entrega.
Su hipótesis era que la clave de Alegra estaba vencida.

**La hipótesis era falsa y se puede probar.** Una remisión no toca Alegra en
ningún punto: `alegraLlamar_` es el único sitio que lee la clave y ninguno de
sus seis invocadores está en la pila de `apiDocumento_`.

**La causa real, con huella forense.** `heralsaDiagnosticarDocumento()` leyó la
fila 22 de `R4_Entregas` cruda, y ahí estaba la prueba:

```
Doc_vendedor    = "Cristian"      <- sólo la escribe apiDocumento_:2486
Doc_tipo        = ""              <- sí está en la proyección del navegador
Doc_numero      = ""
Estado_registro = "PENDIENTE"     <- sólo lo escribe index.html:3656,
                                     y sólo cuando su copia local no
                                     tiene documento
```

El servidor emitió y escribió bien. Después la cola del navegador reescribió la
fila **completa** desde una copia local sin documento y lo borró. Sobrevivió la
única columna que el navegador no sabe que existe.

**Por qué la copia local estaba vacía.** `A.facEjecutar` toma la referencia del
pedido *antes* de llamar al servidor. La emisión tarda segundos y en ese rato el
ciclo de 30 s completa una sincronización: `hidratar()` reconstruye
`DB.pedidos` con objetos nuevos. La guarda `editandoAhora_()` evita el
repintado, **pero no evita el cambio de los datos**. El objeto que se mutaba era
un huérfano.

**Y por qué el operador nunca vio un error.** `toast()` tenía una sola ranura de
2,3 s. El aviso del ciclo de sincronización pisaba cualquier mensaje de la
emisión. El sistema sí decía lo que pasaba.

### Corrección, por principio y no por parche

| Dónde | Qué cambia |
|---|---|
| `apiGuardar_` (servidor) | **Un solo dueño por columna.** Las columnas del documento son del servidor. La cola **puede** poner un documento donde no hay ninguno —lo necesita la emisión sin señal— y **nunca** puede borrar ni cambiar uno. Va en el servidor porque el navegador vive en caché: un dispositivo sin actualizar seguiría borrando. |
| `apiDocumento_` | **El éxito se demuestra.** Relee la fila con `flush()` y compara antes de responder `ok:true`. Antes miraba sólo `r.bloqueada` e ignoraba `r.escrita`. |
| `apiDocumento_` | `filaDoc` lleva `P_num` y `Estado_registro: VIGENTE`. Un mensaje por causa en vez de «todavía no está LISTO» para tres cosas distintas. |
| `escribirFila` | Escribe las **columnas clave** al crear una fila nueva. Sin esto, un llamador que no repitiera la clave dejaba una fila sin `P_num`, invisible para `filas()`, para el consecutivo y para las secciones. |
| `nuevaRemisionSinLock_` | El `ScriptLock` **no es reentrante**: `apiNuevaRemision_` lo pedía y lo soltaba dentro del candado de `apiDocumento_`, así que comprobar-duplicado y escribir dejaban de ser atómicos. Y el consecutivo se cuenta sobre la hoja cruda: un número usado no se reutiliza nunca. |
| `listo()` (navegador) | Vuelve a buscar el pedido **dentro** del callback. Y cuando el número viene del servidor, no sube nada: esa fila ya tiene dueño. |
| `toast()` | Dos clases de aviso. Un error **grave** se queda hasta que se toca y un aviso de rutina no lo puede pisar. |
| `srv()` | `SESIÓN_VENCIDA` ya invoca el callback de error. Antes dejaba `W.guardando` en `true` para siempre y todo reintento moría sin llegar al servidor. |
| mostrador | El «deshacer» del callback de fallo ya no borra: un fallo de transporte significa que se perdió la respuesta, no que no ocurriera. Se relee la hoja. |
| indicadores 1 y 8 | Filtran días negativos, como ya hacía el 4. Hoy P-012 metía un valor negativo en el promedio del 8. |

### Lo mismo esperaba en la sección 6

`A.enSave` sube la fila de R4 con esas columnas copiadas de su estado local. Era
**el mismo defecto** esperando al registrar una entrega: podía borrar la
remisión de un pedido al entregarlo. Queda cerrado por la misma regla.

### Cómo se comprueba

```
heralsaVerificarDocumento()        0 fallos · los 4 casos de la regla
heralsaDiagnosticarDocumento()     0 filas invisibles · los dos buscadores coinciden
heralsaVersiones()                 todo parejo en v5.5
```

Después de pegar: emitir P-021 otra vez. Tiene que tomar **R-004**, pasar a
**6 Entrega**, y seguir ahí después de un ciclo de 30 s.

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

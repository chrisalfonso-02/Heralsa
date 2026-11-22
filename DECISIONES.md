# Decisiones de diseño ya tomadas

**Para qué existe este documento.** El 21 de noviembre reporté como defecto
grave (BUG_034) el tope de despacho del modo «Manda la hoja». No era un
defecto: era una decisión de negocio ya tomada, implementada y explicada en la
pantalla de configuración. La corregí, rompí una función que servía, y Cristian
tuvo que devolverme el trabajo.

> «esto no se puede convertir en un bucle de errores y ahora vuelves y
> encuentras un error que ya habíamos corregido»

Tiene razón. Un hallazgo que reabre una decisión cerrada no es un hallazgo: es
trabajo destruido y tiempo perdido. Este documento es la medida contra eso.

**La regla, y es obligatoria.** Antes de llamar defecto a cualquier cosa:

1. Buscarla en esta lista. Si está aquí, **no es un defecto**: es una decisión.
2. Si parece contradecir algo, el error está en mi lectura hasta que se
   demuestre lo contrario, no en el código.
3. Leer la pantalla que el operador ve, no sólo la función. En el caso de
   BUG_034 la pantalla de configuración explicaba la regla completa y correcta;
   yo leí la función suelta y saqué la conclusión opuesta.
4. Si después de todo eso sigue pareciendo un defecto, **preguntar antes de
   corregir**.

---

## 1 · El inventario: quién manda cuando el saldo y la bodega no coinciden

`CFG_Config.inventario_modo` · valores `SHEETS` y `OPERADOR` · lo elige el
administrador en la configuración de la app.

| Modo | Qué hace | Consecuencia buscada |
|---|---|---|
| **SHEETS** · «Manda la hoja» | No se puede despachar más de lo que dice el saldo | El inventario **nunca queda negativo**. Si se pidieron 14 y hay 9, se despachan 9 y las 5 quedan pendientes |
| **OPERADOR** · «Manda el operador» | Se despacha lo que se vio en la bodega, aunque el saldo diga otra cosa | El saldo **puede quedar negativo**, y un negativo no es un error: es una discrepancia que hay que contar |

**La venta no se bloquea en ninguno de los dos modos.** En SHEETS se recorta a
lo que hay y el pedido sigue como incompleto. Ésa es la diferencia que yo leí
mal: confundí *recortar* con *cancelar*.

Dónde vive: `CODIGO-COMPLETO.gs` en la validación de línea de `apiPreparacion_`;
`index.html` en `modoHoja()` y en la pantalla de configuración, que es donde
está explicado para el operador.

**Caso normal que parece defecto:** con el kardex vacío todos los saldos son 0,
así que en modo SHEETS no se puede despachar nada. Eso es correcto: la hoja dice
que no hay nada. Lo que corresponde es cargar el inventario inicial con
movimientos de entrada, no cambiar el código.

## 2 · El kardex nunca rechaza un movimiento (I-19)

Un movimiento que deja el saldo negativo **se registra igual**. El inventario no
tiene autoridad para cancelar una venta: el saldo probablemente esté mal, y el
dato malo se corrige, la venta no se pierde. La aplicación anterior de la
empresa hacía lo contrario y por eso se caían ventas reales.

Esto es la regla del **kardex**, no del modo de inventario. Son dos puntos de
decisión distintos y compatibles: el modo decide cuánto se puede despachar; I-19
decide que el movimiento resultante siempre se anota.

## 3 · El saldo se suma, no se guarda

No hay columna de saldo en ninguna parte. Se deriva de `MOV_Inventario`.
Escribir un saldo a mano lo dejaría sin explicación.

## 4 · El estado del pedido se deduce de los hechos

`R3_Pedidos.Estado` no se lee como verdad: se deriva con `derivarPar_` de los
hechos, en este orden de autoridad: `te` → `tl` → documento → `tc` → líneas.
La función es **pura y byte-idéntica** en el servidor y en el navegador, y
`heralsaVerificarSeccion` comprueba que no divergan.

## 5 · Las cinco secciones

Un pedido pendiente o incompleto está **siempre** en una de las cinco secciones
(2 a 6). Si ya se entregó está en Completos; si se inhabilitó, en Inhabilitados.
No hay ningún otro sitio donde pueda estar. `heralsaRevisarLogica` bloque 1
comprueba que las cinco más completados más inhabilitados den el total.

## 6 · El expediente avanza y no retrocede

`R2_Preparacion` y `R2_Detalle` no se reescriben si el pedido está cerrado.
`R3_Pedidos` acepta un estado igual o más avanzado que el de la hoja, nunca uno
anterior. Función pura `colaPuedeEscribirExpediente_`, 7 casos comprobados.

## 7 · Las columnas del documento son del servidor

`Doc_tipo`, `Doc_numero`, `Doc_fecha`, `Doc_estado`, `Doc_vendedor`,
`Forma_pago`, `Medio_pago`, `Plazo_dias`, `Vencimiento` y las de Alegra las
escribe sólo el servidor. La cola **puede** poner un documento donde no hay
ninguno —lo necesita la emisión sin señal— y **nunca** puede borrar ni cambiar
uno. La regla vive en el servidor porque el navegador vive en caché.

## 8 · La app nunca inventa un número fiscal

La remisión lleva consecutivo interno `R-###` que pone la app. El número de la
factura electrónica lo pone Alegra: para una FE la app deja el número **vacío**
y el estado `POR_FACTURAR`.

Sin señal el número de remisión es **provisional** y el papel lo dice. El número
definitivo lo asigna la hoja al reconectar, que es el único sitio que ve todos
los dispositivos.

## 9 · A crédito no hay medio de pago

Una venta a crédito todavía no se ha cobrado, así que no se sabe cómo se va a
cobrar. El medio es `Instrumento no definido` —el único valor de la lista de
Alegra que significa eso— y el medio real se registra cuando entre el abono.

## 10 · Mostrador es otra cosa

Consecutivo propio `M-###`, hojas propias `MOS_Ventas` y `MOS_Detalle`, no
consume `P-###` y **no entra en los diez indicadores**, porque no tiene tiempos
que medir. Sí descuenta inventario y sí entra en caja.

## 11 · Los empaques especiales no mueven el kardex

Un empaque hecho a medida no tiene saldo que descontar: nunca entró a bodega.
Registrarle una salida dejaría `MOV_Inventario` con un código que no existe en
`CAT_Productos`. El consumo de la lámina es un movimiento de materia prima, que
es otra cosa y hoy no se registra.

## 12 · El precio editado queda en el pedido, no en el catálogo

Corregir un precio en Facturación cambia el pedido y su total. **No** cambia
`CAT_Productos`. El catálogo se edita por su ruta propia, con motivo y registro.
Cambiar un precio exige motivo; mover un descuento no.

## 13 · Un indicador con n=0 dice «sin datos», no «cero por ciento»

Cada indicador imprime su `n`. Los ANULADOS se excluyen antes de calcular: un
pedido anulado no es un fracaso, es un no-evento.

## 14 · Toda reparación de datos simula por omisión

Las funciones que corrigen datos no escriben hasta que se les pide
explícitamente, y tienen pareja visible en el desplegable (Apps Script esconde
las que terminan en `_`). La limpieza de producción exige escribir una frase y
hace una copia del libro en Drive antes de borrar.

---

# Pendientes de decisión, no de corrección

Estas dos están abiertas **a propósito**. No son defectos y no se tocan sin
decisión de Cristian.

## A · Las tres copias de la fecha de cierre

`tl` vive en `R2_Preparacion.tl`, `R4_Entregas.tl` y
`R3_Pedidos.Fecha_real_listo`. El cierre escribe las tres con el mismo valor en
la misma operación, así que desde un libro limpio nacen idénticas. El indicador
4 lee la primera y el indicador 8 la segunda. Si alguna se edita a mano, los dos
indicadores miden desde copias distintas. La revisión de coherencia ya lo avisa
(BUG_031). Reducirlas a una es un cambio de esquema.

## B · Dónde vive la marca de «producto no confiable»

Necesita columna propia. Reutilizar `CAT_Productos.Requiere_revision` lo
mezclaría con la revisión de **calidad**, que es otra cosa y vive junto a
`Observacion_calidad`.

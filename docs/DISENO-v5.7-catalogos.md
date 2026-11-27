# v5.7 · Catálogos editables y costo por proveedor

**Estado: DISEÑO, pendiente de aprobación. No hay código escrito todavía.**

Esto toca la estructura de la base de datos, así que se diseña antes de
programar. Pegar una tabla nueva y tres pantallas sin acordar el modelo es
exactamente cómo se crean las incoherencias que llevamos semanas sacando.

---

## 1 · Lo que ya existe (leído de las hojas reales, no supuesto)

```
CAT_Productos    Codigo · Descripcion · Tipo_trabajo · Unidad · Punto_reorden ·
                 Activo · Codigo_barras · IVA · Precio_mayorista ·
                 Precio_minorista · Costo · Categoria · Costo_origen ·
                 Inventariable · Cuenta_ventas · Cuenta_inventario ·
                 Cuenta_costo_venta · Requiere_revision · Observacion_calidad

CAT_Proveedores  Proveedor · Clase · Contacto · Lead_time_pactado_d · Activo ·
                 Proveedor_id · Tipo_identificacion · Numero_identificacion ·
                 Forma_pago · Medio_pago · Plazo_dias

R1_Detalle       C_num · Codigo · Descripcion · Tipo · Cant_pedida ·
                 Estado_recepcion · Proveedor · tn · tr · Cant_recibida ·
                 Fecha_recepcion · Costo_unitario
```

## 2 · Hallazgo: la mitad de lo que pide ya está en los datos

Usted pidió «un espacio para ver el lead time de ese producto por proveedor».

**`R1_Detalle` ya guarda, por cada compra: el producto, el proveedor, el costo
pagado y las fechas `tn` (se pidió) y `tr` (se recibió).**

De ahí sale, sin guardar nada nuevo:

| Lo que se quiere ver | Cómo se calcula |
|---|---|
| Lead time real de ese producto con ese proveedor | promedio de `tr − tn` de sus compras |
| Último costo pagado a ese proveedor | el `Costo_unitario` de la compra más reciente |
| Si cumple completo | % de `Estado_recepcion = COMPLETA` |
| Cuántas veces se le ha comprado | número de filas |

Es el mismo criterio que ya rige el inventario: **el saldo se suma, no se
guarda**. El lead time real tampoco se guarda: se calcula de los hechos. Si se
guardara, habría dos verdades y un día no coincidirían.

**Conclusión:** no hace falta una tabla para el historial. Hace falta una tabla
para lo que **todavía no se ha registrado en ninguna parte**: el acuerdo
comercial vigente.

## 3 · Lo que sí necesita tabla nueva

Hoy no hay dónde guardar:

- lo que un proveedor **cotiza hoy**, aunque todavía no se le haya comprado
- **cuál proveedor es el preferido** para un producto
- el **código con el que ese proveedor** identifica el producto (hace falta para
  pedírselo)
- la **cantidad mínima** de pedido
- el **lead time pactado con ese proveedor para ese producto** (el que hay en
  `CAT_Proveedores` es general del proveedor, no por producto)

Esto es una relación **muchos a muchos**: un producto tiene varios proveedores y
un proveedor surte varios productos.

### Por qué una tabla y no columnas repetidas

La alternativa sería `Proveedor_1, Costo_1, Proveedor_2, Costo_2...` en
`CAT_Productos`. No se hace, por tres razones concretas:

1. **El número de proveedores no tiene tope.** Con columnas hay que decidir un
   máximo arbitrario y el día que haya uno más, hay que cambiar el esquema.
2. **Toda consulta se vuelve un caso especial.** «¿Cuál es el proveedor más
   barato?» con columnas exige mirar N parejas; con filas es ordenar por costo.
3. **Rompe la forma en que ya funciona todo lo demás.** `R2_Preparacion` usa dos
   filas por pedido, no dos juegos de columnas. `R1_Detalle` usa una fila por
   referencia. La casa ya tiene una manera de hacer esto.

### Esquema propuesto · `CAT_Abastecimiento`

Clave: **(`Codigo`, `Proveedor`)** — una fila por pareja producto-proveedor.

| Columna | Qué guarda |
|---|---|
| `Codigo` | el producto o la materia prima · apunta a `CAT_Productos.Codigo` o `CAT_MateriasPrimas.Codigo` |
| `Tipo` | `PRODUCTO` o `MATERIA_PRIMA` · igual criterio que `R1_Detalle.Tipo` |
| `Proveedor` | apunta a `CAT_Proveedores.Proveedor` |
| `Referencia_proveedor` | el código con que ÉL lo llama |
| `Costo_acordado` | lo que cotiza hoy |
| `Vigente_desde` | desde cuándo rige ese precio |
| `Lead_time_pactado_d` | los días que promete para ESTE producto |
| `Minimo_pedido` | cantidad mínima |
| `Preferido` | `S` en uno solo por producto |
| `Observacion` | notas |
| `Activo` | `S`/`N` |
| `Estado_registro`, `Motivo_anulacion`, `Anulado_por`, `Anulado_en` | la convención de la casa: nada se borra, se inhabilita |

### El cambio es ADITIVO: nada de lo que existe se rompe

`CAT_Productos.Costo` se lee en 7 sitios del servidor y 7 del navegador, todos
para calcular margen. **Si `Costo` conserva su significado, ninguno cambia.**
No hay migración de datos y no hay comportamiento que se altere: la tabla nueva
sólo añade información que hoy no existe.

## 4 · `Costo` y `Costo_acordado` NO son el mismo dato

Es importante y es la trampa en la que no hay que caer (ver el problema de las
tres copias de `tl` en DECISIONES.md).

- **`CAT_Productos.Costo`** = a cuánto valoro lo que tengo en bodega. Es un dato
  de contabilidad y alimenta el margen.
- **`CAT_Abastecimiento.Costo_acordado`** = lo que me cobra cada proveedor. Hay
  uno por proveedor y cambian cuando ellos suben precios.

Son dos hechos distintos, así que tenerlos los dos no es duplicar.
**Lo que sí sería duplicar** es que `Costo` se calculara automáticamente del
proveedor preferido: ahí habría dos sitios diciendo lo mismo y un día no
coincidirían. Ver la decisión B.

---

## 5 · Decisiones que necesito de usted

### A · ¿Se compra el producto, o el insumo con el que se fabrica?

Esta es la más importante y cambia la tabla.

Ya está establecido en el sistema que **a un proveedor de producto F se le
compra el INSUMO, no el producto** — por eso `CAT_MateriasPrimas` existe aparte
y `R1_Detalle.Tipo` distingue los dos.

Entonces, para una empaquetadura que ustedes **fabrican**: ¿el proveedor se
asocia al producto terminado, o a la lámina?

1. **Sólo al insumo** para los productos F, y al producto para los R
   (reempacados, que se compran hechos).
2. **A los dos**, porque un mismo empaque a veces se fabrica y a veces se compra
   hecho.

La columna `Tipo` de la propuesta cubre las dos, pero necesito saber cuál es la
realidad para diseñar la pantalla: si es la 1, la ficha del producto F debe
mostrar los proveedores **de su lámina**, no del producto.

### B · ¿Quién manda en `CAT_Productos.Costo`?

1. **Lo escribe usted** y es el costo de valoración. La tabla nueva es
   informativa, para comparar proveedores. *(Mi recomendación: un dato, un
   dueño.)*
2. **Se calcula** del proveedor preferido. Más cómodo, pero crea una segunda
   copia del mismo número y la experiencia de este proyecto dice que esas copias
   se separan.

### C · ¿Un producto puede tener dos proveedores preferidos?

Mi propuesta: **no**, uno solo, y al marcar uno se desmarca el anterior
automáticamente, con registro en `LOG_Cambios`.

### D · ¿Se ve el costo en la pantalla de productos para todos los roles?

Hoy `estadoSeguro_` **le oculta `Costo` al rol MOSTRADOR** a propósito. Las
pantallas nuevas son sólo para ADMIN y OPERACIÓN (Hernando y Deyana), así que
esto sólo importa si algún día entra otro rol. Confirmar que se mantiene oculto
para mostrador.

### E · Unidad de compra distinta a la de venta

Si al proveedor se le compra **la lámina** y usted vende **unidades**, hace falta
un factor de conversión para saber el costo por unidad. ¿Lo necesita ahora, o lo
dejamos para después y por ahora se registra el costo ya convertido?

**Esto no lo sé y no lo voy a suponer.** De la respuesta depende si la tabla
lleva dos columnas más (`Unidad_compra`, `Factor_conversion`) o no.

---

## 6 · Las tres pantallas

Mismo patrón las tres, porque un operador que aprende una sabe las tres:
**lista → selecciono → ficha completa → editar**.

### Productos

- **Lista:** buscador, código, descripción, tipo de trabajo, precios, un aviso
  si no tiene proveedor asignado.
- **Ficha:** identificación · cómo se hace (`Tipo_trabajo` F/R/MIXTO) · precios y
  IVA · **proveedores con su costo**, ordenados, señalando el preferido · lead
  time **real** calculado del historial al lado del pactado · saldo actual y
  punto de reorden · últimas compras · últimos cambios de precio de
  `LOG_Cambios`.
- **Editar:** cada campo con su explicación. El proveedor **se elige de la lista
  de proveedores**, nunca se escribe a mano: así no se crean proveedores
  fantasma.

### Proveedores

- **Lista:** nombre, clase, lead time pactado, cuántos productos surte.
- **Ficha:** datos fiscales y de pago · productos que surte con su costo ·
  cumplimiento real calculado de `R1_Detalle` · compras recientes.

### Clientes

- **Lista:** nombre, canal, identificación, un aviso si le faltan datos para
  factura electrónica.
- **Ficha:** datos fiscales · las tres direcciones de entrega · forma y medio de
  pago · plazo · pedidos del cliente · cartera.
- **Dos formas de crear, como usted pidió:** desde mostrador con lo mínimo y
  siempre **minorista**; desde pedido, completo y con los obligatorios.

### Inhabilitar, no borrar

Confirmado por usted. `Estado_registro = ANULADO` con motivo, autor y fecha.
Borrar un cliente con pedidos los dejaría huérfanos, que es justo lo que detecta
la comprobación de llaves foráneas de `heralsaVerificarIntegridad`.

---

## 7 · Orden de trabajo

| Paso | Qué |
|---|---|
| 1 | **Esta aprobación.** Sin las respuestas A y E la tabla queda mal desde el primer día |
| 2 | Crear `CAT_Abastecimiento` · aditivo, simula primero, no toca ningún dato |
| 3 | Lectura y cálculo: lead time real, cumplimiento y costos por proveedor desde el historial |
| 4 | Pantalla de **proveedores** · es la más simple, sirve de molde |
| 5 | Pantalla de **productos** · la más compleja, con el bloque de proveedores |
| 6 | Pantalla de **clientes** + los dos flujos de creación |
| 7 | Comprobaciones nuevas: ningún abastecimiento apunta a un proveedor o producto que no exista; ningún producto con dos preferidos |

Cada paso se publica y se verifica por separado. No se junta todo en una
entrega.

## 8 · Lo que no sé

- **La unidad de compra** (decisión E). Es lo único que puede obligar a cambiar
  la tabla después, y prefiero decirlo ahora que descubrirlo a mitad.
- **Cuántos proveedores por producto** hay en la realidad. Si son dos o tres, el
  diseño sobra de holgado y está bien. Si fueran decenas, la ficha necesitaría
  paginar.
- **Si quiere histórico de precios del proveedor** (ver cómo subió el costo en el
  tiempo) o sólo el vigente. Con `Vigente_desde` se puede guardar histórico
  añadiendo filas en vez de reemplazar, pero eso cambia la clave de la tabla.
  Dígame si le interesa y lo diseño así desde el principio: añadirlo después es
  mucho más costoso.

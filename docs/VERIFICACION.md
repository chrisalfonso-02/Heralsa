# Verificación de aceptación · v5.4.2

Dos clases de comprobación, y no sirven para lo mismo:

- **Automáticas** (`heralsa*`): comprueban los **datos** del libro y la
  **coherencia del código**. Se ejecutan desde el editor y dan un veredicto.
- **Manuales**: comprueban que un **flujo funcione de punta a punta en la
  aplicación**. Ninguna función de diagnóstico puede sustituirlas, porque
  dependen de pulsar botones en pantallas reales contra la hoja real.

---

## A · Automáticas · estado con los datos del 21-nov-2026

| Comprobación | Resultado | Qué prueba |
|---|---|---|
| `heralsaVersion()` | v5.4.2 en los dos archivos · cierra en `</html>` | el código está completo y parejo |
| `heralsaVerificarSeccion()` | 192 / 168 / 21 pedidos · **coinciden en todo** | **BUG_004** · servidor y pantalla, una sola autoridad |
| `heralsaVerificarCanal()` | 16 de 16 casos coinciden | **BUG_002** · la regla del canal es la misma en los dos lados |
| `heralsaRevisarLogica()` | **0 fallos · 0 avisos** · los 9 bloques en OK | los invariantes de estructura, incluido el bloque 9 (BUG_004) |
| `heralsaRevisarCoherencia()` | 0 errores · 0 avisos | ninguna contradicción interna en los 21 pedidos |
| `heralsaRepararPagos()` | detectó 1: P-007 | **BUG_008** · el rastro en documentos ya emitidos |

---

## B · Manuales · las que faltan

Cada una tiene **un paso** y **un resultado esperado**. Si el resultado no es el
esperado, apúntelo con el pedido o el cliente concreto.

### B1 · BUG_001 · un cliente nuevo aparece sin recargar

1. Pedidos → **1 Crear el pedido**.
2. En el buscador de cliente, escriba un nombre que no exista, por ejemplo
   `PRUEBA CLIENTE NUEVO`.
3. Pulse la última opción: **Agregar «PRUEBA CLIENTE NUEVO» · nuevo**.

**Esperado:** el cliente queda seleccionado, aparece el aviso «quedó en el
catálogo de la hoja», y al volver a abrir el buscador **está en la lista sin
recargar la página**.

**Si la hoja lo rechaza:** debe decir por qué y el cliente **no** debe quedar en
la lista. Antes quedaba un cliente fantasma con el que se podía crear un pedido.

> Al terminar, borre ese cliente de prueba de `CAT_Clientes` o inhabilítelo
> (`Activo = N`).

### B2 · BUG_002 · el canal del cliente viene preseleccionado

1. Pedidos → **1 Crear el pedido**.
2. Escoja un cliente que **tenga** `Canal_habitual` en `CAT_Clientes`.

**Esperado:** la pantalla del canal dice *«La hoja dice que … es M · Mayorista»*
y el botón del pie dice **Confirmar M · Mayorista y continuar**. Un toque y sigue.

3. Pulse **«Este cliente cambió de canal»** y escoja el otro canal.

**Esperado:** pregunta **si se le cambia el canal al cliente** con dos opciones:
«Cambiarle el canal al cliente» y «Solo para este pedido».

4. Escoja **Solo para este pedido**.

**Esperado:** continúa, y en `CAT_Clientes` el `Canal_habitual` **sigue igual**.

5. Repita y escoja **Cambiarle el canal al cliente**.

**Esperado:** avisa que quedó cambiado, y en `LOG_Cambios` aparece la fila con
`Campo = Canal_habitual`, el valor anterior, el nuevo y quién lo hizo.

6. Entre con el perfil **MOSTRADOR** y repita el paso 2.

**Esperado:** se ve el canal y **no** aparece el botón de editar; en su lugar
dice a quién pedirlo.

### B3 · BUG_003 · la cantidad no saca al operador

1. Pedidos → **2 Organizar** → abra un pedido → busque un producto y tómelo.
2. Toque dentro del campo de la cantidad y pulse **+** tres o cuatro veces.

**Esperado:** el número **cambia en pantalla** cada vez, el teclado no se cierra
y el cursor no se pierde.

3. Déjelo así, **sin guardar**, y espere **40 segundos** sin tocar nada (el ciclo
   de sincronización corre cada 30).

**Esperado:** la pantalla **no se mueve** y la cantidad **no se pierde**. Si algo
cambió en la hoja desde otro dispositivo, lo dirá al guardar, no quitándole el
trabajo de encima.

4. Guarde el producto.

**Esperado:** vuelve al buscador con el producto cargado y la cantidad correcta.

### B4 · BUG_005 · el motivo solo al cambiar el precio

1. Sección 5 → un pedido → **Editar precios y descuentos**.
2. Cambie **solo un descuento**.

**Esperado:** el pie dice **Guardar 1 corrección** y **no** pregunta el motivo.

3. Cambie ahora un **precio**.

**Esperado:** aparece *«¿Por qué se cambia el precio?»* y el pie dice **Falta
decir por qué cambia el precio** hasta que escoja una razón.

4. Guarde y abra `LOG_Cambios`.

**Esperado:** el cambio de precio con su motivo, y el de descuento con el motivo
por omisión del sistema. Los dos registrados.

### B5 · BUG_008 · se puede emitir a crédito

1. Sección 5 → un pedido listo sin documento.
2. Forma de pago: **Credito**. Plazo: 30 días.

**Esperado:** **no** aparecen las opciones de medio de pago. En su lugar explica
que a crédito no se pregunta el medio y que el medio real se registra con el
abono, en Cartera.

3. Emita la **remisión**.

**Esperado:** se emite sin errores. En `R4_Entregas` el `Medio_pago` dice
**`Instrumento no definido`** y la `Forma_pago` dice `Credito` con su plazo y su
vencimiento.

4. Ejecute `heralsaRevisarCoherencia()`.

**Esperado:** ninguna «Incoherencia de pago» para ese pedido.

### B6 · Mostrador de punta a punta

1. **Mostrador** → cédula → buscar o crear cliente.
2. Agregue un producto por código **y** un empaque **especial** (marca, parte,
   medida X, medida Y, material, precio).
3. **Cobrar e imprimir**.

**Esperado:** sale el número `M-###`, la tirilla con el QR, y el especial con sus
datos. El número **no existe** antes de pulsar ese botón.

4. Salga y entre por **Mis documentos → Reimprimir una tirilla**, con ese número.

**Esperado:** la reimprime **sin crear otra venta**. `heralsaVerificarMostrador()`
debe seguir cuadrando.

---

## C · Pendiente por diseño

### BUG_007 · la clave de Alegra

No se puede cerrar desde el código: la clave la genera usted en Alegra.

```
heralsaAlegraRenovar()   → dice cuántos días le quedan a la clave actual
                            e imprime el procedimiento de 9 pasos
```

Después de renovarla: `heralsaAlegraProbar2()` debe dar **4 de 4** permisos.

---

## D · Datos heredados que necesitan una decisión de negocio

No son defectos del código: son registros anteriores que hay que resolver.

| Pedido | Qué pasa | Decisión |
|---|---|---|
| **P-007** | documento a crédito con medio «Efectivo», por el defecto de BUG_008 | **confirmado: fue a crédito** → `heralsaRepararPagosAHORA()` |
| **P-001** | está en LISTO sin unidades despachadas | corregirle las cantidades, o inhabilitarlo |
| **P-012** | la entrega está fechada antes del cierre | corregir `te` o `tl` en la hoja |

El primero lo corrige la aplicación con rastro. Los otros dos cambian cifras del
negocio (cartera e indicadores de entrega), así que se corrigen con conocimiento
de lo que de verdad pasó, no automáticamente.

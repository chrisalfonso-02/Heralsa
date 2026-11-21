# HERALSA · Registro en campo

Aplicación de operación para **HERALSA** (empaquetaduras automotrices, Bogotá).
Corre sobre **Google Apps Script** y usa una hoja de cálculo de Google como
única base de datos.

> **La hoja es la única fuente de verdad.** La aplicación no guarda nada que
> pueda calcular, y no calcula nada que la hoja ya afirme. Si una columna y los
> hechos se contradicen, manda el hecho y la columna se corrige dejando rastro.

---

## 1 · Los tres archivos y dónde va cada uno

| Archivo del repositorio | Nombre en el editor de Apps Script | Qué es |
|---|---|---|
| `Codigo.gs` | **Codigo.gs** | Todo el servidor: lectura y escritura de la hoja, reglas de negocio, API de Alegra, verificaciones. |
| `Index.html` | **Index** (con I mayúscula) | La aplicación completa: pantallas, flujos y cálculos de presentación. `doGet()` la pide con ese nombre exacto. |
| `Instalacion.gs` | **Instalacion.gs** | Creación de hojas y columnas la primera vez. No se toca en el día a día. |

El nombre del HTML en Apps Script tiene que ser **`Index`**: `doGet()` hace
`createHtmlOutputFromFile('Index')`. Si se llama `index`, la aplicación no abre.

## 2 · Las hojas de la base de datos

Libro: `HERALSA_Base_Unificada`.

| Hoja | Una fila por | Quién la escribe |
|---|---|---|
| `R1_Compras` / `R1_Detalle` | compra al proveedor / referencia de la compra | la app |
| `R2_Preparacion` | **dos** por pedido, siempre: la parte F y la parte R | la app |
| `R2_Detalle` | línea del pedido (referencia, cantidades, precio, IVA) | la app |
| `R3_Pedidos` | pedido (la cabecera) | la app |
| `R4_Entregas` | pedido = entrega = documento | la app |
| `MOV_Inventario` | movimiento del kardex · **el saldo no se guarda: se suma** | la app |
| `MOV_Caja` | movimiento de caja | la app |
| `LOG_Cambios` | corrección hecha con rastro (quién, cuándo, de qué a qué, por qué) | la app |
| `MOS_Ventas` / `MOS_Detalle` | venta de mostrador con numeración propia `M-###` | la app |
| `CAT_Productos`, `CAT_Clientes`, `CAT_Proveedores`, `CAT_MateriasPrimas` | catálogo | **usted**, desde la app |
| `CFG_Config` | opción de configuración | la app |

**Las hojas de registro no se editan a mano.** El orden de sus filas es parte de
la lógica: el expediente de un pedido son cuatro filas alineadas.

## 3 · El proceso: cinco secciones donde un pedido espera

```
1 Crear  →  2 Organizar  →  3 Despachar  →  4 Finalizar  →  5 Facturación  →  6 Entrega
              └──────────── el pedido ESPERA en una de estas cinco ────────────┘
```

**La regla, y es un invariante comprobado:** un pedido ya creado está siempre en
**uno** de tres sitios, y en uno solo:

- una de las **cinco secciones** donde espera trabajo (2 a 6),
- en **Completados**, si ya se entregó,
- en **Inhabilitados**, si se anuló.

La sección 1 no es un sitio donde se espere: es el acto de crear el pedido, y por
eso no lleva contador.

### Cómo se garantiza

El estado y la etapa de un pedido **no se leen de la hoja: se deducen de los
hechos**. Una sola función pura lo decide, con el mismo nombre y el mismo cuerpo
en los dos archivos:

```
derivarPar_(hayEntrega, hayTl, hayDoc, hayLineas, hayTc, etapaGuardada) → {estado, etapa}
```

| Hecho | Par que le corresponde |
|---|---|
| hay fecha de entrega (`te`) | `ENTREGADO / LISTO` |
| hay fecha de cierre (`tl`) | `LISTO / LISTO` |
| hay documento emitido | `LISTO / LISTO` |
| no hay líneas | `NUEVO / ORGANIZAR` |
| hay líneas y no hay `tc` | `ORGANIZAR` o `DESPACHAR`, según la etapa guardada |
| hay `tc` y no hay `tl` | `DESPACHAR` o `FINALIZAR`, según la etapa guardada |

Sobre ese par decide la sección una cascada **exhaustiva y exclusiva**
(`h6SeccionDe_` en el navegador, `seccionDePedido_` en el servidor): devuelve
siempre `0, 2, 3, 4, 5, 6` o `7`, y la última línea no tiene condición, así que
nada puede quedar fuera.

`heralsaVerificarSeccion()` **extrae del Index que de verdad se sirve** las dos
funciones, las ejecuta con las 192 combinaciones de derivación y las 168 de
clasificación, y después con los pedidos reales del libro. Si alguna vez dejan de
coincidir, lo dice con el caso exacto y el número de pedido.

## 4 · Verificaciones · todas de solo lectura salvo donde se diga

Se ejecutan desde el desplegable de funciones del editor de Apps Script.

| Función | Qué comprueba | ¿Escribe? |
|---|---|---|
| `heralsaVersion()` | que los tres archivos sean de la misma versión y estén completos | no |
| `heralsaVerificarSeccion()` | que el servidor y la pantalla clasifiquen igual | no |
| `heralsaVerificarCanal()` | que la regla del canal sea la misma en los dos lados | no |
| `heralsaRevisarLogica()` | 9 bloques de invariantes de estructura | no |
| `heralsaRevisarCoherencia()` | contradicciones internas de cada pedido | no |
| `heralsaVerificarIntegridad()` | llaves primarias, foráneas y expediente | no |
| `heralsaVerificarMostrador()` | que mostrador quede fuera de los indicadores | no |
| `heralsaMedirGuardado()` | el coste real en segundos de leer y buscar | no |
| `heralsaDiagnosticarIndex()` | que el HTML pegado esté completo | no |
| `heralsaRepararEtapas()` | **simula** el saneo de cabeceras | no |
| `heralsaSanearCabecerasAHORA()` | simula, imprime **y aplica** el saneo | **sí** |
| `heralsaRepararPagos()` | **simula** la corrección de medios de pago a crédito | no |
| `heralsaRecalcularIndicadores()` | los diez indicadores | **sí** |
| `heralsaCrearColumnasV53()` | crea columnas que falten · aditivo, re-ejecutable | **sí** |
| `heralsaLimpiarParaProduccion()` | borra datos de prueba · doble confirmación y respaldo | **sí** |

Las funciones que terminan en `_` no aparecen en el desplegable: Apps Script las
oculta a propósito. Por eso cada reparación tiene su pareja visible.

### El criterio de las reparaciones

Toda función que escriba **simula por omisión**. Para aplicar de verdad hay que
llamarla con `false` o usar su versión con nombre explícito
(`heralsaSanearCabecerasAHORA`). Nunca queda una escritura a un clic de una
lectura.

## 5 · Despliegue

Ver [`docs/DESPLIEGUE.md`](docs/DESPLIEGUE.md). Lo esencial:

**Hay que EDITAR la implementación que ya existe y ponerle «Nueva versión».**
Crear una implementación nueva genera **otra dirección** y deja la de siempre
sirviendo la versión vieja. Es el error más fácil de cometer y el más difícil de
notar: todo parece bien y los operadores siguen con el código anterior.

## 6 · Seguridad

- **El token de Alegra nunca va en el código ni en el repositorio.** Vive en
  Propiedades del script (`ALEGRA_JWT`), que no se comparte. Se guarda con
  `heralsaAlegraGuardarToken()` y se borra del editor inmediatamente después.
  Con esa clave cualquiera puede emitir facturas a nombre de HERALSA.
- Antes de subir `Codigo.gs`, busque `eyJ` en el archivo. Si aparece dentro de
  una cadena de texto, es un token pegado por error: bórrelo.
- Las contraseñas de usuario se guardan con sal e iteraciones (`v2$`), nunca en
  claro. Las sesiones viven en `PropertiesService`, no en la hoja.
- Los permisos del token de Alegra son los mínimos: Facturas, Contactos e Ítems.
  **No** «Configuraciones generales».

## 7 · Perfiles

| Perfil | Puede |
|---|---|
| `ADMIN` | todo, incluidos usuarios, precios de catálogo y descuentos |
| `OPERACION` | la operación completa y el canal de un cliente; no administra cuentas |
| `MOSTRADOR` | solo venta inmediata, sus propios documentos y su cuenta |

## 8 · Repetir las pruebas

Las pruebas del navegador no necesitan la hoja: ver
[`herramientas/PRUEBAS.md`](herramientas/PRUEBAS.md).

## 9 · Historial

Ver [`CHANGELOG.md`](CHANGELOG.md).

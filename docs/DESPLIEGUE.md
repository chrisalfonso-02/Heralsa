# Procedimiento de despliegue

Cinco pasos. El paso 3 es el que se puede hacer mal sin que nada avise.

---

## 1 · Pegar los archivos

Por cada archivo que haya cambiado:

1. En GitHub, abra el archivo y pulse el icono de **portapapeles** (*Copy raw
   file*). Un clic copia el archivo completo; no hay que seleccionar nada.
2. En el editor de Apps Script, abra el archivo correspondiente, **Ctrl+A**,
   **Ctrl+V**, **Ctrl+S**.

| Repositorio | Apps Script |
|---|---|
| `Codigo.gs` | `Codigo.gs` |
| `Index.html` | `Index` · **con I mayúscula** |
| `Instalacion.gs` | `Instalacion.gs` |

## 2 · Comprobar que quedó completo

Ejecute **`heralsaVersion()`**. Tiene que decir la misma versión en `Codigo.gs` y
en `Index`, y `Termina en </html>: SI`.

Si las versiones no coinciden, uno de los dos se quedó atrás: vuelva a pegarlo.
El tamaño que reporta `HtmlService` **no sirve** para comparar — no devuelve el
texto literal del archivo. Para eso está `heralsaDiagnosticarIndex()`.

## 3 · Publicar · **aquí está el error fácil**

> **Hay que EDITAR la implementación que YA EXISTE y ponerle «Nueva versión».**

1. **Implementar ▾** → **Administrar implementaciones**.
2. Busque la implementación que usan los operadores. Pulse el **lápiz**.
3. En **Versión**, escoja **Nueva versión**.
4. **Implementar**.

**Por qué importa.** Si en vez de editar crea una implementación nueva, Apps
Script genera **otra dirección** y la de siempre sigue sirviendo el código
anterior. Todo parece bien: el editor dice que publicó, las verificaciones pasan,
y los operadores siguen trabajando con la versión vieja. No hay ningún mensaje
que lo avise.

**Cómo confirmarlo.** En **Administrar implementaciones**, cada implementación
muestra su número de **Versión**. La que usan los operadores tiene que ser la del
número más alto. Si hay más de una implementación, apunte cuál es la de
producción y no la pierda:

```
Implementación de producción: ______________________________________
URL: https://script.google.com/macros/s/__________________________/exec
```

## 4 · Verificar en orden

```
heralsaVersion()            → la misma versión en los dos archivos
heralsaVerificarSeccion()   → «El servidor y la pantalla coinciden en todo»
heralsaVerificarCanal()     → las dos copias de la regla coinciden
heralsaRevisarLogica()      → 0 fallos · los 9 bloques en OK
heralsaRevisarCoherencia()  → 0 errores
```

Si alguna escribe algo (`heralsaCrearColumnasV53`, los saneos), ejecútela
**después** de las de solo lectura y vuelva a correr las de lectura al terminar.

## 5 · Probar en la aplicación

Las verificaciones comprueban los **datos** y el **código**. No comprueban que
una pantalla se vea bien ni que un flujo funcione de punta a punta. Para eso está
[`VERIFICACION.md`](VERIFICACION.md), con las pruebas manuales que solo se pueden
hacer usando la aplicación.

---

## Volver a una versión anterior

1. En el repositorio, pestaña **Commits**, abra el commit de la versión que
   quiere recuperar.
2. Abra el archivo y use el portapapeles para copiarlo.
3. Péguelo en Apps Script y publique con «Nueva versión».

El historial de Git es la red de seguridad: ninguna versión publicada se pierde,
siempre que los archivos se suban al repositorio antes de pegarlos.

## Si tuvo que corregir algo a mano en Apps Script

El repositorio es la verdad y Apps Script es una copia de él. Si por una urgencia
editó directamente en el editor, **avise antes de seguir**: hay que comparar los
dos y volver a alinearlos. Si no, se trabaja sobre un código distinto del que
está corriendo, y eso ya pasó dos veces en este proyecto.

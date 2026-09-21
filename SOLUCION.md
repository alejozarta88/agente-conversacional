# Solución

Borrador. Las secciones que dependen del reto asignado están marcadas como
pendientes y no se han rellenado con suposiciones.

## 1. El proceso administrativo

[PENDIENTE: depende del reto asignado]

Qué proceso se automatiza, quién lo hace hoy, qué pasos tiene, qué decisión
concreta toma el agente y qué decisión sigue siendo humana.

## 2. Arquitectura

Cuatro capas, cada una con una sola responsabilidad y verificable por su
cuenta sin las demás.

```
src/tools/   contrato de herramientas y herramientas
src/agente/  ciclo del agente
src/llm/     interfaz de proveedor, proveedor falso, adaptador de OpenAI
src/server.ts  servidor HTTP, sesiones y límites
web/         chat
agent/       system prompt
```

Por qué están separadas, en concreto:

- **El contrato no sabe del ciclo.** `pnpm prueba-contrato` corre sin ciclo,
  sin servidor y sin proveedor. Eso permite cambiar la forma de una
  herramienta sin tocar nada más.
- **El ciclo no conoce ningún proveedor concreto.** `src/agente/ciclo.ts`
  importa únicamente `src/llm/adapter.ts`, que son tipos. Por eso el ciclo
  se prueba entero con un proveedor de guion y sin red.
- **El servidor recibe el adaptador y el registro por inyección.** No los
  construye. Gracias a eso, `pnpm prueba-servidor` levanta el servidor real
  con el proveedor falso dentro.
- **`src/inicio.ts` es el único sitio que lee el entorno y construye el
  adaptador real.** Todo lo demás recibe lo que necesita.

La consecuencia práctica: de los cinco scripts de verificación, **ninguno
necesita clave ni red**. El único que sale a internet es `pnpm humo`, y es
explícito.

## 3. El contrato de herramientas

Cada herramienta es un objeto de tres campos: `description`, `args` —un
esquema zod donde cada campo lleva `.describe()`— y `execute`, que recibe
los argumentos ya validados. El nombre que ve el modelo se arma como
`<archivo>_<export>`.

**`execute` devuelve siempre un string JSON, nunca un objeto**, con el sobre
`{"ok":true,"data":...}` o `{"ok":false,"error":"...","clase":"..."}`. La
razón es el destinatario: lo que sale de una herramienta va a parar a un
mensaje de la conversación que lee el modelo. Si el tipo de retorno fuera un
objeto, cada punto del camino tendría que decidir cómo serializarlo, y esa
decisión acabaría dispersa. Con un string, la forma queda fijada en un único
sitio y el modelo siempre ve la misma estructura.

**`execute` nunca deja escapar una excepción.** No porque el autor de la
herramienta sea disciplinado, sino porque `ejecutar()` la contiene: valida
los argumentos, llama dentro de `try/catch` y traduce cualquier fallo al
mismo sobre. Una herramienta puede lanzar —`laboratorio_explotarAsync` lo
hace a propósito, con una promesa rechazada— y el turno sigue vivo.

Decisión de diseño que merece defenderse: `ejecutar()` además **normaliza el
retorno**. Si una herramienta mal escrita devuelve un objeto, un string que
no es JSON, o un JSON sin el campo `ok`, `ejecutar()` lo convierte en un
sobre de error explícito en vez de dejarlo pasar. El modelo es el consumidor
de ese string y un sobre roto lo envenena en silencio.

## 4. Dos vocabularios en dos capas: `ClaseError` y `DisposicionLlamada`

`ClaseError` vive en `src/tools/contrato.ts` y es una unión cerrada de cinco
valores: `argumentos_invalidos`, `herramienta_desconocida`,
`excepcion_contenida`, `sobre_invalido`, `error_herramienta`. Describe **cómo
falló una herramienta que sí se ejecutó**. Las cuatro primeras las emite
`ejecutar()`; la quinta la emite la herramienta y, si no la declara,
`ejecutar()` la completa.

`DisposicionLlamada` vive en `src/agente/ciclo.ts` y es otra unión cerrada
de tres valores: `ejecutada`, `denegada`, `pendiente`. Describe **qué decidió
la gobernanza**, no cómo fue el fallo.

Por qué separadas: al principio no lo estaban, y una denegación humana se
registraba como `error_herramienta`. Eso es falso — la herramienta no falló,
ni siquiera corrió. Meterlo todo en una unión obligaba a leer el texto del
resumen para distinguir una denegación de un fallo, que es exactamente el
reconocimiento por texto que habíamos eliminado. El contrato clasifica
fallos de herramienta; el ciclo clasifica decisiones. Una llamada denegada o
pendiente lleva `clase: undefined`, porque no hubo fallo que clasificar.

**Alternativa descartada: `ok: boolean | null` en el log**, con `null` para
lo que no llegó a correr. Se descartó porque `ok` es el campo que más se
lee en una línea de log y convertirlo en tres estados obliga a todo lector
—humano o script— a distinguir `false` de `null` para entender qué pasó. Con
`disposicion` como campo aparte, `ok` sigue siendo un booleano y quien
audita mira `disposicion`. El coste asumido: `ok` vale `false` tanto para
una herramienta que reventó como para una denegada y para una pendiente, así
que `ok` por sí solo no distingue, y hay que mirar `disposicion`. Queda
anotado como ambigüedad conocida.

## 5. Confirmar y ejecutar son dos decisiones distintas

El ciclo nunca pregunta ni decide. `ConfiguracionCiclo.requierenConfirmacion`
es una lista de nombres de herramienta que fija el sistema; el modelo no
decide qué entra ahí. Cuando el modelo pide una de esas herramientas,
`ejecutarLote()` corta el turno **sin llamar a `ejecutar()`** y devuelve el
pendiente.

La autorización entra desde fuera, como dato (`DecisionConfirmacion`), y
autoriza **un id de llamada concreto**, no un nombre de herramienta: aprobar
un borrado una vez no deja aprobado el siguiente.

El estado pendiente vive en la sesión del **servidor**, no en el cliente. El
navegador recibe solo el nombre y los argumentos para pintarlos, y al
confirmar manda únicamente `{aprobada, motivo}`. No puede inventarse qué se
ejecuta: solo puede decir sí o no a lo que el servidor ya tenía apuntado.

Las verificaciones lo comprueban **por el efecto, no por el mensaje**: la
herramienta de borrado de laboratorio registra lo que borra en una lista
observable, y las pruebas afirman que esa lista sigue vacía mientras la
confirmación está pendiente o cuando se deniega.

## 6. El invariante del historial

**Todo `tool_call` que emita el modelo tiene exactamente un mensaje de
herramienta con su id: ni cero, ni dos.**

Esto no es estética. Al principio decidimos que una llamada pendiente no
entrara al historial, con el argumento de que todavía no hay respuesta que
darle al modelo. En producción contra OpenAI, el turno siguiente a una
confirmación concedida devolvía un 400:

> An assistant message with 'tool_calls' must be followed by tool messages
> responding to each 'tool_call_id'.

El historial quedaba con un mensaje de asistente pidiendo llamadas y sin la
respuesta correspondiente. La corrección: la pendiente **sí** entra, con un
sobre que dice que espera confirmación, y cuando se resuelve,
`ponerResultado()` **reemplaza ese mensaje en su posición** en vez de añadir
otro — si no, habría dos respuestas para el mismo `tool_call_id`, que es el
error espejo. El mismo arreglo cubrió un segundo agujero que no se había
visto: las llamadas que venían **detrás** de la pendiente en el mismo lote
tampoco recibían mensaje.

La disposición en el log no cambió por esto: una pendiente sigue siendo
`pendiente`. Una confirmación concedida deja dos líneas para el mismo id,
`pendiente` y luego `ejecutada`; se trata como traza de auditoría, no como
duplicado.

Verificado recorriendo el historial, no por inspección visual, después de un
turno pendiente, uno confirmado, uno denegado y el turno posterior.

## 7. Decisiones de herramienta

### pnpm y no npm

Instalación reproducible con `pnpm-lock.yaml` y almacén direccionable por
contenido, que en el Dockerfile permite instalar dos veces —dependencias
completas para compilar, solo producción para la imagen final— sin
descargar dos veces. También detiene por defecto los scripts de ciclo de
vida de las dependencias y obliga a aprobarlos uno a uno; en este proyecto
ninguno se aprobó.

### OpenAI y `gpt-5.4-mini`

El proveedor es OpenAI por decisión del reto. El modelo por defecto es
`gpt-5.4-mini`, y llegar ahí costó un diagnóstico:

- `gpt-5.6-luna` devolvía 400 con *"Function tools with reasoning_effort are
  not supported for gpt-5.6-luna in /v1/chat/completions. To use function
  tools, use /v1/responses or set reasoning_effort to 'none'."*
- El proyecto **no envía** `reasoning_effort` ni ningún parámetro de
  razonamiento: el cuerpo de la petición son `model`, `messages`, `tools` y
  `tool_choice`, y un `grep` sobre todo el código lo confirma. Lo aplicaba
  ese modelo por su cuenta en ese endpoint.
- Se descartó la salida fácil de poner `reasoning_effort: "none"`, porque
  apaga el razonamiento para que funcionen las herramientas. Cambiar a
  `/v1/responses` es otra API y otro formato de traducción: es una decisión,
  no un ajuste, y se dejó fuera.
- `gpt-5.4-mini` funciona con herramientas, verificado con `pnpm humo`.

El adaptador es propio, sobre `fetch` nativo. Sin SDK y sin cliente HTTP.

### Resiliencia del adaptador

Un único sitio decide recuperable contra no recuperable:
`esEstadoRecuperable()`.

| Situación | Clasificación |
| --------- | ------------- |
| 429, 5xx  | Recuperable |
| 400, 401, 403, 404 y el resto de 4xx | No recuperable |
| Timeout de la petición | Recuperable |
| Respuesta ilegible: cuerpo que no es JSON, sin `choices`, sin `message` | No recuperable |

Reintentos con espera creciente, configurables, tres intentos por defecto.
Si la respuesta trae `retry-after-ms` o `retry-after`, se respeta esa espera
en vez de la calculada. Un error no recuperable **no se reintenta**, y está
verificado contando peticiones en un servidor local: el 401 recibe una sola.

Dos relojes distintos que no se sustituyen: timeout **por petición** en el
adaptador (60 s por defecto) y tope de tiempo **por turno** en el ciclo
(120 s por defecto). El segundo corta y responde con lo que tiene, como el
tope de iteraciones, sin lanzar.

Argumentos de herramienta con JSON inválido: la petición viaja con el string
crudo en vez de romper el turno. Es un error de redacción del modelo, no de
transporte; reintentar el HTTP no lo arregla, pero el contrato lo rechaza
con `argumentos_invalidos` y el ciclo se lo devuelve al modelo para que se
corrija.

### La clave

Se lee de `OPENAI_API_KEY` **al construir** el adaptador, no al primer
mensaje del usuario: si falta, falla en el arranque con un mensaje claro. Se
guarda en un campo privado de clase y no aparece en logs, ni en mensajes de
error, ni al serializar el adaptador. Hay una verificación que recoge el
rastro de todos los errores lanzados en las catorce comprobaciones del
adaptador y afirma que la clave no aparece en ninguno.

## 8. Caducidad y expulsión de sesiones

Las sesiones viven en un `Map` en memoria. Sin base de datos y sin
autenticación, que es lo que pide el reto.

Cada sesión guarda su `ultimoUso`. La purga por inactividad —30 minutos por
defecto— se hace **al atender cada petición**, no con `setInterval`: un
temporizador retendría el proceso e impediría que termine limpiamente.
Cuando se llega al tope de sesiones simultáneas, primero se purgan las
caducadas y, si aun así está lleno, **se expulsa la más antigua por
inactividad**.

**Alternativa descartada: rechazar al que llega.** Era lo que había, y era
el riesgo más grave de la auditoría: veinte visitas dejaban el servicio
muerto hasta el siguiente reinicio, porque nada borraba sesiones nunca. En
un servicio público sin autenticación, rechazar al que llega convierte un
tope de gasto en una denegación de servicio trivial. Expulsar a la sesión
más inactiva degrada a quien ya se había ido, no a quien acaba de llegar.

El identificador de sesión lo emite el servidor con `randomUUID()`. Un
`sesionId` que el servidor no emitió se rechaza con 404 y **no crea** una
sesión con el id que traiga el cliente. Antes el cliente lo elegía, y
bastaba acertar un identificador ajeno para leer la conversación de otro.

## 9. La regla que aprendimos dos veces

**Las garantías viven en el código. El texto que lee el modelo no las
repite.**

Nos costó dos incidentes en producción, los dos con la misma forma: una
garantía implementada en el código, duplicada en lenguaje natural, y el
modelo obedeciendo la versión de lenguaje natural.

**Caso 1, el system prompt.** `agent/prompt.md` decía *"Antes de una acción
irreversible o destructiva, pide confirmación explícita a la persona y
espera su respuesta."* Al pedirle un borrado, el modelo **no llamó a la
herramienta**: respondió en texto *"¿confirmas que quieres que lo borre?"* y
se quedó esperando. No hubo tarjeta de llamada, ni bloque de confirmación,
ni botones: el mecanismo del ciclo nunca se activó, porque nunca hubo
`tool_call` que interceptar. La confirmación la intercepta el código antes
de ejecutar; no la negocia el modelo. El prompt reescrito dice lo contrario:
que llame a la herramienta directamente aunque la acción le parezca
delicada, que el sistema tiene su propia barrera, y que no pida él
autorización en texto.

**Caso 2, la descripción de la herramienta.** `laboratorio_borrar` se
describía como *"Borra un recurso por nombre. Acción con efecto
irreversible."* Esa coletilla viaja al modelo dentro de la declaración de la
herramienta y empuja exactamente al mismo comportamiento prudente, aunque el
prompt ya dijera lo correcto. Quedó en *"Borra un recurso por su nombre."*
La descripción dice qué hace la herramienta; la política de qué exige
confirmación vive solo en `requierenConfirmacion`.

El corolario, y la razón de escribir esto aquí: cada vez que una regla
aparece en dos sitios —uno ejecutable y otro en prosa— el de prosa es el que
se va a desincronizar, y el modelo es el que lo va a obedecer.

## 10. Declaración de uso de IA para construir

Este proyecto se construyó con dos herramientas de Anthropic y un reparto
explícito entre ellas. La arquitectura, las decisiones de diseño y los
prompts salieron de una conversación con Claude, en claude.ai; el código del
repositorio lo escribió Claude Code. El reparto fue ese: uno decide el
alcance y produce el prompt con un criterio de aceptación verificable, el
otro escribe el código y lo ejecuta.

El método fue el siguiente, y se describe tal cual fue:

- El trabajo se dividió en piezas con un criterio de aceptación
  **verificable** declarado por adelantado: contrato de herramientas, ciclo
  del agente, adaptador de proveedor, servidor y front, y después una
  auditoría y una tanda de correcciones.
- Cada pieza se pidió con un prompt que fijaba el alcance, lo que **no**
  debía construirse todavía, las reglas —sin `any`, sin dependencias nuevas,
  sin frameworks de testing— y la salida exacta que debía producirse para
  darla por buena.
- Cada pieza se verificó con **scripts propios**, sin framework de testing,
  que imprimen verificaciones numeradas y salen con código distinto de cero
  si alguna falla. El criterio de aceptación no era una opinión sino esa
  salida.
- Las decisiones de diseño se pidieron argumentadas, y varias se corrigieron
  después de discutirlas: la separación de `ClaseError` y
  `DisposicionLlamada`, qué hacer con una llamada pendiente en el historial,
  y si una pendiente se registra en el log.
- Dos fallos llegaron a producción y se diagnosticaron contra la API real
  antes de tocar código: el 400 por historial inválido y el modelo
  negociando la confirmación en texto. En ambos casos el diagnóstico se
  confirmó leyendo el código y citando el fragmento responsable antes de
  corregir.
- Hubo una auditoría de cobertura contra la arquitectura obligatoria, con
  tres estados —cubierto, parcial, falta— y la regla de que sin verificación
  que lo pruebe, no se puede declarar cubierto. Esa auditoría encontró trece
  riesgos; se cerraron cinco y los demás quedaron anotados con su razón.

Lo que la IA no hizo: decidir el alcance, aceptar una pieza, ni dar por
buena una corrección. Cada pieza se aceptó contra una salida concreta y
verificable, y los dos fallos de producción se diagnosticaron leyendo el
código y citando el fragmento responsable antes de corregir.

## 11. Limitaciones conocidas y riesgos abiertos

De la auditoría salieron trece riesgos. Se cerraron cinco: caducidad y
expulsión de sesiones, identificador emitido por el servidor, tope de bytes
del cuerpo y de longitud del mensaje, tope de tiempo por turno, y la
descripción contaminada de la herramienta. Los que siguen abiertos, con la
razón:

| Riesgo | Estado y razón |
| ------ | -------------- |
| El tope por sesión es débil: no hay límite por IP y abrir sesiones es gratis. | Abierto. Con el identificador emitido por el servidor y la expulsión por antigüedad, el coste de abusar sube lo suficiente para una demo. |
| El historial crece sin poda: cada turno reenvía la conversación completa y el tope es de mensajes, no de tokens. | Abierto. No aplica a una demo corta. |
| `out/log.jsonl` no rota y crece sin límite. | Abierto. No aplica a una demo corta. |
| El arranque borra `out/` entero, incluida la traza de la sesión anterior. | Abierto a propósito: es lo que pide el PRD. Auditoría y «`out` es desechable» tiran en direcciones opuestas y aquí gana el PRD. |
| `refusal` de OpenAI se ignora: si el modelo rechaza, el turno devuelve texto vacío sin decir por qué. | Abierto. Es una traducción aparte, no un arreglo. |
| El system prompt se cachea hasta el reinicio. | Abierto. Es el comportamiento correcto en producción; en desarrollo obliga a reiniciar tras editarlo. |
| Sin autenticación. | Es un requisito del reto, no un descuido. Pero cambia de categoría con la URL pública: cualquiera que tenga el enlace consume la clave. |

Además, del despliegue: en el plan gratuito el contenedor se duerme por
inactividad y al despertar **pierde todas las sesiones**, porque viven en
memoria. Es coherente con una demo y conviene saberlo.

Y lo que no está verificado automáticamente: el front no tiene ninguna
prueba —no hay nada que compruebe que las tarjetas o el bloque de
confirmación se pintan—, `pnpm demo` se comprueba a mano, y nada impide que
alguien escriba una herramienta sin `.describe()` en algún campo.

## 12. Las herramientas del dominio

[PENDIENTE: depende del reto asignado]

Hoy el registro son herramientas **provisionales**, marcadas como tales en
`src/tools/ejemplo.ts` y `src/tools/laboratorio.ts`, que existen para
ejercitar el contrato y el ciclo: una que hace eco, una que falla, una que
rechaza una promesa, una con efecto observable y una mal escrita a
propósito. `src/inicio.ts` registra tres de ellas.

Cuando el reto esté asignado, aquí van: qué herramientas existen, qué hace
cada una, qué valida su esquema, y **cuáles entran en
`requierenConfirmacion`**, que es la decisión con más consecuencias de toda
esta lista.

## 13. Coste por caso procesado

[PENDIENTE: depende del reto asignado]

Se mide cuando existan casos reales que procesar. Lo que ya está en su sitio
para medirlo: `out/log.jsonl` registra cada llamada a herramienta con marca
de tiempo, y la respuesta de OpenAI trae el desglose de tokens. Falta
decidir qué es un «caso» y contar unos cuantos de punta a punta.

## 14. Casos de prueba del reto

[PENDIENTE: depende del reto asignado]

Los cinco scripts actuales prueban el mecanismo —contrato, ciclo, adaptador,
servidor—, no el proceso de negocio. Los casos del reto son otra tanda:
entradas reales, salidas esperadas y qué se considera correcto.

## 15. Bonus

[PENDIENTE: depende del reto asignado]

Módulo reutilizable con `agent.md`, herramientas y skill. No está empezado,
y su forma depende de qué expone el reto y para quién.

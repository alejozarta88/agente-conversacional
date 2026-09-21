# Solución — Reto 02: Registro de Contratos Vigentes

Estructura obligatoria del PRD §9.1. Los supuestos que el enunciado no resuelve
están numerados S-1 a S-30 en [SUPUESTOS.md](SUPUESTOS.md) y se citan desde aquí.

---

## 1. Problema en una frase y a quién le duele

Los contratos firmados no llegan a ningún sitio único ni quedan registrados, así
que **no se sabe qué contratos están vigentes, cuáles vencen ni qué pólizas están
por expirar**.

El maestro vive en un Excel en SharePoint **congelado al 2026-05-30**. Los
comerciales envían el contrato a administración **solo si requiere póliza**; el
resto no llega. No hay buzón ni responsable único: llegan a personas distintas
por correo, y los PDF quedan dispersos en correos personales.

A quién le duele, con los actores que el PRD nombra:

- **La analista administrativa**, usuaria principal y dueña del maestro y del
  seguimiento de pólizas. Es quien no puede responder qué hay vigente, y quien
  carga con el trabajo manual de perseguir documentos.
- **La dirección**, que no puede responder *"¿qué contratos vencen este
  trimestre?"*.
- **Gerencia**, que necesita visibilidad de vigencias y riesgo.
- **El comercial**, que hoy no sabe si lo que envió sirvió de algo, porque nadie
  le responde.

Y un dolor que no es de ninguna persona sino del proceso: **murió cuando se fue
quien lo sostenía**. El PRD lo dice así —*"el proceso murió cuando se fue una
persona. Debe sobrevivir a rotación"*— y es lo que justifica que la regla de
gobierno (§6) pese tanto como el agente.

**Área legal no existe internamente y nadie revisa cláusulas.** Conviene tenerlo
presente al leer el resto: la extracción no interpreta, y el riesgo de una
cláusula mal entendida no lo absorbe ningún jurista dentro de la empresa.

El fixture lo hace concreto: `CT-2025-018` venció el 2026-06-30 y `CT-2026-002`
el 2026-07-09. A la fecha de corte de la demo llevan 65 y 56 días vencidos, y
nadie los había mirado.

---

## 2. Arquitectura

```
navegador                    backend                         archivos
──────────                   ───────                         ────────
web/index.html               src/server.ts                   modulo/agent.md
  chat, un archivo    ─────▶   sesiones, límites      ─────▶ modulo/skill/.../SKILL.md
  sin dependencias             prompt + conocimiento
        ▲                            │
        │                            ▼
        │                    src/agente/ciclo.ts
        │                      topes, aprobación humana,
        │                      out/log.jsonl
        │                            │
        │                            ▼
        │                    src/tools/contrato.ts
        │                      validación zod, sobre JSON,
        │                      contención de excepciones
        │                            │
        │                            ▼
        │                    src/tools/contratos.ts           fixtures/reto-02/
        └────────────────────  las cinco herramientas  ◀────▶   buzón, maestro,
                                                                comerciales
                                     │                        out/sharepoint/
                                     └──────────────────────▶   maestro de trabajo,
                                                                Contratos/, historial
                               src/llm/adapter.ts (tipos)
                               src/llm/openai.ts  ──────────▶  API de OpenAI
                               src/llm/falso.ts   (pruebas)
```

### Dónde vive el prompt, el conocimiento y la ejecución

Las tres capas que exige la arquitectura viven en sitios distintos y se cambian
sin tocarse entre sí:

| Capa | Dónde | Qué contiene | Quién la consume |
|---|---|---|---|
| **Comportamiento** | `modulo/agent.md` | Cómo se conduce el agente: qué no inventa, cómo ejecuta una acción, cómo presenta un campo dudoso | El modelo, primer mensaje de sistema |
| **Conocimiento** | `modulo/skill/registro-contratos/SKILL.md` | Las reglas del negocio: RN1–RN7, la escala de confianza, el corte de 0,8, qué exige aprobación | El modelo, segundo mensaje de sistema |
| **Ejecución** | `src/tools/contratos.ts` | El código determinista que aplica esas reglas, sin participación del modelo | El ciclo, a través del contrato |

Los dos primeros son archivos de texto que el servidor **lee de disco** al crear
la sesión, nunca embebidos en el código, y van como **dos mensajes de sistema
separados** —no concatenados— para que cada capa siga siendo identificable en el
historial.

Las reglas viven **dos veces a propósito**: en prosa para el modelo y en código
para la ejecución. El modelo necesita saber qué significa una confianza de 0,6
para explicárselo a una persona; la herramienta necesita aplicarlo sin margen. Si
se contradijeran manda el código, porque el modelo no decide ninguna
clasificación. Esa duplicación tiene un coste real y ya nos mordió: ver §7,
*contradicciones entre el conocimiento y el código*.

### Por qué las capas están separadas

- **El contrato no sabe del ciclo.** `pnpm prueba-contrato` corre sin ciclo, sin
  servidor y sin proveedor.
- **El ciclo no conoce ningún proveedor concreto.** `src/agente/ciclo.ts` importa
  solo `src/llm/adapter.ts`, que son tipos. Por eso el ciclo se prueba entero con
  un proveedor de guion y sin red.
- **El servidor recibe el adaptador y el registro por inyección.** Gracias a eso
  `pnpm prueba-servidor` levanta el servidor real con el proveedor falso dentro.
- **`src/inicio.ts` es el único sitio que lee el entorno** y construye el
  adaptador real. También es donde vive la comprobación de arranque que aborta
  con código 1 si falta un archivo de datos.
- **`src/registro.ts` está aparte de `inicio.ts` para poder verificarlo**:
  `inicio.ts` limpia `out/` y levanta el servidor al importarse, así que no se
  puede inspeccionar sin efectos. El registro sí, y por eso hay una verificación
  que comprueba que `contratos_registrar` —y solo ella— exige aprobación.

Consecuencia práctica: de las cinco suites de verificación, **ninguna necesita
clave ni red**.

---

## 3. Ciclo del agente

`ejecutarTurno` en `src/agente/ciclo.ts`. Un turno es: mandar el historial al
proveedor, ejecutar lo que pida, devolverle el resultado, repetir hasta que
responda texto o se agote un tope.

### Topes

| Tope | Valor | Dónde se mira |
|---|---|---|
| Iteraciones por turno | 25 | Antes de cada envío al proveedor |
| Tiempo por turno | 120 s | Antes de cada envío |
| **Tokens por sesión** | **120 000** | **Antes de cada envío** |
| Mensajes por sesión | 30 | En el servidor, antes del turno |

El de tokens se mira antes de **cada envío** y no solo al empezar el turno,
porque el historial completo se reenvía en cada iteración: un turno de 25
iteraciones cuesta mucho más que el mensaje que lo inició, y mirarlo solo al
principio dejaría pasar justo el caso caro. El conteo sale del `usage` que
devuelve el proveedor —es el número que se factura— y cae a una estimación local
de 4 caracteres por token cuando no viene (S-30). Al agotarse, el turno termina
con `motivoFin: "tope-tokens"` y un aviso legible; no lanza.

### Confirmación humana: dos puertas independientes

La primera está en el ciclo: `contratos_registrar` está en
`requierenConfirmacion`, así que el ciclo **detiene la llamada antes de
ejecutarla**, pase lo que pase en los argumentos. La segunda está en la
herramienta: con campos bajo el corte de 0,8 y `confirmado: false`, no escribe.

**La segunda puerta solo vale por la primera.** `confirmado: true` lo compone el
modelo, así que por sí solo no significa nada: lo que lo hace significar algo es
que el ciclo para y espera a una persona. Sin la línea de `requierenConfirmacion`
toda la guarda sería un diseño y no un hecho, y por eso hay una verificación que
lo comprueba **por el efecto**: un turno donde el modelo pide registrar con
`confirmado: true` termina en `confirmacion`, y el contrato **no está en el
maestro**.

Al aprobar, el modelo **no recompone la llamada**. El ciclo congela el objeto
(`LlamadaPendiente`), muestra esos argumentos exactos y ejecuta ese mismo objeto;
el cliente solo puede enviar un booleano. Y `idsAutorizados` lleva únicamente el
id aprobado, así que seis registros en un lote piden seis aprobaciones, no una.

El bloque que la persona lee va **campo a campo, en prosa**, con los objetos
anidados aplanados por su ruta:

```
Voy a ejecutar "contratos_registrar" con estos datos:

  mensaje_id: "msg-006"
  confirmado: true
  correcciones.valor: 0
  correcciones.fecha_fin: "2027-08-31"

Revisa los valores antes de aprobar: es exactamente esto lo que se ejecutara.
```

Hubo que llegar ahí dos veces: el texto del agente ya estaba en prosa y el bloque
destacado del front seguía volcando JSON, porque **había dos renderizadores** y
la verificación solo cubría uno. Ahora el servidor manda los campos ya aplanados
por la misma función que usa el ciclo: una sola fuente de verdad.

### En espera, denegada y fallida son tres cosas distintas

Una llamada que no corrió trae en su sobre `ejecutada: false` y un `estado`
cerrado: `espera_aprobacion`, `no_alcanzada` o `denegada`. Ver §7.

---

## 4. Elección del modelo

**Proveedor: OpenAI**, por decisión del reto. **Modelo por defecto:
`gpt-5.4-mini`**, y llegar ahí costó un diagnóstico:

- `gpt-5.6-luna` devolvía 400 con *"Function tools with reasoning_effort are not
  supported for gpt-5.6-luna in /v1/chat/completions"*.
- El proyecto **no envía** `reasoning_effort` ni ningún parámetro de
  razonamiento: el cuerpo son `model`, `messages`, `tools` y `tool_choice`, y un
  `grep` sobre todo el código lo confirma. Lo aplicaba ese modelo por su cuenta.
- Se descartó la salida fácil de poner `reasoning_effort: "none"`, porque apaga
  el razonamiento para que funcionen las herramientas. Cambiar a `/v1/responses`
  es otra API y otro formato de traducción: es una decisión, no un ajuste.
- `gpt-5.4-mini` funciona con herramientas, verificado con `pnpm humo`.

El adaptador es propio, sobre `fetch` nativo. Sin SDK y sin cliente HTTP.

### Coste estimado por caso procesado

**Es una estimación calculada, no una medición.** El método y los números
medidos, para que cualquiera la rehaga:

| Componente | Medido | Tokens aprox. (4 car/token) |
|---|---|---|
| `agent/prompt.md` | 5 909 car | 1 477 |
| `knowledge/proceso.md` | 13 117 car | 3 279 |
| Declaraciones de las 5 herramientas | 8 747 car | 2 187 |
| **Contexto fijo por petición** | **27 773 car** | **≈ 6 950** |

Un mensaje del buzón consume como mínimo tres llamadas —extraer, validar,
registrar— más la respuesta final, es decir **cuatro envíos al proveedor**, y el
contexto fijo viaja **en cada uno**. Los resultados de herramienta se acumulan
encima: una extracción completa ronda los 2 000 caracteres.

Estimación por mensaje: **≈ 30 000 tokens de entrada**, dominados por el contexto
fijo reenviado. Los seis del buzón, en una sola conversación con el historial
creciendo, quedan del orden de **200 000 tokens**, por encima del tope de sesión
de 120 000 — que es precisamente el caso que el tope existe para cortar.

**Qué falta para convertirlo en medición:** correr el buzón completo contra la API
real y leer `usage.total_tokens`. La instrumentación ya está —el adaptador lo
traduce y la sesión lo acumula—; lo que falta es la corrida con clave. No se hizo
porque las cinco suites corren sin red a propósito.

---

## 5. Estrategia de extracción

**La extracción es determinista. El modelo no participa en ella.** Regex y
heurísticas cerradas sobre el texto del adjunto.

### Cómo se encuentra cada cosa

- **Partes.** Se ancla en `Entre [los suscritos,] <RAZÓN SOCIAL>, ... NIT|RUC
  <id>` y se toma la **primera**. Los cinco contratos nombran a `PERIFERIA IT
  GROUP S.A.S., NIT 900.123.456-7` como segundo firmante, así que un regex de NIT
  sin anclar captura al contratista y no al cliente (S-7).
- **Valor y moneda.** Dentro de la cláusula rotulada `SEGUNDA. VALOR.`, se busca
  el código ISO junto al monto. El scope importa: el contrato marco tiene
  `COP $100.000.000` en la cláusula de garantías, que es otra magnitud. La
  convención numérica se detecta por la forma del número, no por la moneda:
  `265.000.000`, `120,000.00` y `520,000.00` conviven.
- **Plazo.** De `TERCERA. PLAZO.`, con las fechas en letras y su dígito entre
  paréntesis. **La fecha escrita gana siempre sobre el plazo en meses**; solo se
  deriva cuando no hay fecha de terminación.
- **Póliza.** De la cláusula de garantías. El tipo se mapea a un vocabulario
  cerrado (`cumplimiento`, `calidad`, `salarios_prestaciones`,
  `responsabilidad_civil`) y se une con `;`, como el maestro.
- **País.** Del formato del identificador tributario: NIT de 9 dígitos → CO, RUC
  de 13 terminado en 001 → EC, RUC de 11 empezando por 10/15/17/20 → PE. Si no
  resuelve, cae a la mención textual **limitada al tramo anterior a `PERIFERIA IT
  GROUP`**, porque todos los contratos dicen "Medellín, Colombia" al presentar al
  contratista y ese tramo contaminaría el resultado.

### Cómo se calcula la confianza

Cinco escalones discretos, sin valores intermedios: un 0,73 no le dice nada a
quien revisa y finge una precisión que el regex no tiene. La escala mide **una
sola cosa: cuánto se acerca el valor a lo que el documento dice literalmente.**

| Valor | Significado |
|---|---|
| **1,0** | Literal y unívoco, sin normalización |
| **0,9** | Determinista, respuesta única: literal en cláusula rotulada, o regla cerrada (país por formato del identificador, NIT normalizado, `requiere_poliza: false` por ausencia de cláusula) |
| **0,6** | **Derivado: pudo salir distinto.** `fecha_fin` calculada desde un plazo en meses |
| **0,3** | Presente pero el texto no lo fija: valor por demanda, firma con mes y año sin día |
| **0,0** | Ausente. El valor es `null`. **Nunca se rellena con algo plausible** |

Más dos estados que **no son escalones** de esta escala: `no_aplica` (el tipo de
documento no trae ese campo) y `confirmado` (lo aportó una persona; tiene
proximidad cero al documento, así que el número que lleva solo sirve para cruzar
el corte — lo que informa es el estado, S-20).

**El salto que importa es de 0,9 a 0,6**: 0,9 significa *esto está en el
documento*, 0,6 significa *esto lo calculé yo a partir del documento*. Quien
revisa puede saltarse los 0,9 y debe leer los 0,6.

### El corte de 0,8 se diseñó contra los casos, no al revés

La primera escala ponía en 0,6 el país, el objeto y `requiere_poliza: false` por
ausencia de cláusula. Con el corte en 0,8, eso mandaba a revisión a msg-001 y
msg-002, que el PRD §7.4 exige registrados. El 0,6 estaba mezclando dos cosas
distintas: *"derivé esto y pude equivocarme"* y *"apliqué una regla determinista
con respuesta única"*. Lo segundo no es menos fiable que lo literal, y subió a
0,9. En 0,6 quedó solo lo que pudo salir distinto.

Resultado: los cuatro mensajes que 7.4 quiere registrados no tienen **ni un
campo** bajo 0,8, y msg-006 queda con seis.

### Dónde entra el modelo y dónde no

| | Modelo |
|---|---|
| Leer el texto y sacar los campos | **No** |
| Calcular la confianza | **No** |
| Decidir la clasificación (RN1–RN4) | **No** |
| Comparar contra el maestro | **No** |
| Decidir qué se escribe | **No** |
| Decidir a qué mensaje aplicar cada herramienta | Sí |
| Componer los argumentos de la llamada | Sí |
| Explicarle a la persona qué se encontró y qué falta | Sí |
| Proponer correcciones que una persona aprueba | Sí |

El modelo orquesta y explica. No extrae, no clasifica y no escribe.

---

## 6. Regla de gobierno

El PRD lo dice y conviene repetirlo: **el problema es tanto de proceso como de
automatización**. Un agente que registre perfectamente lo que le llega no sirve
de nada si los contratos no llegan.

**El principio que ordena las seis reglas: cada una dice quién hace qué, en
cuánto tiempo, y qué pasa si no lo hace.** Una regla de gobierno sin consecuencia
es un deseo. La consecuencia dura es que **un contrato no registrado no se
factura**, porque ata el proceso a algo que a la empresa le duele. Sin ese
anclaje, todo lo demás es una recomendación que se incumple en el primer mes.

### 6.1 Canal único

Un buzón con dirección propia, **`contratos@`**, administrado por el área de
contratos. **Un contrato no existe hasta que llega ahí.** Se retira la práctica de
mandarlo al correo personal de alguien de jurídica: lo que llega a una bandeja
personal no es un registro, es un favor.

> **Agujero que cierra:** contratos facturados sin registrar, en su origen.
> **Agente:** lee el buzón y no ve nada fuera de él. **Personas:** el área de
> contratos administra la dirección; dirección comunica el cambio y retira el
> canal viejo.

### 6.2 Obligación del comercial

Enviar el contrato firmado al buzón **dentro de los 3 días hábiles siguientes a
la firma**, con asunto `CONTRATO <cliente> <id>` y el documento adjunto.

> **Agujero que cierra:** contratos facturados sin registrar.
> **Agente:** nada; esto ocurre antes de que exista un correo. **Personas:** el
> comercial envía; su líder responde del cumplimiento del plazo.

### 6.3 Acuse automático

El agente responde al remitente **dentro de la hora** con el resultado:
registrado con su identificador, o qué campos faltan. El comercial se entera de
que llegó y de si sirvió **sin tener que preguntar**.

Es la contrapartida de 6.2: si se le exige un plazo, se le debe una respuesta.
Sin acuse, la obligación se percibe como un buzón sin fondo.

> **Agujero que cierra:** contratos facturados sin registrar, atacando el motivo
> real de que nadie enviara — no saber si servía de algo.
> **Agente:** produce el resultado y el detalle campo por campo. **Personas:**
> falta conectar el envío del acuse; hoy el resultado se ve en el chat (§9).

### 6.4 Excepciones y escalamiento

Lo que queda en revisión y **nadie resuelve en 5 días hábiles escala al líder
comercial**. A los 10, al director. Y la consecuencia dura: **un contrato no
puede facturarse si no está registrado.**

> **Agujero que cierra:** los tres. Un contrato atascado en revisión es a la vez
> uno sin registrar, uno cuya póliza nadie constituyó y uno cuyo vencimiento
> nadie vigila.
> **Agente:** marca qué campos faltan y desde cuándo. **Personas:** deciden sobre
> cada campo; el líder y el director reciben el escalamiento; quien
> emite las facturas aplica el bloqueo.

### 6.5 El hueco de junio a agosto

**Barrido único contra las facturas emitidas en esos meses.** Toda factura sin
contrato en el maestro genera una solicitud al comercial responsable, con plazo
de **10 días hábiles**. Se cierra con **una lista de excepciones aprobada, no con
silencio**: cada caso que no se pueda documentar queda escrito, con nombre y
motivo, y lo aprueba alguien.

Cerrar por silencio es lo que creó el agujero. Una lista de excepciones aprobada
convierte un hueco desconocido en un riesgo acotado.

> **Agujero que cierra:** contratos facturados sin registrar, la parte histórica.
> **Agente:** el reporte de alertas tiene la sección *Registrados desde
> 2026-05-30* para medir el avance; con el fixture da **0**, o sea que el hueco
> sigue entero. **Personas:** quien emite las facturas aporta las del
> periodo; los comerciales responden; alguien aprueba la lista de excepciones.

### 6.6 Indicador mensual

**Porcentaje de contratos registrados dentro de los 3 días hábiles. Meta: 95 %.**
Se reporta junto al **número de contratos facturados sin registrar, que debe ser
cero**.

Dos números y no uno, porque el primero solo mide a quien ya cumple y el segundo
mide el daño. Un 95 % con tres contratos facturados sin registrar es un proceso
que falla donde importa.

> **Agujero que cierra:** los tres, como medición. Es lo que demuestra que el
> proceso vive.
> **Agente:** aporta `fecha_registro` y la fecha del correo, que es de donde sale
> el plazo. **Personas:** gerencia revisa el indicador y actúa sobre la meta.

---

## 7. Decisiones y trade-offs

### 7.1 El comprobante: el flujo es una precondición del código

`contratos_validar` devuelve un **`comprobante`** —un hash corto de la
extracción, la clasificación y la fila del maestro con la que comparó— y
`contratos_registrar` **lo exige y lo recalcula**. El modelo no puede fabricarlo
sin haber llamado a validar.

**El problema que lo produjo:** en una prueba manual el agente llamó a
`leer_buzon`, seis veces a `extraer` y directo a seis `registrar`. Ni una llamada
a validar. No corrompió nada —registrar revalida por dentro—, pero la persona
aprobaba a ciegas: el bloque decía `{mensaje_id: "msg-005"}` sin mencionar que
era una cotización, y el agente no podía narrar nada porque nunca vio la
clasificación.

**Alternativa descartada: reforzar el prompt.** Un prompt no es una garantía.
**Segunda alternativa descartada: rechazar solo si la clasificación es duplicado
o rechazado.** No obliga a validar los casos `nuevo` y `actualizacion`, que es
donde está msg-006 y su campo por campo.

**Efecto secundario que no buscábamos:** cierra una carrera. Si el maestro cambia
entre validar y registrar, el hash deja de coincidir y la escritura se rechaza en
vez de aplicarse sobre un estado que nadie validó.

**Lo que no garantiza:** que el agente *lea* la clasificación. Puede validar,
ignorar la respuesta y pasar el comprobante. Lo que sí garantiza es que exista,
sea actual y esté en el historial visible.

### 7.2 Dos vocabularios en dos capas

`ClaseError` vive en el contrato y describe **cómo falló una herramienta que sí
se ejecutó**: `argumentos_invalidos`, `herramienta_desconocida`,
`excepcion_contenida`, `sobre_invalido`, `error_herramienta`.

`DisposicionLlamada` vive en el ciclo y describe **qué decidió la gobernanza**:
`ejecutada`, `denegada`, `pendiente`.

Al principio no estaban separadas y una denegación humana se registraba como
`error_herramienta`. Eso es falso: la herramienta no falló, ni siquiera corrió.
Meterlo todo en una unión obligaba a leer el texto del resumen para distinguir
una denegación de un fallo, que es exactamente el reconocimiento por texto que
habíamos eliminado.

**Alternativa descartada: `ok: boolean | null` en el log**, con `null` para lo que
no corrió. Se descartó porque `ok` es el campo que más se lee en una línea de log
y convertirlo en tres estados obliga a todo lector a distinguir `false` de `null`.
**Coste asumido:** `ok` vale `false` tanto para una herramienta que reventó como
para una denegada, así que por sí solo no distingue y hay que mirar `disposicion`.

### 7.3 `EstadoNoEjecutada`: el sobre que mentía por omisión

**El fallo real:** se denegó **un** registro, el de msg-001. Los de msg-002 y
msg-003 nunca corrieron, quedaron en cola. El agente reportó que **los tres**
quedaron "con registro denegado".

No fue una invención: fue una lectura razonable. Las tres situaciones producían el
mismo sobre —`{ok: false, error: "<prosa>"}`— y solo se distinguían por el texto.
Un `ok: false` se lee como "esto falló", y una llamada en cola no falló: no llegó
a correr. Además `disposicion` existía, pero viajaba al log y al front y **nunca
llegaba al modelo**.

**La prosa era justo lo que había fallado, así que el arreglo no podía ser una
redacción mejor.** El sobre lleva ahora dos campos cerrados:

```json
{"ok": false, "ejecutada": false, "estado": "no_alcanzada", "error": "..."}
```

`estado` es una unión de tres: `espera_aprobacion` (retenida, sin decisión),
`no_alcanzada` (el turno acabó antes de llegar a ella; nadie decidió nada) y
`denegada` (una persona dijo que no, **a esa llamada concreta**).

### 7.4 `no_aplica` se decide por tipo de documento

Un otrosí no contiene `objeto` ni `fecha_inicio`: su cláusula dice que *"las demás
cláusulas permanecen sin modificación"*. Con RN5 aplicado a los once campos,
msg-003 cae en revisión y nunca se registra, y el `actualizacion` que exige §7.4
se vuelve inalcanzable. Subir la confianza de esos campos sería mentir.

RN5 cuantifica sobre *los campos que ese tipo de documento debe traer*. Se añade
el estado `no_aplica`, excluido de RN5 y distinto de `ausente`, que sí entra.

**La guarda, y es lo que hace que esto no sea una trampa:** la exclusión se decide
por **tipo de documento**, con la lista declarada por adelantado en el código
(`CAMPOS_NO_APLICA`), **nunca campo por campo mirando el texto**. Si se decidiera
caso por caso, `no_aplica` sería la puerta trasera de RN5: cualquier campo
ilegible podría disfrazarse de inaplicable. Hoy la tabla tiene una sola entrada no
vacía: `otrosi → [objeto, fecha_inicio]`.

### 7.5 La segunda llave de RN2 no dispara, y se implementó igual

RN2 admite coincidir por `nit_cliente` más `objeto` con similitud ≥ 0,9. **Medido,
no estimado:**

| | |
|---|---|
| Único par comparable de los fixtures (msg-004 vs CT-2026-012) | **0,352** |
| Dos objetos **sin ninguna relación** | **0,225** |
| Umbral del PRD | **0,900** |
| msg-003 (otrosí) | **no hay par**: su `objeto` es `no_aplica` |

El contrato guarda el objeto en la redacción literal de su cláusula y el maestro
lo guarda resumido. La brecha no es de formato sino de contenido: llegar a 0,90
exige saber que *TI* abrevia *tecnología*. Eso es resumir, y resumir pide al
modelo, prohibido en esta herramienta.

Y el dato que cierra la discusión: **el par real (0,352) apenas se separa de dos
textos sin relación (0,225)**. No hay dónde poner el umbral. Bajarlo no
funcionaría.

**Se implementó igual**, con Dice sobre bigramas de caracteres: el PRD la pide,
es la *segunda* llave —solo se evalúa si `id_contrato` falla—, y el riesgo de
falso positivo está acotado porque exige además `nit_cliente` idéntico.

### 7.6 La regla que aprendimos dos veces

**Las garantías viven en el código. El texto que lee el modelo no las repite.**

Dos veces se intentó resolver con texto algo que era estructural, y las dos
fallaron:

1. El modelo negociaba la confirmación en texto y se quedaba esperando un "sí".
   Se arregló quitando del prompt toda mención a pedir permiso y poniendo la
   barrera en el ciclo.
2. El modelo leyó "queda en espera detrás de X" y lo reportó como denegado. Se
   arregló con un campo cerrado, no con una redacción mejor.

Por eso `modulo/agent.md` **no contiene** las palabras "confirmación", "confirmar"
ni "permiso", y hay una verificación que falla si reaparecen. El prompt describe
que existe una barrera y que no depende de lo que el modelo escriba.

### 7.7 El esquema 7.2 valida la forma de lo que hay

Una lectura literal de 7.2 hace imposible el caso que el propio PRD exige: declara
`moneda` como `COP|USD|PEN|PAB|HNL` y las fechas como `YYYY-MM-DD`, y un contrato
marco por demanda no tiene moneda ni día de firma. Exigir el enum haría que
msg-006 **nunca** pudiera registrarse, cuando §7.4 manda registrarlo y §11 lo da
por registrado.

Criterio: **un valor mal formado rechaza la escritura** (`EUROS`, `31/08/2027`,
`valor` con separadores); **una celda vacía se permite**, salvo en las cinco
columnas que identifican la fila. Vacío no es un dato mal formado: es la ausencia
declarada de un dato, ya marcada y aprobada por una persona.

`objeto` es distinto: 7.2 fija un máximo de 200 caracteres, así que **se recorta**
por palabra entera. No es decisión nuestra, es lo que el esquema pide. El texto
íntegro sigue en la extracción y en el historial (S-29).

### 7.8 Contradicciones entre el conocimiento y el código

La duplicación de reglas en prosa y en código tiene un coste y ya lo pagamos:
`knowledge/proceso.md` decía que RN4 marca el mensaje como procesado cuando el
código había dejado de hacerlo, y el agente se lo habría contado a la analista
**con la autoridad de una regla de sistema**. Se encontraron cinco
contradicciones y se corrigieron todas.

No hay verificación automática que las detecte. Es deuda reconocida (§11).

---

### 7.9 El módulo del bonus no puede divergir, por construcción

El PRD §9.4 evalúa que las tres piezas de `modulo/` sean **las mismas** que usa la
aplicación, no copias que se separen. Tres formas de conseguirlo, y la más fácil
es la peor:

- **Copiar y verificar que no divergen.** Descartada. Detecta la divergencia
  *después* de que ocurra, y solo si alguien corre la verificación. Es una alarma
  de humo, no un muro cortafuegos.
- **Que el módulo sea el original y la aplicación lo consuma desde ahí.** Elegida
  para los dos Markdown: `modulo/agent.md` y
  `modulo/skill/registro-contratos/SKILL.md` **son** los archivos, y el servidor
  los lee de ahí. Un Markdown no se puede reexportar, así que la única garantía
  posible es que exista **un solo archivo**. Costó mover el prompt y el
  conocimiento y repuntar servidor, arranque, Dockerfile y verificaciones — el
  módulo no se adaptó a la aplicación, la aplicación se adaptó al módulo.
- **Reexportar.** Elegida para el código: `modulo/tools/contratos.ts` no tiene
  contenido propio, son 17 líneas de reexportación. **No puede divergir porque no
  hay nada de qué divergir.** Mover el original habría obligado a cambiar
  `rootDir` y la ruta del `CMD` del Dockerfile sin ganar nada.

Los Markdown llevan el frontmatter que el PRD exige, y el servidor **lo quita**
antes de inyectarlos: es metadato del archivo, no instrucción para el modelo.
Meter `permission: {edit: deny}` en un mensaje de sistema solo puede confundirlo
sobre lo que puede hacer. Hay una verificación que falla si el frontmatter llega
al modelo, y otra que falla si desaparece del archivo.

**Lo que el bonus descubrió, y es un hallazgo real:** las herramientas resuelven
las rutas de datos contra el directorio de trabajo del proceso, así que quien
importe el módulo tiene que correr desde una raíz que contenga
`fixtures/reto-02/`. Es exactamente el hueco de §11.1 — el `ctx { directory }`
que declara el PRD en 6.2 y no está implementado — y el módulo lo vuelve visible
en vez de teórico. Queda anotado en la cabecera de `modulo/tools/contratos.ts`.

## 8. Supuestos al interpretar el PRD

Treinta, numerados y con su porqué en [SUPUESTOS.md](SUPUESTOS.md). Los que más
condicionan el resultado:

| # | Supuesto |
|---|---|
| **S-1** | El paréntesis de §7.4 *"(valor, fecha_fin)"* nombra el síntoma visible, no una lista cerrada. **Hallazgo:** la fecha que §11 hace confirmar, 2027-08-31, es la del correo (2026-08-31) más doce meses — el autor del PRD asumió que la firma es el correo, sin decirlo en ninguna regla. |
| **S-3** | `no_aplica` decidido por tipo de documento (§7.4 de este documento). |
| **S-9** | La segunda llave de RN2 se implementa aunque no alcance el umbral (§7.5). |
| **S-13** | El año de archivo se resuelve por cadena de precedencia. En msg-006 el año no falta, falta el día: la cláusula de firma dice 2026. La ruta es un *lugar*, la columna es un *dato*, y no merecen el mismo estándar de prueba. |
| **S-15** | La columna `comercial` lleva el email cuando el remitente no resuelve. **Coste aceptado:** la columna mezcla dos tipos de identificador y un reporte agrupado por comercial tendrá un grupo que no es una persona. |
| **S-16** | Idempotencia: la segunda llamada es un no-op con `ok: true`. Sin válvula de reproceso. |
| **S-21** | Se registra aunque queden campos sin corregir. Exigir un valor para cada uno obligaría a inventarlo, que es peor que dejarlo vacío. |
| **S-28** | Duplicado y rechazado no escriben nada. **Consecuencia:** ambos reaparecen en cada lectura del buzón. |

---

## 9. Cobertura

| Historia | Estado | Qué falta para producción |
|---|---|---|
| **HU-1** Leer el buzón | **Hecho** | Conectar a un buzón real (IMAP/Graph) en vez de un directorio |
| **HU-2** Extraer los datos | **Hecho** | Leer PDF: hoy solo texto plano. El escalón 0,6 no lo ejercita ningún fixture (S-5) |
| **HU-3** Validar y clasificar | **Hecho** | La segunda llave de RN2 no dispara con datos reales (§7.5) |
| **HU-4** Registrar y archivar | **Hecho** | `ruta_sharepoint` es una sola columna: un otrosí sobrescribe el puntero al contrato original (S-18). Escribir en SharePoint de verdad |
| **HU-5** Alertar | **Hecho** | Enviar el reporte a alguien; hoy se escribe en `out/alertas.md` |
| **HU-6** Manejo de errores | **Hecho** | — |

**Bonus §9.4 entregado.** `modulo/` contiene las tres piezas y **no son copias**:
`agent.md` y `skill/registro-contratos/SKILL.md` son los **originales** —la
aplicación los lee de ahí— y `tools/contratos.ts` es una **reexportación sin
contenido propio**. Ver §7.9. `pnpm prueba-modulo` lo importa como lo haría
alguien de fuera y ejecuta herramientas: 8 verificaciones.

### Verificación

**117 verificaciones**, ninguna necesita clave ni red:

| Suite | Cuántas |
|---|---|
| `pnpm prueba-contrato` | 5 |
| `pnpm prueba-ciclo` | 17 |
| `pnpm prueba-adaptador` | 14 |
| `pnpm prueba-servidor` | 19 |
| `pnpm prueba-contratos` | 54 |
| `pnpm prueba-modulo` | 8 |

`pnpm prueba` las corre todas más el typecheck. Las que sostienen los invariantes
centrales: el fixture idéntico por huella antes y después de toda la suite; el
árbol del proyecto intacto tras el flujo completo, que demuestra que **solo se
escribe en `out/`**; y el registro retenido verificado **por el efecto**, no por
la marca.

---

## 10. Uso de IA

Dos herramientas de Anthropic con un reparto explícito: **la arquitectura, las
decisiones de diseño y los prompts salieron de una conversación con Claude en
claude.ai; el código del repositorio lo escribió Claude Code.** Uno decide el
alcance y produce el prompt con un criterio de aceptación verificable, el otro
escribe el código y lo ejecuta.

El método, tal cual fue:

- El trabajo se dividió en piezas con un criterio de aceptación **verificable**
  declarado por adelantado.
- Cada pieza se pidió con un prompt que fijaba el alcance, lo que **no** debía
  construirse todavía, las reglas —sin `any`, sin dependencias nuevas, sin
  frameworks de testing— y la salida exacta que debía producirse.
- Cada pieza se verificó con **scripts propios** que imprimen verificaciones
  numeradas y salen con código distinto de cero si alguna falla. El criterio de
  aceptación no era una opinión sino esa salida.
- Las decisiones se pidieron argumentadas, y varias se corrigieron tras
  discutirlas.

### Qué se descartó de lo que la IA propuso, y por qué

- **Registrar una denegación humana como `error_herramienta`.** Falso: la
  herramienta no falló. Produjo la separación de los dos vocabularios (§7.2).
- **Poner `reasoning_effort: "none"`** para que `gpt-5.6-luna` aceptara
  herramientas. Apaga el razonamiento para que funcione otra cosa.
- **Normalizar el objeto para alcanzar el umbral de 0,9.** Subía de 0,352 a 0,509
  y seguía a un factor de 1,8×. Cualquier normalización que llegara a 0,90 estaría
  escrita mirando ese par concreto: no sería una regla, sería un ajuste al fixture.
- **Marcar `requiere_poliza: false` en el contrato marco.** Lo habría sacado del
  reporte de alertas, y el proyecto existe porque hay pólizas exigidas que nadie
  constituye.
- **Copiar `src/knowledge/` a `dist/knowledge/`** para arreglar el despliegue.
  Tapaba el síntoma dejando la trampa puesta: un `.md` bajo un directorio que se
  compila desaparece en silencio. Se movió fuera de `src/`.
- **Confiar en una escala de confianza continua.** Un 0,73 finge precisión.

Lo que la IA no hizo: decidir el alcance, aceptar una pieza, ni dar por buena una
corrección. Los fallos de producción se diagnosticaron leyendo el código y citando
el fragmento responsable antes de corregir.

---

## 11. Riesgos y deuda técnica reconocida

### 11.1 `ctx { directory, sessionId }` declarado y no implementado

El bloque normativo de §6.2 declara `execute(args, ctx)` con
`ctx = { directory, sessionId }` y el comentario *"resuelve rutas desde aquí,
nunca absolutas"*. **No está implementado**: las herramientas resuelven contra
`process.cwd()`.

**Medido antes de decidir:** 8 archivos, incluido `src/tools/contrato.ts` —el
cimiento—, 13 firmas `execute`, 10 llamadas a `ejecutar()` y 9 constantes de ruta
usadas en **43 sitios**.

**Por qué no se hizo la víspera de la entrega:** es mecánico y extenso sobre la
base, con 117 verificaciones colgando. El riesgo funcional real es bajo —
`inicio.ts` garantiza que el directorio de trabajo coincide con la raíz y la
comprobación de arranque lo verifica—; lo que falta es cumplimiento del contrato
declarado, no corrección. **Mitigación:** hacerlo como tarea propia, con las
suites en verde antes y después.

### 11.2 `contratos.ts` con 3 277 líneas

Un solo archivo, **3 277 líneas**, con responsabilidades sin separar: extracción, validación,
registro, alertas, esquema del maestro y las cinco herramientas. Debería ser al
menos cinco módulos. **Por qué sigue así:** dividirlo la víspera es el tipo de
cambio que rompe algo sin que nadie lo vea. **Mitigación:** las suites permiten
dividirlo después con red.

### 11.3 `FilaMaestro` es `Record<string, string>`

El compilador no protege nada: un error de tipeo en el nombre de una columna
compila y devuelve `undefined`. **Mitigación parcial ya puesta:**
`validarFilaContraEsquema` valida contra el esquema 7.2 antes de escribir, así que
un error de columna se detecta en ejecución. **Falta:** un tipo con las dieciséis
columnas declaradas.

### 11.4 Listas paralelas de campos sin protección del compilador

`NOMBRES_CAMPO`, `COLUMNAS_MAESTRO`, `CAMPOS_IDENTIDAD`, `CAMPOS_MODIFICABLES`,
`ESQUEMA_POR_CAMPO` y `CAMPOS_NO_APLICA` describen el mismo dominio en seis
listas. Añadir un campo exige tocarlas todas y **nada obliga a ello**. Un campo
nuevo que se olvide en `ESQUEMA_POR_CAMPO` no sería corregible; olvidado en
`CAMPOS_IDENTIDAD` no generaría conflicto. **Mitigación:** derivarlas de una sola
declaración por campo.

### 11.5 Lo que las pruebas no cubren

- **El front se verifica a mano.** Hay una red de regresión estática que hace grep
  sobre `web/index.html`; su título dice `[estatica, no prueba el render]` para
  que nadie lea el marcador y crea que el front está verificado.
- **Ninguna suite llama a la API real.** El coste por caso es una estimación
  calculada, no una medición (§4).
- **No hay verificación de coherencia entre `knowledge/proceso.md` y el código.**
  Las cinco contradicciones de §7.8 se encontraron leyendo.
- **El escalón 0,6 no lo ejercita ningún fixture** (S-5). Sí se verifica la regla
  de precedencia que lo evita.

### 11.6 Riesgos abiertos de la auditoría, con su razón

- **Duplicado y rechazado reaparecen en el buzón** (S-17, S-28). En un buzón real
  los rechazos se acumularían. **Razón para no cerrarlo:** la salida no es
  devolverle el efecto lateral a `registrar` sino una herramienta aparte que
  archive la decisión, y no está en el PRD.
- **Un otrosí sobrescribe el puntero al documento original** (S-18). La fila tiene
  una sola columna `ruta_sharepoint`. **Razón:** arreglarlo exige cambiar el
  formato de ruta que fija HU-4.
- **El humano aprueba leyendo** (S-22). El bloque va campo a campo, pero un clic
  distraído deja pasar un dígito cambiado. **Mitigación puesta:** el valor queda
  **atribuible** —`estado: "confirmado"`, procedencia `humano`, valor exacto en el
  historial— en vez de ser indistinguible de una lectura del documento.
- **`out/` no se limpia entre sesiones concurrentes.** El maestro de trabajo es
  uno solo: dos personas registrando a la vez pisarían la misma copia. El
  comprobante detecta el estado cambiado y rechaza, así que no corrompe, pero
  tampoco coordina. **Razón:** el reto es de un solo operador.
- **Sesiones en memoria.** Un reinicio las pierde. **Razón:** aceptable para una
  demo; en producción haría falta almacenamiento externo.

### 11.7 Riesgos de llevarlo a producción

| Riesgo | Mitigación |
|---|---|
| Contratos en PDF, no en texto plano | `contratos_leer_pdf` está declarada como P1 opcional en §6.2 y no se construyó. La extracción no cambia: cambia de dónde sale el texto |
| Documentos con redacción distinta a la de los fixtures | La extracción es determinista y está afinada a cláusulas ordinales rotuladas. Un contrato con otra estructura caería a confianza 0 en varios campos — que es el comportamiento correcto: se marca, no se inventa |
| El modelo deja de estar disponible o cambia de contrato | El adaptador está detrás de una interfaz de tipos; cambiar de proveedor es escribir otro adaptador |
| Gasto descontrolado | Topes de iteraciones, tiempo, mensajes y tokens, todos en un solo sitio |
| Alguien confía en el maestro sin mirar `requiere_revision` | El reporte de alertas lista lo pendiente, y la fila registra la procedencia de cada campo |

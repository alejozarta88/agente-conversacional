# Supuestos

Material suelto para la sección de supuestos de `SOLUCION.md` (PRD §10 y §9.1).
Cada entrada dice qué decidí, qué dice el PRD, y por qué elegí así.

---

## S-1 · El paréntesis de 7.4 nombra el síntoma, no una lista cerrada

**Qué dice el PRD.** La tabla 7.4 describe `msg-006` como
*"`nuevo` con `requiere_revision` (valor, fecha_fin). No se registra hasta confirmar."*

**Qué hace la implementación.** `msg-006` sale con **seis** campos bajo el corte de
RN5: `valor`, `moneda`, `fecha_inicio`, `fecha_fin`, `requiere_poliza` y
`tipo_poliza`.

**Supuesto.** El paréntesis de 7.4 enumera el síntoma visible del caso —el valor por
demanda y el plazo en meses— y no la lista exhaustiva de campos que quedan bajo 0.8.
El veredicto que 7.4 fija (`nuevo`, `requiere_revision`, no se registra sin confirmar)
se cumple exactamente; lo que difiere es cuántos campos se le muestran al humano.

**Confirmación de lo anterior en §11 del PRD.** El prompt de demo dice que tras
*"confirmo el valor 0 y la fecha fin **2027-08-31**"*, msg-006 queda registrado. Esa
fecha no es arbitraria:

```
plazo del contrato ......... doce (12) meses desde la firma
fecha del correo ........... 2026-08-31T17:50:00-05:00
2026-08-31 + 12 meses ...... 2027-08-31   ← la fecha que el PRD hace confirmar
```

Es decir: **el autor del PRD asumió que la fecha de firma es la del correo.** Esto
cambia el estatus de este supuesto. No es una preferencia nuestra sobre cómo tratar
una fecha incompleta: es que el enunciado, en su propio ejemplo resuelto, trata la
fecha del correo como la de firma sin decirlo en ninguna regla. Nuestra decisión de
no escribir `2026-08-31` en `fecha_inicio` sigue en pie —el humano confirmó `fecha_fin`,
no `fecha_inicio`, y un dato inventado en el maestro alimenta las alertas de HU-5—,
pero la discrepancia queda documentada como lectura del enunciado, no como criterio
propio. También explica por qué `fecha_inicio` era el campo en disputa: el PRD lo
había resuelto por su cuenta, en silencio.

**Por qué.** Los cuatro campos de más son consecuencia mecánica de lo que el
documento sí dice, y bajarlos exigiría inventar datos:

- **`fecha_inicio` (0.3).** El contrato marco dice *"doce (12) meses contados a partir
  de la fecha de su firma"*, y la firma dice *"Se firma en Barranquilla, en el mes de
  agosto de 2026"* — sin día. No se asume el día 1 ni se toma la fecha del correo
  (2026-08-31): ambas serían inferencias a un valor plausible, prohibidas por el
  contrato de la herramienta. Además hay una razón de consistencia causal:
  `fecha_fin = fecha_inicio + 12 meses`. Es imposible que la terminación sea incierta
  y el inicio cierto, porque la incertidumbre del fin *proviene* del inicio. Marcar
  solo `fecha_fin` sería señalar el efecto y esconder la causa.
- **`moneda` (0.0, ausente).** El contrato no fija valor, luego no declara moneda para
  él. El único `COP` del documento está en el umbral de la cláusula de garantías
  (`COP $100.000.000`), que es otra magnitud. Heredarla de ahí, o del país del
  cliente, sería inventar.
- **`requiere_poliza` y `tipo_poliza` (0.3).** Ver S-2.

---

## S-2 · La póliza condicional del contrato marco vale 0.3, no `false`

**Qué dice el documento.** *"CUARTA. GARANTÍAS. Para cada orden de servicio cuyo valor
supere los cien millones de pesos (COP $100.000.000), EL CONTRATISTA constituirá
póliza de cumplimiento por el diez por ciento (10%) de su valor."*

**Supuesto.** La cláusula existe pero condiciona la póliza a órdenes de servicio
futuras, no al contrato que se firma hoy. Eso encaja en la definición del escalón
0.3: *presente pero el texto no lo fija*. El valor extraído se deja en `true`, no en
`false`.

**Por qué no `false`.** Marcarlo `false` con confianza alta lo sacaría de RN5 y
además lo sacaría del reporte de alertas — y el proyecto existe precisamente porque
hay pólizas exigidas que nadie constituye. Un humano tiene que leer esa cláusula. La
condicionalidad queda escrita en el campo `nota` de la extracción, no se pierde.

---

## S-3 · `no_aplica` se decide por tipo de documento, nunca campo por campo

**Qué dice el PRD.** RN5: *"Campos con confianza < 0.8 → `requiere_revision`."* 7.4
espera que `msg-003` (otrosí) termine en `actualizacion`, con fila modificada e
historial — es decir, registrado.

**El conflicto.** Un otrosí no contiene `objeto` ni `fecha_inicio`: su cláusula
TERCERA dice que *"las demás cláusulas del contrato permanecen sin modificación"*.
Con RN5 aplicado a los once campos, `msg-003` cae en `requiere_revision` y nunca se
registra, y 7.4 se vuelve inalcanzable. Subir la confianza de esos campos sería
mentir sobre un dato que no existe en el documento.

**Supuesto.** RN5 cuantifica sobre *los campos que ese tipo de documento debe traer*,
no sobre los once. Se añade un estado `no_aplica`, excluido de RN5, distinto de
`ausente` (que sí entra).

**Guarda.** La exclusión se decide por **tipo de documento**, con la lista de campos
declarada por adelantado en el código (`CAMPOS_NO_APLICA` en
`src/tools/contratos.ts`), nunca campo por campo mirando el texto. Si se decidiera
caso por caso, `no_aplica` sería la puerta trasera de RN5: cualquier campo ilegible
podría disfrazarse de inaplicable. Hoy la tabla tiene una sola entrada no vacía:
`otrosi → [objeto, fecha_inicio]`.

**Efecto colateral deseable.** Es justo lo que RN2 necesita para *actualizar* la fila
en vez de reemplazarla: los campos `no_aplica` se dejan intactos en el maestro.

---

## S-4 · `objeto` se extrae literal, sin resumir

El maestro guarda objetos cortos (*"Mesa de servicio TI nivel 1 y 2"*); el contrato
trae la cláusula completa en prosa. Resumirla sería paráfrasis, y en esta herramienta
el modelo no participa. Se extrae el texto literal de la cláusula `OBJETO`.

**Consecuencia para RN2.** La segunda llave de RN2 (*"mismo `nit_cliente` + `objeto`
con similitud ≥ 0.9"*) no alcanza el umbral contra el maestro. Medido, no estimado:
ver S-9.

**Consecuencia para `validar`.** `objeto` queda fuera tanto de los campos de identidad
como de los modificables al comparar contra el maestro. Si se comparara, cada
duplicado legítimo levantaría un conflicto falso, porque el texto literal y el resumen
nunca son iguales.

---

## S-9 · La segunda llave de RN2 se implementa aunque no alcance el umbral

**Qué dice el PRD.** RN2: *"mismo `id_contrato` (o mismo `nit_cliente` + `objeto` con
similitud ≥ 0.9)"*.

**Los datos.** Sobre los fixtures solo existe **un** par comparable, `msg-004` contra
su fila `CT-2026-012`:

| | |
|---|---|
| extraído (138 car) | `EL CONTRATISTA prestará el servicio de mesa de servicio de tecnología en niveles 1 y 2 para los usuarios del CONTRATANTE, en horario 7x24.` |
| maestro (31 car) | `Mesa de servicio TI nivel 1 y 2` |
| Jaccard sobre tokens | **0.286** |
| Dice sobre bigramas | **0.352** |
| Levenshtein normalizado | **0.228** |
| umbral del PRD | **0.900** |

`msg-003` no da par: es un otrosí, y su `objeto` es `no_aplica` (S-3). Es decir, la
segunda llave es **estructuralmente inaplicable a los otrosíes**, que son justamente
el caso para el que RN2 existe. `msg-001`, `msg-002` y `msg-006` no tienen fila en el
maestro.

**Se descartó normalizar para cerrar la brecha.** Quitando el preámbulo de sujeto
contractual (`EL CONTRATISTA prestará…`), el artículo inicial y la cola `para los
usuarios del CONTRATANTE`, Dice sube de 0.352 a **0.509** y Jaccard de 0.286 a 0.429.
Sigue a un factor de 1.8× del umbral. La distancia que queda no es de formato sino de
contenido: llegar a 0.90 exige saber que *TI* abrevia *tecnología*, y descartar *"en
horario 7x24"*. Eso es resumir, y resumir pide al modelo, prohibido por contrato en
estas herramientas. Cualquier normalización que alcanzara 0.90 sobre este par estaría
escrita mirando este par: sería un ajuste al fixture, no una regla.

**Decisión.** Se implementa la segunda llave (coeficiente de Dice sobre bigramas de
caracteres, determinista y sin dependencias), aceptando que en estos fixtures no
dispara. Razones: el PRD la pide y omitirla dejaría RN2 a medias; es la *segunda*
llave, evaluada solo cuando `id_contrato` falla, así que no puede alterar ningún caso
que hoy funciona; y el riesgo de falso positivo está acotado por la conjunción, porque
exige además `nit_cliente` idéntico.

Sí se normalizan mayúsculas, tildes y puntuación antes de medir, porque sin eso la
métrica no está bien definida. Eso no pretende cerrar la brecha semántica.

**Para producción.** El umbral de 0.90 es hoy inalcanzable con texto literal contra
texto resumido. Quien conecte un maestro real debe elegir: guardar el objeto literal
en el maestro, o bajar el umbral con datos que lo justifiquen. No se bajó aquí porque
no hay evidencia sobre la que calibrarlo: un solo par.

---

## S-10 · Qué cuenta como conflicto con el maestro, y qué cuenta como cambio

El PRD pide que `requiere_revision` incluya *"los conflictos con el maestro"* pero no
define conflicto. En un `actualizacion` las diferencias son el objetivo, no un
problema, así que no pueden tratarse igual.

- **Campos de identidad** — `cliente`, `nit_cliente`, `pais`, `moneda`. No deberían
  cambiar nunca para un mismo `id_contrato`. Si difieren es que o la extracción se
  equivocó o la fila del maestro está mal: **conflicto**, entra en
  `requiere_revision` aunque el campo venga con confianza 1.0.
- **Campos modificables** — `valor`, `fecha_inicio`, `fecha_fin`, `requiere_poliza`,
  `tipo_poliza`. Sus diferencias son **cambios**: se reportan en `cambios[]` con el
  antes y el después, y no bloquean. Es lo que un otrosí produce por diseño.
- **`objeto`** — fuera de ambas listas, por S-4.

Un campo `no_aplica` no se compara: el maestro conserva lo que ya tenía.

**Los fixtures no contienen ningún conflicto real** — los campos de identidad de
`msg-003` y `msg-004` casan con su fila. La verificación correspondiente construye el
caso alterando en memoria una copia de la fila real `CT-2026-012` (`moneda` COP→USD);
el CSV en disco no se toca.

---

## S-11 · El remitente desconocido se reporta y no bloquea

`contratos_validar` resuelve el comercial contra `comerciales.json` por email, sin
distinguir mayúsculas. `jperez@periferia-ficticia.com` (msg-006) no está en la lista:
sale como `{ conocido: false, nombre: null, region: null }` y genera una entrada en
`avisos[]`.

No entra en `requiere_revision` y no altera el veredicto: la clasificación depende del
documento, no de quién lo envía. msg-006 sigue saliendo `nuevo`. Inventarle un nombre
o dejar el campo en blanco sin avisar serían las dos formas de perder el dato. El
tratamiento del remitente no registrado como alerta es HU-5, fuera del alcance de esta
herramienta.

---

## S-12 · `contratos_validar` lee el maestro pero no lo copia

El maestro se lee de `out/sharepoint/maestro-contratos.csv` si existe, y del fixture
si no. RN6 dice que *"la primera ejecución lo copia a `out/sharepoint/`"*, pero esa
copia es una escritura y corresponde a `contratos_registrar`. `validar` es de solo
lectura: mientras nadie haya copiado nada, lee el fixture y lo deja intacto. El campo
`fuente_maestro` de la respuesta dice de dónde leyó.

---

## S-13 · El año de archivo se resuelve por cadena de precedencia, y se dice cuál se usó

La ruta de archivo exige `<año_inicio>`, y `msg-006` no tiene `fecha_inicio`: el
contrato se firmó *"en el mes de agosto de 2026"*, sin día. Confirmar `valor` y
`fecha_fin` —lo único que el PRD hace confirmar en §11— no crea esa fecha.

**Pero el año no falta; falta el día.** Hay tres testigos concordantes de 2026: la
cláusula de firma dice el año, `fecha_fin` menos el plazo da 2026, y el correo es de
2026-08-31.

**Cadena de precedencia**, se detiene en el primer eslabón que resuelve:

| # | origen | qué usa |
|---|---|---|
| 1 | `fecha_inicio` | el año de la fecha extraída o confirmada |
| 2 | `clausula_firma` | el año escrito en la cláusula de firma ← **resuelve msg-006** |
| 3 | `fecha_fin_menos_plazo` | terminación menos el plazo en meses |
| 4 | `fecha_correo` | el año del correo |
| 5 | `sin_anio` | carpeta `sin-anio`, visible como pendiente |

**El argumento.** La ruta es un **lugar de archivo**; la columna es un **dato**. Un
archivo en la carpeta equivocada se mueve y no le miente a nadie por el camino; una
`fecha_inicio` inventada en el maestro se propaga en silencio a HU-5 y nadie vuelve a
cuestionarla. Por eso se acepta para la ruta una evidencia —el año de la cláusula de
firma— que no basta para rellenar la columna. `fecha_inicio` queda **vacía** en la
fila de `CM-2026-03`, y el archivo vive bajo `Contratos/2026/`.

El eslabón usado viaja en la **respuesta de la herramienta**, no solo en el historial:
`archivado: { anio, origen, explicacion }`, con la explicación redactada para leerse
en el chat (*"archivado bajo 2026 por la clausula de firma: el documento no trae el
dia, pero si el anio"*). Quien mire la conversación sabe por qué está donde está sin
abrir `historial.jsonl`.

---

## S-14 · `estado_poliza` en una actualización baja a `pendiente` si cambian valor o plazo

En un alta: `pendiente` si el contrato exige póliza, `no_aplica` si no.

En una actualización se conserva lo que el maestro tuviera, **salvo** que cambien
`valor` o `fecha_fin` en un contrato con `requiere_poliza = true`: entonces baja a
`pendiente`.

**Por qué.** Una póliza se expide por un monto y una vigencia concretos. Si cualquiera
de los dos cambia, la póliza existente ya no cubre el contrato, y dejarla en `vigente`
sería una afirmación falsa que además **apaga la alerta de HU-5**, cuya segunda
sección es precisamente `requiere_poliza = true` con `estado_poliza != vigente`. Es el
mismo principio que S-2.

`msg-003` lo dispara: cambia `valor` (350000→520000) y `fecha_fin`
(2027-05-01→2027-11-01) sobre `CT-2026-011`, que estaba en `vigente`. Y el propio
otrosí lo pide por escrito: *"las garantías […] deberán ampliarse en vigencia conforme
al nuevo plazo"*. El documento exige explícitamente lo que la regla deduce.

---

## S-15 · La columna `comercial` mezcla dos tipos de identificador — trade-off aceptado

Cuando el remitente no resuelve contra `comerciales.json`, la columna `comercial`
lleva el **email** (`jperez@periferia-ficticia.com`), nunca un nombre inventado.

**Alternativa descartada: dejarla vacía.** Se descartó porque tira a la basura la
única traza de quién envió el contrato, y porque una celda vacía es indistinguible de
un fallo del proceso: nadie sabe si el comercial no existe o si el registro se rompió.

**El coste, escrito.** La columna pasa a contener **dos tipos de identificador**:
nombres de persona (`Laura Gómez Restrepo`) y direcciones de correo
(`jperez@periferia-ficticia.com`). Un reporte que agrupe por `comercial` tendrá, por
tanto, un grupo que no es una persona sino un buzón sin resolver, y un recuento de
"contratos por comercial" saldrá inflado en número de grupos. Quien construya ese
reporte debe tratarlo como caso aparte.

Se mitiga en dos sitios: la respuesta de la herramienta lleva
`comercial_resuelto: false`, de modo que la distinción es legible por máquina sin
inspeccionar si la celda tiene una arroba; y el sobre devuelve un `aviso` explícito.

**Pendiente para HU-5.** `contratos_alertas`, cuando se construya, **debe listar los
remitentes no resueltos**, como sección propia o dentro del reporte. Sin eso, el email
en la columna documenta el hueco pero nadie lo cierra: queda registrado y nunca
accionado, que es la forma más silenciosa de perder un dato.

---

## S-16 · Idempotencia: la segunda llamada es un no-op con `ok: true`

`contratos_registrar` consulta `out/procesados.json` antes de escribir. Si el
`mensaje_id` ya está, no escribe nada y devuelve `{ accion: "ya_procesado" }` con
`ok: true`.

**`ok: true` y no un error**, porque la postcondición que el llamante quería —este
mensaje está registrado— se cumple. Un agente que reintenta tras un timeout no debe
recibir un fallo y ponerse a compensar algo que ya está bien.

**La llave es `mensaje_id`, no `id_contrato`**: dos mensajes distintos pueden tocar
legítimamente el mismo contrato (msg-003 es un otrosí sobre una fila que ya existe),
así que deduplicar por contrato rompería RN2.

**Sin válvula de escape.** No hay `reprocesar: true`. De los cuatro pasos, tres son
naturalmente idempotentes —la fila está indexada por `id_contrato` y la copia del
adjunto va siempre a la misma ruta—; el que no lo es es `historial.jsonl`, que es
append-only y quedaría con dos líneas donde hubo un registro. Si una fila quedó mal,
el camino correcto no es re-registrar el mismo correo sino que entre un documento
nuevo —un otrosí, una corrección— y fluya por `validar` como RN2, dejando rastro. El
dominio ya tiene ese mecanismo.

**Orden de escritura a→b→c→d, deliberado.** `procesados.json` va el último: si el
proceso muere antes, el reintento vuelve a correr y como mucho duplica una línea del
historial. Al revés dejaría el mensaje marcado sin haberse registrado, que es pérdida
de datos en silencio. Se prefiere un historial ruidoso a un contrato perdido y callado.

---

## S-17 · Un duplicado no se marca como procesado, y sigue apareciendo en el buzón

RN1 dice que un duplicado *"no se escribe nada; se reporta"*, y eso se implementa al
pie de la letra: cero escrituras, ni siquiera `procesados.json`, ni con
`confirmado: true`.

**Consecuencia:** `msg-004` vuelve a aparecer en cada `contratos_leer_buzon`. La
verificación 26 lo documenta: tras registrar los demás, el buzón conserva `msg-002`
(nunca registrado) y `msg-004` (duplicado).

Es lo que el enunciado pide, y tiene una lectura defendible —un duplicado no es
trabajo terminado, es un aviso de que alguien reenvió algo— pero en un buzón real
produciría ruido creciente. La alternativa sería marcarlo procesado sin tocar el
maestro. No se hizo porque contradice el texto de RN1 y el criterio de huella idéntica.

> **Nota posterior.** Este supuesto decía "como se hace con `rechazado`". Dejó de ser
> cierto con **S-28**: desde entonces un rechazado tampoco escribe nada, así que
> duplicado y rechazado se comportan igual y ambos reaparecen en el buzón.

---

## S-27 · El flujo es una precondición del código, no una recomendación del prompt

**El fallo observado.** En la prueba manual con el prompt del §11, el agente llamó a
`leer_buzon`, seis veces a `extraer`, y **directo a seis `registrar`**. Ni una llamada
a `validar`.

**Qué NO pasó, para que quede claro:** no se corrompió nada. `contratos_registrar`
re-ejecuta extraer y validar por dentro, así que msg-005 habría caído en la rama de
rechazo y msg-004 en la de duplicado. Ninguna escribe en el maestro.

**Qué sí pasó, que es grave igual.** La persona aprueba a ciegas: el bloque decía
`{mensaje_id: "msg-005", hoy: "2026-09-03"}`, sin mencionar que es una cotización. Y el
agente no puede narrar nada —ni el veredicto, ni el campo por campo de msg-006— porque
nunca vio el resultado de `validar`, que es justo lo que el §11 espera que se muestre.

**La solución: un comprobante.** `contratos_validar` devuelve un `comprobante`, un hash
corto de lo que vio —extracción, veredicto y fila del maestro con la que comparó—, y
`contratos_registrar` lo exige y lo recalcula. El modelo no puede fabricarlo sin haber
llamado a `validar`.

Se eligió esto y no "rechazar si el veredicto es duplicado o rechazado" porque esa
versión más simple **no obliga a validar los casos `nuevo` y `actualizacion`**: el
agente seguiría atajando en msg-001, 002, 003 y msg-006, que es precisamente donde el
campo-por-campo importa. Reforzar el prompt tampoco bastaba: un prompt no es una
garantía, y este diseño se apoya en que las garantías viven en el código.

**Efecto secundario que no habíamos cubierto:** el comprobante cierra una carrera. Si
el maestro cambia entre validar y registrar —otro mensaje del mismo lote insertó la
fila—, el veredicto aprobado ya no es el que aplica. El hash deja de coincidir y la
escritura se rechaza en vez de ejecutarse sobre un estado que nadie validó.

**Lo que no garantiza:** que el agente *lea* el veredicto antes de registrar. Puede
llamar a validar, ignorar la respuesta y pasar el comprobante. Lo que sí garantiza es
que el veredicto exista, sea actual y esté en el historial visible del chat.

---

## S-28 · Duplicado y rechazado dejan de escribir, y esto cambia el buzón

`contratos_registrar` ahora devuelve **sobre de error con cero escrituras** cuando el
veredicto es `duplicado` o `rechazado`. Sobre de error y no de éxito porque llamar a
registrar sobre un duplicado es un uso incorrecto de la herramienta, y un `ok` invitaría
al agente a decir "registrado".

**Esto cambia una decisión anterior y conviene decirlo.** Antes, un `rechazado` no
tocaba el maestro pero **sí** marcaba el mensaje en `out/procesados.json`. Ahora no
escribe absolutamente nada.

**Consecuencia:** msg-005 ya no se marca y **vuelve a aparecer en cada
`leer_buzon`**, igual que msg-004 por RN1 (S-17). El buzón termina con msg-002 (nunca
registrado), msg-004 y msg-005.

A favor: duplicado y rechazado se comportan igual, que es más coherente que la
asimetría anterior, y `registrar` queda con una sola responsabilidad —registrar— sin el
efecto lateral de archivar decisiones que no son registros.

En contra, y es real: en un buzón de producción los rechazos se acumularían y el agente
volvería a procesarlos en cada pasada. **Si eso molesta, la salida no es devolverle el
efecto lateral a `registrar`, sino una herramienta aparte** (`contratos_archivar`) que
marque un mensaje como visto con su motivo. No se construyó porque no está en el PRD.

---

## S-29 · El esquema 7.2 valida la forma de lo que hay, no exige que esté todo

El esquema del maestro es normativo y la fila se valida **antes** de escribirla. Pero
una lectura literal lo hace imposible de cumplir, y conviene dejar escrito por qué.

**El conflicto.** 7.2 declara `moneda` como `COP|USD|PEN|PAB|HNL` y las fechas como
`YYYY-MM-DD`. Una celda vacía no cumple ninguno de los dos. Y `CM-2026-03` —el contrato
marco por demanda— no tiene moneda, porque no tiene valor, ni día de firma. Si el enum
se exigiera, **msg-006 nunca podría registrarse**, y 7.4 manda registrarlo tras
confirmar y §11 lo da por registrado en la demo del evaluador.

**El criterio.** Se valida la **forma** de lo que hay:

- **Valor mal formado → se rechaza la escritura.** Una moneda `EUROS`, una fecha
  `31/08/2027`, un `valor` con separadores o un `estado_poliza` inventado corrompen el
  maestro en silencio y rompen las alertas. Eso es exactamente lo que este proyecto
  existe para evitar.
- **Celda vacía → se permite**, salvo en las cinco columnas que identifican la fila
  (`id_contrato`, `cliente`, `nit_cliente`, `fecha_registro`, `fuente`). Vacío no es un
  dato mal formado: es la ausencia declarada de un dato, ya marcada en
  `requiere_revision` y aprobada por una persona (S-21).

Entre dos lecturas del PRD que se contradicen, se respeta la que tiene un caso de
prueba detrás.

**`objeto` es distinto: se recorta.** 7.2 fija un máximo de 200 caracteres, así que
recortar no es una decisión nuestra sino lo que el esquema pide. Se corta por palabra
entera y se señala con `…`. El texto íntegro no se pierde: sigue en la extracción y en
`historial.jsonl`. `CM-2026-03` pasó de 222 a 197 caracteres.

**Coherencia con S-4.** Aquel supuesto dice que el objeto se extrae literal sin
resumir, y sigue siendo cierto: el recorte es un límite de columna, no un resumen. Nada
se reescribe, solo se trunca.

---

## S-30 · De dónde sale el conteo de tokens

El requisito no funcional exige un tope por sesión. El número se toma, por orden:

1. **`usage.total_tokens` que devuelve el proveedor.** Es el número que se factura, así
   que cuando viene manda ése. Se añadió `uso` a `RespuestaProveedor` y el adaptador de
   OpenAI lo traduce.
2. **Estimación local** a 4 caracteres por token sobre lo enviado más lo recibido,
   cuando el proveedor no lo reporta: el proveedor falso de las pruebas, o una respuesta
   recortada. Es una aproximación conocida y conservadora para texto latino. Sirve para
   que el tope **siga aplicando** cuando no hay dato real, no para facturar.

**Dónde se comprueba.** Antes de **cada envío** al proveedor, no solo al empezar el
turno. El historial completo se reenvía en cada iteración, así que un turno de 25
iteraciones cuesta mucho más que el mensaje que lo inició; mirar el tope solo al
principio dejaría pasar justo el caso caro.

**Quién lleva la cuenta.** El tope es por *sesión*, y las sesiones viven en el servidor:
`Sesion.tokensUsados` acumula lo que cada turno declara. El ciclo recibe ese acumulado y
el tope, y si se agota corta el turno con `motivoFin: "tope-tokens"` y un aviso legible.
Por defecto 120 000 tokens por sesión, configurable; `0` desactiva el tope.

---

## S-18 · Un otrosí sobrescribe el puntero al documento original

La ruta que fija HU-4 es `Contratos/<año>/<cliente-slug>/<id_contrato>.<ext>`, y la
fila del maestro tiene una sola columna `ruta_sharepoint`. Cuando se registra un
otrosí sobre un contrato existente, esa columna pasa a apuntar al otrosí y se pierde
la referencia al contrato original: para `CT-2026-011` pasa de
`Contratos/2026/minera-los-andes/CT-2026-011.pdf` a `…/CT-2026-011.txt`.

Como las extensiones difieren, el archivo anterior ni siquiera se sobrescribe: queda
huérfano en disco, sin nadie que lo referencie.

No se corrigió porque arreglarlo exige cambiar el formato de ruta que el PRD fija (por
ejemplo `CT-2026-011-otrosi-1.txt`, o una columna de documentos múltiples), y eso
excede el enunciado. Queda anotado: es un defecto del modelo de datos propuesto, no de
la implementación.

---

## S-20 · Un campo confirmado no tiene escalón en la escala de confianza

Un valor aportado por una persona queda con `estado: "confirmado"` y **confianza 0.9**.
Ese número **no es una medición**, y conviene decirlo antes de que alguien lo lea como
si lo fuera.

La escala de S-1 ordena **proximidad al documento**: 1.0 es *"está escrito ahí, literal
y sin normalizar"*, 0.6 es *"lo calculé yo a partir de lo que está escrito"*. Un valor
confirmado tiene proximidad **cero**: el documento no lo dice. Es evidencia de otra
especie —la afirmación de una persona— y no le corresponde ningún escalón de esa
escala.

El 0.9 está puesto por una razón mecánica y única: que el campo cruce el corte de RN5 y
deje de bloquear el registro, que es exactamente lo que el humano decidió al confirmar.
No se usó 1.0 porque sería afirmar que el documento lo dice sin ambigüedad, que es
falso.

**La señal que informa es `estado: "confirmado"`**, más la columna `procedencia` de la
respuesta y la lista `correcciones` del historial. Quien audite debe mirar eso, no el
número. Si el corte de RN5 se moviera, el 0.9 habría que reconsiderarlo; el `estado` no.

---

## S-21 · Se registra aunque queden campos en revisión sin corregir

`correcciones` puede cubrir solo algunos de los campos en revisión. Los que queden sin
corregir **no impiden el registro**: `confirmado: true` basta.

**Por qué.** Confirmar es un acto deliberado sobre lo que el bloque de confirmación
mostró, no una promesa de haberlo resuelto todo. Exigir un valor para cada campo
marcado obligaría al humano a inventar uno, que es peor que dejarlo vacío: convertiría
un *no lo sabemos* en un dato con apariencia de hecho. Un contrato marco sin moneda
determinable debe poder registrarse **como lo que es**, no con una moneda plausible.

`msg-006` lo ejercita: se corrigen `valor` y `fecha_fin`, y se registra con `moneda`,
`fecha_inicio`, `requiere_poliza` y `tipo_poliza` todavía bajo el corte.

**Registrar no es olvidar.** Los campos sin corregir viajan en
`revision_sin_corregir`, en el resumen legible (*"4 siguen sin determinar y se
registraron así por confirmación explícita: moneda, fecha_inicio, requiere_poliza,
tipo_poliza"*) y en la línea de `historial.jsonl`. Y como `requiere_poliza` sigue en
`true` con `estado_poliza: pendiente`, la alerta de HU-5 sigue viva.

---

## S-22 · La guarda contra el modelo: dónde aguanta y dónde está floja

`correcciones` lo compone el modelo, porque el modelo es quien arma los argumentos.
El razonamiento completo está como comentario en `src/tools/contratos.ts`, junto a la
definición del argumento. Resumen y, sobre todo, **dónde falla**:

**Lo que aguanta el peso no es la atención del humano**, sino que el conjunto de campos
corregibles lo calcula `registrar` re-ejecutando el extractor y el validador
deterministas. El modelo no puede ensancharlo. **Nunca puede aportar un valor para un
campo que el documento afirma con claridad**; lo peor que puede hacer es dar un valor
equivocado para un campo que el extractor ya había marcado como desconocido y que ya
estaba bloqueando el registro.

Verificado en el código del ciclo, no supuesto: los argumentos se congelan en
`LlamadaPendiente` (`ciclo.ts:348`), se muestran esos exactos (`ciclo.ts:357`), se
ejecuta ese mismo objeto (`ciclo.ts:539`), el cliente solo puede enviar un booleano
(`server.ts:410`) y mientras hay un pendiente el texto libre se rechaza
(`server.ts:454`). `idsAutorizados` lleva solo el id aprobado, así que seis registros
en un lote piden seis confirmaciones.

**El agujero, en la mitad humana.** `describirPendiente` renderiza
`JSON.stringify(argumentos)`. Lo que el humano aprueba es un volcado JSON, y su
aprobación es un booleano, no una reafirmación. El §11 del PRD tiene al humano
*tecleando* los valores, que es un acto mucho más fuerte. Si el modelo escribe
`2027-08-13` en vez de `2027-08-31`, un clic distraído lo deja pasar.

Mitigación aplicada: no impide el error, lo vuelve **atribuible**. El campo queda con
`estado: "confirmado"`, `procedencia: "humano"` y su valor exacto en
`historial.jsonl`, en vez de ser indistinguible de una lectura del documento.

Mitigación pendiente, fuera del alcance de esta tarea: que `describirPendiente`
renderice las correcciones campo a campo en prosa en lugar de volcar JSON.

**Segundo hueco, de estado y no de diseño:** toda la cadena depende de que
`contratos_registrar` esté en `requierenConfirmacion`, y eso vive en `inicio.ts`, que
todavía no se ha cableado. **Hoy la guarda es un diseño, no un hecho aplicado.** Sin
esa línea de configuración, `registrar` se ejecuta sin parada humana y `confirmado:
true` —que también lo compone el modelo— no vale nada. Es el primer pendiente al
registrar las herramientas.

---

## S-23 · Los contratos ya vencidos van en un grupo aparte, y primero

`contratos_alertas` separa **ya vencidos** de **vencen en ≤60 días** en dos secciones,
en vez de meterlos en una sola con días negativos.

**Por qué.** Son acciones distintas, para públicos distintos:

- *"Vence en 27 días"* → decidir si se renueva. Es planeación comercial.
- *"Venció hace 65 días"* → o el servicio se está prestando **sin contrato vigente**, o
  la terminación nunca se registró. Es exposición legal o un fallo de datos. No se
  renueva: se investiga.

Además, una sección titulada *"vencen en ≤60 días"* que contuviera algo caducado hace
dos meses sería una afirmación falsa sobre su propia cabecera, e inflaría su recuento.
Y un número de días negativo es señal de **fila rancia**, no de urgencia: mezclarlos
hace que urgencia y desactualización se vean igual.

Los vencidos van **primero** en el markdown, porque su severidad es mayor. Con el
fixture son `CT-2025-018` (−65 días) y `CT-2026-002` (−56 días), que vencieron en junio
y julio de 2026: exactamente el periodo del gap que el proyecto existe para cerrar. Que
salgan destacados es el objetivo, no un efecto colateral.

**Criterio exacto:** `dias = fecha_fin − hoy`. `dias < 0` → vencido. `0 ≤ dias ≤ 60` →
por vencer, así que un contrato que vence el mismo día del corte cuenta como vigente,
no como caducado.

---

## S-24 · La fecha de corte es obligatoria, y el reporte la estampa

`contratos_alertas` exige `hoy` y **no tiene valor por defecto**.

Un reporte de vencimientos calculado contra `Date.now()` cambia de respuesta cada día
sin que nadie toque el código, y los requisitos no funcionales exigen que `demo.ts` sea
reproducible entre corridas.

**Alternativas descartadas:**

- *Opcional con defecto "hoy"* — la peor de las tres, peor que cualquier extremo:
  funciona en desarrollo y cambia mañana en silencio, y las pruebas pasarían sin
  ejercitar nunca el camino explícito, que es el único que usa la demo.
- *Variable de entorno o configuración* — invisible en la llamada: el evaluador lee el
  reporte y no sabe contra qué fecha se calculó.
- *Derivarla del maestro* (máximo `fecha_registro`) — determinista, pero hace que el
  reporte dependa de los datos de forma no evidente: añadir una fila movería el corte.

Lo decisivo es **CA2**: *"el modelo no puede afirmar un valor que no haya salido de una
herramienta"*. Si la fecha la pusiera la función por su cuenta, el modelo estaría
contando en el chat un corte que nunca vio. Como argumento obligatorio viaja en la
llamada, queda en `out/log.jsonl` por CA4 y es visible en el historial del chat.

**Refinamiento:** la fecha se estampa en la cabecera de `alertas.md` y se devuelve en
el resumen estructurado. Un reporte de vencimientos que no dice contra qué fecha se
calculó es una trampa para quien lo lea tres semanas después. Se valida además como
fecha real de calendario, no solo por formato.

**Determinismo del archivo:** todo el contenido es función de `(hoy, maestro)` salvo
una única línea, `Generado: <ISO>`. Dos llamadas con la misma fecha producen un archivo
idéntico byte a byte excepto esa línea, y la verificación lo comprueba en ambos
sentidos: que el resto no cambia, y que cambiar la fecha de corte **sí** cambia el
reporte.

---

## S-25 · Se incluyó la sección `registrados_desde_corte`, que no estaba en el encargo

HU-5 y el contrato de herramientas de §6.2 exigen tres secciones: vencimientos,
pólizas, y **contratos registrados desde el 2026-05-30** (`registrados_desde_corte` en
la forma de salida declarada). El encargo de esta tarea enumeró solo vencimientos,
pólizas, vencidos y remitentes.

Se incluyó igualmente, porque omitirla dejaría HU-5 a medias y `contratos_alertas` no
cumpliría la firma que el PRD declara.

Con el fixture puro da **0**: el `fecha_registro` más reciente es 2026-05-18, o sea que
el gap sigue entero sin cubrir, que es precisamente el diagnóstico del proyecto. Tras
registrar los mensajes del buzón sube a 3. La fecha de inicio del gap es la constante
`CORTE_GAP` en `src/tools/contratos.ts`.

---

## S-26 · Filas sin fecha de terminación: sección propia, no silencio

Una fila del maestro sin `fecha_fin` no se puede vigilar: no hay vencimiento que
calcular. Queda fuera de los grupos 1 y 2, y si desapareciera ahí se acabaría el asunto
— un contrato invisible para siempre en el reporte de riesgos.

Se lista en una sección propia (`sin_fecha_fin`), que solo aparece en el markdown
cuando hay alguna. No se da en el recorrido de los fixtures, porque `CM-2026-03` acaba
con `fecha_fin` confirmada por una persona (S-19); se implementó porque un maestro real
sí las tendrá, y porque el fallo que produce es del tipo silencioso.

---

## S-19 · `confirmado: true` da permiso, no aporta valores

`contratos_registrar` recibe `confirmado: boolean`, tal como se especificó, y no un
mapa de valores corregidos. Confirmar significa *"escribe lo que tienes"*, no
*"escribe esto otro"*.

> **CERRADO.** Este supuesto describía el estado anterior. `contratos_registrar` acepta
> ahora `correcciones`, y el camino de la demo de §11 funciona:
> `{ confirmado: true, correcciones: { valor: 0, fecha_fin: "2027-08-31" } }` deja esa
> fecha exacta en la fila de `CM-2026-03`. Se conserva la entrada porque explica de
> dónde salió el diseño. Ver **S-20** (confianza de un campo corregido), **S-21**
> (qué pasa con lo no corregido) y **S-22** (la guarda contra el modelo).

**Estado anterior:** `contratos_registrar` recibía solo `confirmado: boolean`.
Confirmar significaba *"escribe lo que tienes"*, no *"escribe esto otro"*, así que
`msg-006` registrado con `confirmado: true` quedaba con `fecha_fin` vacía, mientras el
PRD en §11 espera que tras *"confirmo el valor 0 y la fecha fin 2027-08-31"* la fila
lleve esa fecha.

**Cómo se cerró.** `correcciones` es un mapa opcional de campo a valor con tres
puertas: solo se aplica con `confirmado: true`; solo puede pisar campos que estén en
`requiere_revision`, calculado por el validador determinista y no propuesto por el
modelo; y cada valor se valida contra el esquema del campo, incluida la existencia de
la fecha en el calendario. Un campo corregido sale de `requiere_revision` y queda
trazado en la respuesta y en el historial.

---

## S-5 · El escalón 0.6 no lo ejercita ningún fixture

`fecha_fin` derivada desde un plazo en meses vale 0.6 y está implementada, pero
ninguno de los seis mensajes la activa: `msg-001`, `msg-002` y `msg-004` traen fechas
literales, `msg-003` trae la fecha de terminación, y `msg-006` no tiene fecha de
inicio de la que partir. `msg-002` y `msg-004` traen *además* el plazo en meses, y la
regla de precedencia —la fecha escrita gana sobre la derivada— sí queda verificada
sobre fixture real (verificación 9 de `prueba-contratos.ts`).

Se declara aquí porque es código en producción sin cobertura de fixture: un contrato
real que diga *"doce (12) meses a partir del 1 de septiembre de 2026"* sin fecha de
terminación explícita caería en ese camino, y saldría en 0.6 → `requiere_revision`.

---

## S-6 · El tipo de documento se decide por contenido, no por nombre de archivo

`tiene_contrato` y la selección de extractores se deciden leyendo el encabezado del
adjunto (`CONTRATO`, `CONTRATO MARCO`, `OTROSÍ`, `COTIZACIÓN`), no por el nombre del
archivo. En los fixtures ambos criterios coinciden, pero un adjunto mal nombrado
—cosa común en un buzón real— no engañaría a ninguno de los dos.

---

## S-7 · El cliente es siempre la primera parte

Los cinco contratos nombran a `PERIFERIA IT GROUP S.A.S., NIT 900.123.456-7` como
segundo firmante. Un regex de NIT sin anclaje captura al contratista, no al cliente.
La extracción se ancla en `"Entre [los suscritos,] <RAZÓN SOCIAL>, ... NIT|RUC <id>"`
y toma la primera parte. La inferencia textual de país se limita además al tramo
anterior a `PERIFERIA IT GROUP`, porque todos los contratos dicen *"Medellín,
Colombia"* al presentar al contratista y ese tramo contaminaría el resultado
(`msg-002` saldría `CO` en vez de `EC`).

---

## S-8 · Formato de `out/procesados.json`

El PRD no fija su forma. `contratos_leer_buzon` acepta, de manera tolerante y
determinista, tres shapes: un array de strings, un array de objetos con `mensaje_id`
o `id`, o un objeto con la clave `procesados`. Que el archivo **no exista** no es un
error: significa que no se ha procesado nada. Que exista pero sea ilegible se trata
igual, para no bloquear la lectura del buzón por un archivo corrupto.

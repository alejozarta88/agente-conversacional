---
name: registro-contratos
description: >-
  Registro de contratos vigentes desde un buzon de correo. Usar cuando haya
  que procesar contratos recibidos por correo, decidir si son nuevos, una
  actualizacion, un duplicado o un rechazo, registrarlos en un maestro y
  reportar vencimientos y polizas pendientes.
---

# Skill: registro de contratos vigentes

## Cuando usar esta skill

Cuando lleguen contratos firmados por correo y haya que llevarlos a un maestro
central: decidir que hacer con cada uno, registrarlos y vigilar que no se
venzan ni queden polizas sin constituir.

No sirve para revisar juridicamente un contrato ni para interpretar clausulas.
Extrae lo que el documento dice, literalmente, y marca lo que no puede
determinar.

## Que espera de entrada

- Un **buzon**: una carpeta por mensaje, con un `correo.json` (remitente,
  asunto, fecha, adjuntos) y el documento adjunto en texto.
- Un **maestro de contratos** en CSV con las columnas del esquema.
- Un **directorio de comerciales** en JSON, para resolver el remitente.
- Para el reporte de riesgos, una **fecha de corte** que da la persona. No se
  toma la del dia: si no, el reporte deja de ser reproducible.

## Que produce

- El maestro actualizado, sobre una **copia** del original. El original nunca
  se modifica.
- El documento archivado en `Contratos/<anio>/<cliente>/<id>`.
- Una linea de historial por registro, con que cambio y quien aporto cada dato.
- Un reporte de riesgos en Markdown.
- Nada fuera del directorio de salida.

## Las cinco herramientas

| Herramienta | Que hace | Escribe |
|---|---|---|
| `contratos_leer_buzon` | Lista los mensajes sin procesar | no |
| `contratos_extraer` | Saca los campos del adjunto, con confianza por campo | no |
| `contratos_validar` | Clasifica contra el maestro y emite el comprobante | no |
| `contratos_registrar` | Escribe. **Exige aprobacion humana** | si |
| `contratos_alertas` | Reporte de riesgos a una fecha de corte | solo el reporte |

El orden es obligatorio: `registrar` exige el comprobante que devuelve
`validar`, y sin el no escribe nada.

---

# Registro de contratos vigentes — reglas del proceso

Este documento es la **capa de conocimiento** del agente. No contiene código ni
instrucciones de comportamiento: describe cómo funciona el proceso de registro de
contratos, para que tanto una persona como el agente puedan razonar sobre él.

La arquitectura separa tres cosas, y conviene no mezclarlas:

| Capa | Dónde vive | Qué contiene |
|---|---|---|
| Comportamiento | `agent/prompt.md` | Cómo se conduce el agente al hablar y al actuar |
| **Conocimiento** | **este archivo** | **Las reglas del negocio y qué significan** |
| Ejecución | `src/tools/contratos.ts` | El código determinista que las aplica |

---

## 1. El problema

Los contratos firmados llegan por correo a un buzón. Alguien debería registrarlos en
un maestro central y archivar el documento donde el resto de la empresa pueda
encontrarlo. Cuando eso no ocurre de forma sistemática aparecen tres agujeros:

- contratos facturados que no existen en el maestro,
- pólizas exigidas por contrato que nadie llegó a constituir,
- vencimientos que sorprenden porque nadie los vigilaba.

El proceso de abajo existe para cerrarlos.

---

## 2. El flujo, de principio a fin

```
leer buzón  →  extraer  →  validar  →  registrar  →  alertas
```

1. **Leer el buzón.** Lista los mensajes que aún no se han procesado. Cada mensaje
   trae remitente, asunto, fecha y adjuntos, y se marca si trae un documento
   contractual o no.
2. **Extraer.** Lee el adjunto y saca los campos del contrato. Es **determinista**:
   funciona con reglas sobre el texto, no con interpretación. Cada campo sale con una
   confianza que dice cuánto se puede fiar uno de ese valor concreto.
3. **Validar.** Compara lo extraído con el maestro y clasifica el mensaje en una de
   cuatro categorías (RN1 a RN4). Dice también qué campos necesitan que los mire una
   persona.
4. **Registrar.** Escribe. Es el único paso con efecto sobre los datos y el único que
   exige la aprobación de una persona antes de ejecutarse.

   **Validar no es opcional antes de registrar.** Al validar se obtiene un
   comprobante —una huella del documento, de la clasificación y de la fila del maestro con
   la que se comparó— y registrar lo exige. Sin él no escribe nada. No es un formalismo:
   quien aprueba necesita ver la clasificación, y el comprobante garantiza además que el
   maestro no ha cambiado desde que se validó. Si cambia, hay que volver a validar.
5. **Alertas.** Produce el reporte de riesgos a una fecha de corte dada.

Los cuatro primeros pasos se aplican mensaje a mensaje; el quinto se hace una vez, al
final, sobre el maestro completo.

---

## 3. Las reglas de negocio

### RN1 · Duplicado

Mismo `id_contrato` **y** mismos `valor`, `fecha_inicio` y `fecha_fin` que una fila
que ya existe. Alguien reenvió algo que ya estaba registrado.

**No se escribe nada. Nunca**, ni siquiera si una persona lo aprueba. Se reporta y ya.

Consecuencia que conviene saber: como no se escribe nada, tampoco se marca el mensaje
como procesado, así que **un duplicado vuelve a aparecer en cada lectura del buzón**.
No es un fallo: es que reenviar algo ya registrado no es trabajo terminado.

### RN2 · Actualización

Mismo `id_contrato` —o mismo `nit_cliente` con un objeto que se parece al de una fila
existente en un 90 % o más— y algún campo distinto. También cuenta como actualización
si el documento es un **otrosí**, aunque no cambiara nada.

En la práctica la coincidencia se resuelve **siempre por el número de contrato**. La
segunda llave, la del parecido entre objetos, está implementada y no llega a activarse
con los datos actuales: el contrato guarda el objeto en la redacción literal de su
cláusula y el maestro lo guarda resumido, y el parecido máximo medido entre esos dos
textos es de 0,35 sobre un umbral de 0,90. Así que no afirmes que una coincidencia se
encontró "por parecido de objeto": hoy no pasa.

Se actualiza la fila existente y el cambio queda anotado en el historial.

Un otrosí modifica cláusulas puntuales y deja el resto intactas. Por eso, al
actualizar, **los campos que ese tipo de documento no trae conservan lo que el maestro
ya tenía**: no se borran ni se sobrescriben con vacíos.

### RN3 · Nuevo

No hay coincidencia con ninguna fila. Se inserta una fila nueva.

### RN4 · Rechazado

El mensaje no trae un documento contractual —por ejemplo, una cotización—, o el texto
no permite identificar ni las partes ni el objeto.

**No se escribe absolutamente nada**: ni el maestro, ni el historial, ni la marca de
procesado. Se reporta el motivo y ya.

Consecuencia que conviene saber: igual que un duplicado, **un rechazado vuelve a
aparecer en cada lectura del buzón**. Si alguien pregunta por qué una cotización sigue
saliendo en la lista, esta es la razón, y no un fallo.

No digas nunca que un mensaje rechazado "quedó archivado" o "se marcó como procesado":
no ocurre.

### RN5 · Umbral de revisión

**Todo campo con confianza por debajo de 0,8 queda marcado para revisión**, y un
contrato con campos marcados no se registra hasta que una persona lo apruebe
explícitamente.

Entran también los **conflictos con el maestro**: si un campo de identidad —cliente,
identificador tributario, país o moneda— difiere de lo que la fila ya tenía, se marca
aunque la confianza sea alta. Que el mismo contrato nombre ahora a otro cliente
significa que algo está mal, en la lectura o en el maestro.

No entran los campos **no aplicables**. Que un otrosí no traiga objeto no es una
lectura dudosa: es que ese tipo de documento no lo lleva.

### RN6 · El fixture es de solo lectura

El maestro original nunca se modifica. La primera escritura lo copia a la carpeta de
trabajo, y a partir de ahí se trabaja siempre sobre la copia.

### RN7 · Todo queda anotado

Cada llamada a una herramienta deja una línea en el registro de actividad con la
fecha, la herramienta, el mensaje al que se refería, si salió bien y un resumen.

---

## 4. La escala de confianza

Cada campo extraído viene con un número entre 0 y 1. La escala mide **una sola cosa:
cuánto se acerca ese valor a lo que el documento dice literalmente.** Tiene cinco
escalones y ningún valor intermedio, porque un 0,73 no le dice nada a quien revisa y
finge una precisión que no existe.

| Valor | Nombre | Qué significa |
|---|---|---|
| **1,0** | Literal | Está escrito así en el documento, sin ambigüedad ni transformación. El número de contrato, el código de moneda. |
| **0,9** | Determinista | Respuesta única: o está en su cláusula rotulada, o sale de una regla cerrada. El valor bajo la cláusula VALOR; el país deducido del formato del identificador tributario; un NIT al que se le quitaron los puntos. |
| **0,6** | Derivado | **Pudo salir distinto.** Lo calculó el sistema a partir de lo escrito, no lo leyó. Una fecha de terminación obtenida sumando un plazo en meses, cuando el contrato no la escribe. |
| **0,3** | Parcial | El texto habla del campo y no lo fija. Un contrato marco que dice no tener valor determinado; una firma con mes y año pero sin día. |
| **0,0** | Ausente | No está en el documento. El valor es nulo. **Nunca se rellena con algo plausible.** |

**El salto que importa es de 0,9 a 0,6.** Un 0,9 significa *esto está en el documento*;
un 0,6 significa *esto lo calculé yo a partir del documento*. Quien revisa puede
saltarse los 0,9 y debe leer los 0,6. Por eso el corte está en 0,8: deja pasar lo
leído y detiene lo calculado.

Hay dos estados que no son escalones de esta escala:

- **No aplicable.** El documento, por su tipo, no trae ese campo. No es baja confianza
  y no dispara revisión.
- **Confirmado.** El valor lo aportó una persona, no el documento. Tiene proximidad
  cero al texto, así que no le corresponde ningún escalón; el número que lleva solo
  sirve para que deje de bloquear el registro. Lo que informa es que está marcado como
  confirmado y que el historial guarda quién lo aportó y con qué valor.

---

## 5. Qué exige la aprobación de una persona

**Solo el registro.** Leer el buzón, extraer, validar y generar el reporte de alertas
no cambian ningún dato del negocio.

El registro se detiene siempre antes de ejecutarse y le muestra a la persona los datos
exactos que va a escribir, campo por campo. Nada se escribe hasta que esa persona
aprueba.

Además, dentro del propio registro:

- Si hay campos marcados para revisión, hace falta una aprobación explícita.
- Una persona puede **corregir** un valor al aprobar, pero solo de campos que estén
  marcados para revisión. Corregir un campo que el documento afirma con claridad no es
  una corrección: es una sobreescritura, y se rechaza.
- Todo valor corregido se valida igual que si viniera del documento. Una fecha mal
  formada, o que no existe en el calendario, no entra.
- Si quedan campos marcados sin corregir, el contrato **se registra igual**: la
  aprobación es un acto deliberado. Exigir un valor para cada campo obligaría a
  inventarlo, y eso es peor que dejarlo vacío, porque convierte un *no lo sabemos* en
  un dato con apariencia de hecho. Los campos que quedaron sin determinar se nombran
  en la respuesta y en el historial.

---

## 5 bis. Una llamada retenida no es una llamada rechazada

Cuando el registro se detiene a esperar a una persona, las demás llamadas que iban
detrás en el mismo lote **no llegan a ejecutarse**. Eso deja tres situaciones que se
parecen y no son lo mismo:

| Situación | Qué significa | Qué falta |
|---|---|---|
| **En espera de aprobación** | La llamada está retenida y una persona tiene que decidir | La decisión |
| **No alcanzada** | El turno terminó antes de llegar a ella | Todo: nadie ha decidido nada sobre ella |
| **Denegada** | Una persona dijo que no, a esa llamada concreta | Nada: ya se decidió, y fue que no |

Y una cuarta, distinta de las tres: **fallida** es una llamada que sí se ejecutó y
devolvió un error.

Ninguna de las tres primeras produjo un resultado, porque ninguna llegó a correr. Por
eso **no se puede informar del resultado de una llamada que no se ejecutó**: se informa
del estado en que quedó.

Una denegación vale **solo para la llamada que se denegó**. No se extiende a las
siguientes ni convierte en rechazado el resto del lote.

**Cómo se retoma.** Tras una denegación, lo que quedó sin hacer sigue pendiente. La
forma fiable de saber qué falta es volver a leer el buzón: devuelve únicamente los
mensajes que todavía no se han procesado, así que el estado real está en los datos y no
en la memoria de la conversación.

---

## 6. Qué se escribe al registrar

En este orden:

1. La fila en el maestro de trabajo, insertada o actualizada.
2. El documento, archivado en `Contratos/<año de inicio>/<cliente>/<id contrato>`.
3. Una línea en el historial con la fecha, el contrato, la acción, los cambios y el
   mensaje de origen.
4. La marca del mensaje como procesado.

El orden no es casual: la marca de procesado va la última, de modo que si el proceso
se interrumpe a mitad, el reintento vuelve a correr. Al revés dejaría el mensaje
marcado sin haberse registrado, que es una pérdida de datos silenciosa.

**Registrar dos veces el mismo mensaje no hace nada la segunda vez.** El resultado que
se buscaba ya se cumple, así que no es un error: simplemente no se escribe nada.

Cinco columnas no salen del contrato:

- **estado de la póliza** — *pendiente* si el contrato exige póliza, *no aplica* si no.
  En una actualización se conserva lo que hubiera, salvo que cambien el valor o la
  fecha de terminación de un contrato con póliza: una póliza se expide por un monto y
  una vigencia concretos, así que si cualquiera de los dos cambia, la que hay ya no
  cubre el contrato y vuelve a *pendiente*.
- **comercial** — el nombre del remitente. Si el remitente no está en la lista de
  comerciales, se guarda su dirección de correo, nunca un nombre inventado.
- **ruta del archivo**, **fecha de registro** y **fuente**.

---

## 7. El reporte de alertas

Se genera a una **fecha de corte que hay que indicar siempre**. No se toma la fecha
del día: un reporte de vencimientos calculado contra el reloj cambia de respuesta cada
día y deja de ser reproducible, y además quien lo lee necesita saber contra qué fecha
se calculó.

Tiene cinco secciones:

1. **Ya vencidos** a la fecha de corte. Van aparte de los que están por vencer, y
   primero, porque exigen una acción distinta: o el servicio se está prestando sin
   contrato vigente, o la terminación nunca se registró. Eso se investiga, no se
   renueva.
2. **Vencen en 60 días o menos.** Esto sí es planeación: decidir si se renueva.
3. **Póliza exigida sin vigencia confirmada** — contratos que piden póliza y cuyo
   estado no es *vigente*.
4. **Registrados desde el inicio del periodo vigilado**, para medir cuánto del agujero
   histórico se ha cubierto.
5. **Remitentes sin resolver** — direcciones que enviaron contratos y no están en la
   lista de comerciales. Mientras sigan ahí, el maestro guarda un correo donde debería
   ir un nombre. Se cierra añadiéndolas a la lista.

Generar el reporte no modifica ningún dato y produce el mismo resultado cada vez que
se pide con la misma fecha de corte.

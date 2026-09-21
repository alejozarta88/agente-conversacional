# Agente conversacional — Registro de contratos vigentes

Reto técnico 02. Los contratos firmados llegan por correo y nadie los registra
de forma sistemática, así que no se sabe qué está vigente, qué vence ni qué
pólizas faltan por constituir. Lo usa la analista administrativa, dueña del
maestro de contratos. El agente lee el buzón, extrae los campos de cada
contrato con una confianza por campo, los clasifica contra el maestro, los
registra **solo cuando una persona lo aprueba** y produce un reporte de riesgos.

---

## Por dónde empezar

| Quiero… | Dónde |
|---|---|
| **Verlo funcionando** | **[agente-conversacional.onrender.com](https://agente-conversacional.onrender.com)** — pega en el chat el prompt de abajo |
| **Correrlo sin clave y sin red** | `pnpm install`, luego `pnpm demo`. Procesa los seis mensajes del buzón y termina con el reporte de alertas |
| **Entender el código** | `src/tools/contrato.ts` primero: todo lo demás descansa en él. Luego `src/llm/adapter.ts`, que son solo tipos y es lo que permite probar el ciclo entero sin red |
| **Entender las decisiones** | [SOLUCION.md](SOLUCION.md) — §3 el ciclo y la confirmación humana, §5 cómo se calcula la confianza y dónde no entra el modelo, §7 las nueve decisiones con su alternativa descartada, §11 la deuda técnica |
| **Entender el proceso sin leer código** | [modulo/skill/registro-contratos/SKILL.md](modulo/skill/registro-contratos/SKILL.md) — las reglas de negocio en prosa, sin una línea de código |
| **Ver que no inventé nada** | [SUPUESTOS.md](SUPUESTOS.md) — treinta supuestos sobre lo que el PRD no resuelve, cada uno con su porqué y lo que descarté |

El prompt del §11 del PRD, para pegar tal cual en una sesión nueva:

```
Procesa el buzón de contratos con fecha de hoy 2026-09-03. Registra lo que
esté limpio, muéstrame lo que requiere revisión campo por campo y termina
con el reporte de alertas. No registres nada dudoso sin preguntarme.
```

---

## Lo que hay que mirar

- **El flujo no se puede atajar.** `contratos_validar` devuelve un `comprobante`
  y `contratos_registrar` lo exige y lo recalcula: `comprobanteDe()` en
  `src/tools/contratos.ts:1434`, comprobado en `registrarValidacion()`, línea
  2291. Sin validar, no se escribe.
- **La confirmación humana la intercepta el ciclo, no la negocia el modelo.**
  `ejecutarLote()` en `src/agente/ciclo.ts:437` detiene la llamada antes de
  ejecutarla; qué se detiene lo fija `EXIGEN_APROBACION` en
  `src/registro.ts:43`, y hoy es una sola herramienta.
- **117 verificaciones, ninguna necesita clave ni red.** `pnpm prueba` las corre
  todas más el typecheck. La única que sale a internet es `pnpm humo`.
- **El fixture nunca se modifica.** Se compara su huella —ruta, tamaño y fecha—
  antes y después de toda la suite: `prueba-contratos.ts:1942`. Y que **solo** se
  escribe en `out/`, en la línea 2239.

---

## Arranque

Requisitos: **Node 22 o superior** y **pnpm**, que viene con corepack.

```powershell
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
```

Copia `.env.example` a `.env` y pon tu clave:

```powershell
Copy-Item .env.example .env
```

```
OPENAI_API_KEY=sk-...
```

Levantar el agente:

```powershell
pnpm inicio
```

Queda en `http://127.0.0.1:3000`. Al arrancar comprueba que están todos los
archivos de datos y **aborta con código 1** si falta alguno: un despliegue que
responde 200 sin poder trabajar es peor que uno que no arranca.

Sin clave, y sin red, la demo completa:

```powershell
pnpm demo
```

---

## Estructura

```
src/
  tools/
    contrato.ts      contrato de herramientas: sobre JSON, zod, contención
    contratos.ts     las CINCO herramientas del dominio
    ejemplo.ts       herramientas de juguete, solo para las pruebas
    laboratorio.ts   idem: efectos y fallos provocados
  agente/
    ciclo.ts         ciclo del agente: topes, aprobación humana, log
  llm/
    adapter.ts       interfaz del proveedor (tipos)
    falso.ts         proveedor de guion, para probar sin red
    openai.ts        adaptador real: reintentos, timeout, traducción
  registro.ts        qué herramientas ve el agente y cuál exige aprobación
  server.ts          servidor HTTP, sesiones y límites
  inicio.ts          único sitio que lee el entorno y construye el adaptador

modulo/              el paquete reutilizable del bonus, y la CASA de:
  agent.md             comportamiento del agente
  skill/.../SKILL.md   reglas del proceso (RN1-RN7, escala de confianza)
  tools/contratos.ts   reexportacion de las herramientas
fixtures/reto-02/    buzón, maestro de contratos y comerciales
web/index.html       el chat, en un solo archivo sin dependencias
out/                 todo lo que se escribe. Se limpia en cada arranque
```

**Nada se escribe fuera de `out/`.** Es el invariante de seguridad central y hay
una verificación que toma la huella del árbol del proyecto, corre el flujo
completo y exige que solo haya cambiado `out/`.

### Las cinco herramientas

| Herramienta | Escribe | Aprobación humana |
|---|---|---|
| `contratos_leer_buzon` | no | no |
| `contratos_extraer` | no | no |
| `contratos_validar` | no | no |
| `contratos_registrar` | **sí** | **sí** |
| `contratos_alertas` | solo `out/alertas.md` | no |

`contratos_registrar` es la única que modifica datos del negocio y la única que
el ciclo detiene para que una persona apruebe los argumentos exactos.

---

## Verificación

```powershell
pnpm prueba
```

Corre las seis suites y el typecheck, y falla si falla cualquiera. Por separado:

| Comando | Qué verifica |
|---|---|
| `pnpm prueba-contrato` | El contrato de herramientas: sobre JSON, validación zod, contención de excepciones, clase de error. |
| `pnpm prueba-contratos` | Las cinco herramientas del dominio, el cableado del agente y los invariantes de escritura. Es la más grande. |
| `pnpm prueba-ciclo` | El ciclo: topes de iteraciones, de tiempo y de tokens; aprobación y denegación; errores de herramienta y de proveedor; coherencia del historial y del log. |
| `pnpm prueba-adaptador` | El adaptador de OpenAI: traducción en ambos sentidos, reintentos con espera creciente, timeout, y que la clave no se filtra. |
| `pnpm prueba-servidor` | El servidor HTTP: sesiones, aprobación de punta a punta, límites de gasto y de abuso, caducidad y expulsión. |
| `pnpm prueba-modulo` | El módulo reutilizable: que se importe desde fuera, sin servidor ni modelo, y que una herramienta corra de verdad. |
| `pnpm typecheck` | `tsc --noEmit` en modo estricto. No imprime nada si todo está bien. |

**Ninguna necesita clave ni red.** La única que sale a internet es `pnpm humo`, y
es explícita:

```powershell
pnpm humo
```

### Lo que las pruebas NO cubren

El front se verifica **a mano**. Hay una red de regresión estática que hace grep
sobre `web/index.html` para que no se reviertan las decisiones de maquetado, pero
no monta navegador y no sabe si la página se ve bien. Su título lo dice. Para
comprobarlo, abre el chat, estrecha la ventana y mira que el bloque de aprobación
quede siempre visible, que las tarjetas no se corten y que el historial baje solo.
Y que el contador de mensajes y el enlace **Sesion nueva** se vean a la vez: al
pulsarlo con una conversación en curso debe pedir confirmación antes de
descartarla.

---

## La API

Tres rutas. El estado de la conversación vive en el servidor, nunca en el cliente.

### `POST /api/chat`

Un turno. Dos formas de cuerpo, excluyentes:

```jsonc
// Mensaje normal. Sin sesionId, crea una sesión.
{ "sesionId": "uuid-opcional", "mensaje": "Procesa el buzón" }

// Respuesta a una acción retenida. El cliente SOLO dice sí o no:
// no puede aportar argumentos.
{ "sesionId": "uuid", "confirmacion": { "aprobada": true, "motivo": "" } }
```

Respuesta `200` con la vista completa de la sesión:

```jsonc
{
  "sesionId": "uuid",
  "eventos": [
    { "tipo": "usuario",  "texto": "..." },
    { "tipo": "agente",   "texto": "..." },
    { "tipo": "herramienta", "nombre": "contratos_validar",
      "argumentos": {}, "campos": [{ "campo": "mensaje_id", "valor": "\"msg-001\"" }],
      "ok": true, "disposicion": "ejecutada", "resumen": "..." },
    { "tipo": "pendiente", "nombre": "contratos_registrar",
      "argumentos": {}, "campos": [] },
    { "tipo": "error",  "texto": "..." },
    { "tipo": "aviso",  "texto": "..." }
  ],
  "esperandoConfirmacion": { "nombre": "...", "argumentos": {}, "campos": [] },
  "mensajesUsados": 3,  "mensajesPorSesion": 30,
  "tokensUsados": 4120, "tokensPorSesion": 120000
}
```

Los errores de proveedor llegan **dentro** de un `200`, como evento `error`: la
sesión no muere. Códigos distintos de 200: `400` mensaje demasiado largo o cuerpo
mal formado, `404` sesión inexistente o caducada, `413` cuerpo por encima del
límite de bytes.

### `GET /api/sessions/:id`

La misma vista, sin consumir un turno.

### `GET /api/health`

```json
{ "estado": "vivo", "sesiones": 0, "mensajesPorSesion": 30, "sesionesSimultaneas": 20 }
```

Nunca expone la clave ni el proveedor.

---

## Límites de gasto

Configurables en un solo sitio, `LIMITES_POR_DEFECTO` en `src/server.ts`:

| Límite | Por defecto |
|---|---|
| Mensajes por sesión | 30 |
| **Tokens por sesión** | **120 000** (`0` lo desactiva) |
| Sesiones simultáneas | 20 |
| Inactividad hasta caducar | 30 min |
| Bytes por petición | 64 KiB |
| Caracteres por mensaje | 4 000 |
| Iteraciones por turno | 25 |

El tope de tokens se comprueba **antes de cada envío** al proveedor, no solo al
empezar el turno: el historial entero se reenvía en cada iteración, así que un
turno largo cuesta mucho más que el mensaje que lo inició. El conteo sale del
`usage` que devuelve el proveedor, y cae a una estimación local cuando no viene.

---

## Docker

```powershell
pnpm build
docker run --rm -e OPENAI_API_KEY=sk-... -p 3000:3000 agente-conversacional
```

La imagen es multietapa. En la final solo viajan **node, zod y el JavaScript
compilado del agente**: sin TypeScript, sin tsx, sin las herramientas de juguete
y sin las suites de verificación. `modulo/` viaja porque el prompt y el
conocimiento viven ahí. Corre como usuario sin privilegios.

La clave **no entra en la imagen**: ni `ARG`, ni `ENV` con valor, ni `.env`
copiado. Se inyecta al arrancar el contenedor.

---

## Seguridad

- La clave vive solo en una variable de entorno del backend. No aparece en el
  front, ni en el repositorio, ni en los logs, ni en las respuestas de la API, y
  hay una verificación que lo comprueba.
- Las herramientas no ejecutan comandos de shell.
- El fixture `maestro-contratos.csv` **nunca se modifica**: se lee y, una sola
  vez, se copia a `out/sharepoint/`. Verificado por huella antes y después de
  toda la suite.
- Ningún dato personal real: los fixtures son ficticios.

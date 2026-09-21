# Agente conversacional — Registro de contratos vigentes

Reto técnico 02. Un agente que procesa un buzón de correos con contratos
adjuntos: los lee, extrae sus datos con una confianza por campo, los valida
contra un maestro, los registra **solo con aprobación humana** y produce un
reporte de riesgos.

El proceso que automatiza, las decisiones de diseño y sus límites están en
**[SOLUCION.md](SOLUCION.md)**. Los supuestos que el enunciado no resuelve —treinta,
cada uno con su porqué y sus alternativas descartadas— están en
**[SUPUESTOS.md](SUPUESTOS.md)**.

---

## Por dónde empezar a leer el código

En este orden, y son dos archivos:

1. **`src/tools/contrato.ts`** — el contrato de herramientas. Todo lo demás
   descansa aquí: el sobre JSON, la validación con zod, la contención de
   excepciones y la clasificación de fallos.
2. **`src/llm/adapter.ts`** — la interfaz del proveedor. Son solo tipos, y es
   lo que permite que el ciclo se pruebe entero sin red ni clave.

Con esos dos, el resto se lee solo.

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

Corre las cinco suites y el typecheck, y falla si falla cualquiera. Por separado:

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

# Agente conversacional

Agente conversacional en TypeScript con herramientas tipadas, ciclo de
razonamiento propio y confirmación humana interceptada por código antes de
ejecutar acciones con efecto. Servidor HTTP y chat web sin frameworks ni
dependencias de cliente.

Desplegado en https://agente-conversacional.onrender.com

## Requisitos

- Node 22 o superior.
- pnpm, que se instala con corepack (viene con Node):

```
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v
```

El proyecto fija su versión en `package.json` (`packageManager`), así que
corepack usará esa y no la que tengas suelta.

Instalar dependencias:

```
pnpm install
```

## Variables de entorno

| Variable         | Obligatoria | Para qué |
| ---------------- | ----------- | -------- |
| `OPENAI_API_KEY` | Sí          | Clave de OpenAI. Sin ella, el adaptador falla al construirse, con un mensaje claro, no al primer mensaje del usuario. |
| `PORT`           | No          | Puerto de escucha. Es la que inyectan los servicios de despliegue. |
| `PUERTO`         | No          | Puerto de escucha, alternativa cómoda en local. |
| `HOST`           | No          | Interfaz donde escuchar. |

Orden de precedencia:

- Puerto: `PORT` > `PUERTO` > `3000`.
- Bind: `HOST` > `127.0.0.1`.

El bind por defecto es solo loopback a propósito. Para exponerlo —dentro de
un contenedor, por ejemplo— hay que pedirlo explícitamente con
`HOST=0.0.0.0`. La imagen Docker ya lo trae puesto.

## Configurar la clave

```
Copy-Item .env.example .env
```

Y edita `.env` poniendo tu clave detrás del `=`:

```
OPENAI_API_KEY=sk-...
```

`.env` está en `.gitignore` y no se sube nunca. El `.env` se carga con el
flag nativo de Node (`--env-file-if-exists`) desde el script de arranque: no
hay ninguna librería de configuración en el proyecto.

## Levantar en local

```
pnpm inicio
```

Se abre en http://127.0.0.1:3000

## Verificación

Cinco scripts propios, sin framework de testing. **Los cinco corren sin
clave y sin red**: el proveedor de modelo se sustituye por uno falso de
guion, y el adaptador se prueba contra un servidor HTTP levantado dentro del
propio script.

| Comando                | Qué comprueba |
| ---------------------- | ------------- |
| `pnpm prueba-contrato` | El contrato de herramientas: sobre JSON, validación zod, contención de excepciones, clase de error. |
| `pnpm prueba-ciclo`    | El ciclo del agente: tope de iteraciones, tope de tiempo por turno, confirmación y denegación, errores de herramienta y de proveedor, coherencia del historial y del log. |
| `pnpm prueba-adaptador`| El adaptador de OpenAI: traducción en las dos direcciones, reintentos con espera creciente, clasificación de errores, timeout, y que la clave no se filtra. |
| `pnpm prueba-servidor` | El servidor HTTP: sesiones, confirmación de punta a punta, límites de gasto y de abuso, caducidad y expulsión de sesiones. |
| `pnpm typecheck`       | `tsc --noEmit` en modo estricto. No imprime nada si todo está bien. |

Cada script imprime sus verificaciones numeradas con PASA o FALLA, termina
con `N de M verificaciones pasan` y sale con código distinto de cero si
alguna falla.

Además:

```
pnpm demo
```

Llama a todas las herramientas a través del contrato e imprime el sobre de
cada una. Sin clave, sin red y sin levantar el servidor.

### El único que sale a la red

```
pnpm humo
pnpm humo gpt-5.5
```

`pnpm humo` **sí usa la clave real y sí llama a la API de OpenAI**. Es una
prueba de humo de tres pasos: texto simple, petición con herramientas, y el
JSON crudo de la respuesta para ver el formato real de `tool_calls`. Acepta
el modelo como argumento.

## Docker

```
docker build -t agente-conversacional .
docker run --rm -e OPENAI_API_KEY=tu-clave -p 3000:3000 agente-conversacional
```

La imagen no contiene la clave en ninguna capa: se inyecta al arrancar. Eso
sí, pasarla en el propio comando la deja escrita en el historial del shell;
sirve para probar en local, pero en un despliegue la clave va como variable
de entorno del servicio.
Construcción en tres etapas —compilar, dependencias de producción, imagen
final—, así que en la imagen que corre solo hay `node`, `zod` y el
JavaScript compilado; ni `tsx`, ni `typescript`, ni `esbuild`. Corre con
usuario sin privilegios y ya trae `HOST=0.0.0.0`.

## Estructura

```
src/tools/      Herramientas y su contrato. No sabe nada del servidor ni del modelo.
src/agente/     El ciclo del agente. Solo conoce la interfaz de proveedor, ningún proveedor concreto.
src/llm/        La interfaz del adaptador, el proveedor falso de guion y el de OpenAI.
src/server.ts   Servidor HTTP con node:http. Recibe el adaptador y el registro por inyección.
src/inicio.ts   Arranque local. El único sitio que construye el adaptador real y lee el entorno.
agent/          System prompt en Markdown. Lo lee el servidor de disco, no está embebido en el código.
web/            El chat, un único index.html sin framework, sin build y sin CDN.
out/            Registro de llamadas en JSONL. Se limpia en cada arranque. No se versiona.
```

Las capas están separadas para poder verificarlas por su cuenta. El contrato
de herramientas se prueba sin ciclo; el ciclo se prueba sin proveedor real;
el servidor se prueba con un proveedor falso inyectado. Ninguna prueba
necesita clave ni red, y por eso se pueden correr todas en cualquier
momento.

Los scripts de verificación viven en la raíz (`prueba-*.ts`, `demo.ts`) y
`tsconfig.json` los incluye en el typecheck.

## Estado

Las herramientas de `src/tools/ejemplo.ts` y `src/tools/laboratorio.ts` son
**provisionales**, están marcadas como tales en el propio código y existen
para ejercitar el contrato y el ciclo. Las herramientas del dominio real
están pendientes.

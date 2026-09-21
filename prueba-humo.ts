import { AdaptadorOpenAI, MODELO_POR_DEFECTO } from "./src/llm/openai.js";
import { esErrorProveedor, type Mensaje } from "./src/llm/adapter.js";
import { declarar, registrar } from "./src/tools/contrato.js";
import { eco } from "./src/tools/laboratorio.js";

/**
 * Prueba de humo. ES EL UNICO script que sale a la red y usa la clave real.
 * Todo lo demas del proyecto corre sin clave y sin red.
 *
 * Uso:  pnpm humo            -> usa el modelo por defecto
 *       pnpm humo gpt-5.5    -> usa el modelo que le pases
 *
 * La clave se lee de OPENAI_API_KEY (via --env-file-if-exists) dentro del
 * adaptador, y no se imprime aqui en ningun caso.
 */

const modelo = process.argv[2] ?? MODELO_POR_DEFECTO;
const registro = registrar("laboratorio.ts", { eco });
const declaraciones = declarar(registro);

function describirFallo(causa: unknown): string {
  if (esErrorProveedor(causa)) {
    const grado = causa.recuperable ? "recuperable" : "no recuperable";
    return `ErrorProveedor (${grado}, codigo ${causa.codigo}): ${causa.message}`;
  }
  if (causa instanceof Error) {
    return `${causa.name}: ${causa.message}`;
  }
  return String(causa);
}

let fallos = 0;

console.log(`Modelo bajo prueba: ${modelo}`);
console.log(`Herramientas declaradas: ${declaraciones.map((d) => d.name).join(", ")}`);
console.log("");

const adaptador = new AdaptadorOpenAI({ modelo });

// a. Texto simple, sin herramientas.
console.log("a) Peticion de texto simple, sin herramientas");
try {
  const respuesta = await adaptador.enviar(
    [{ rol: "usuario", texto: "Di solamente: hola desde la prueba de humo." }],
    [],
  );
  console.log(`   tipo: ${respuesta.tipo}`);
  console.log(`   texto: ${respuesta.tipo === "texto" ? respuesta.texto : "(vino con llamadas)"}`);
} catch (causa: unknown) {
  fallos += 1;
  console.log(`   FALLO -> ${describirFallo(causa)}`);
}
console.log("");

// b. Con herramientas declaradas, empujando a que use eco.
const MENSAJES_CON_HERRAMIENTA: readonly Mensaje[] = [
  {
    rol: "usuario",
    texto:
      "Usa la herramienta laboratorio_eco con el texto 'hola' y no respondas nada mas.",
  },
];

console.log("b) Peticion con herramientas declaradas, pidiendo que use eco");
try {
  const respuesta = await adaptador.enviar(
    MENSAJES_CON_HERRAMIENTA,
    declaraciones,
  );
  console.log(`   tipo: ${respuesta.tipo}`);
  if (respuesta.tipo === "llamadas") {
    for (const llamada of respuesta.llamadas) {
      console.log(
        `   llamada: id=${llamada.id} nombre=${llamada.nombre} tipoArgumentos=${typeof llamada.argumentos} argumentos=${JSON.stringify(llamada.argumentos)}`,
      );
    }
  } else {
    console.log(`   texto: ${respuesta.texto}`);
    console.log("   (el modelo no pidio ninguna herramienta)");
  }
} catch (causa: unknown) {
  fallos += 1;
  console.log(`   FALLO -> ${describirFallo(causa)}`);
}
console.log("");

// c. El JSON crudo del caso b, para ver el formato real de tool_calls.
// Se arma aqui a mano a proposito: el objetivo es ver lo que devuelve la
// API sin pasar por la traduccion del adaptador.
console.log("c) JSON crudo de la respuesta de OpenAI para el caso b");
try {
  const respuesta = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env["OPENAI_API_KEY"] ?? ""}`,
    },
    body: JSON.stringify({
      model: modelo,
      messages: [
        {
          role: "user",
          content:
            "Usa la herramienta laboratorio_eco con el texto 'hola' y no respondas nada mas.",
        },
      ],
      tools: declaraciones.map((declaracion) => ({
        type: "function",
        function: {
          name: declaracion.name,
          description: declaracion.description,
          parameters: declaracion.input_schema,
        },
      })),
      tool_choice: "auto",
    }),
  });
  const texto = await respuesta.text();
  console.log(`   estado HTTP: ${respuesta.status}`);
  try {
    console.log(JSON.stringify(JSON.parse(texto) as unknown, null, 2));
  } catch {
    console.log(texto);
  }
  if (!respuesta.ok) {
    fallos += 1;
  }
} catch (causa: unknown) {
  fallos += 1;
  console.log(`   FALLO -> ${describirFallo(causa)}`);
}

console.log("");
console.log(
  fallos === 0
    ? `Humo limpio con ${modelo}: los tres pasos respondieron.`
    : `Humo con ${fallos} paso(s) en fallo usando ${modelo}.`,
);
if (fallos > 0) {
  process.exitCode = 1;
}

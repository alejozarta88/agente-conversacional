import { z } from "zod";

/**
 * Contrato de herramientas.
 *
 * Una herramienta es un objeto con tres campos: description, args (esquema
 * zod con .describe() en cada campo) y execute (recibe los argumentos ya
 * validados). execute devuelve SIEMPRE un string JSON con el sobre
 * {"ok":true,"data":...} o {"ok":false,"error":"..."}, nunca un objeto.
 */

/** Esquema de argumentos: siempre un objeto zod. */
export type EsquemaArgumentos = z.ZodObject;

export interface Herramienta<E extends EsquemaArgumentos> {
  /** Lo que el modelo lee para decidir si la usa. */
  description: string;
  /** Esquema zod; cada campo lleva .describe(). */
  args: E;
  /** Recibe los argumentos YA validados. Devuelve el string JSON del sobre. */
  execute: (argumentos: z.infer<E>) => string | Promise<string>;
}

/**
 * Herramienta ya cerrada sobre su esquema: los genericos quedan adentro, asi
 * el registro puede ser homogeneo sin recurrir a any ni a castings.
 */
export interface HerramientaPreparada {
  readonly description: string;
  readonly args: EsquemaArgumentos;
  /** Valida y ejecuta. Puede lanzar: la contencion vive en ejecutar(). */
  readonly validarYEjecutar: (argumentosCrudos: unknown) => Promise<string>;
}

export type Registro = Readonly<Record<string, HerramientaPreparada>>;

/**
 * Clase de fallo. Union cerrada: es lo que hace el sobre de error legible
 * por maquina, sin que nadie tenga que reconocer textos.
 *
 * Las cuatro primeras las emite ejecutar(); la quinta la emite la
 * herramienta a traves de respuestaError(), y si no la declara, ejecutar()
 * la completa como error_herramienta.
 *
 * NO viaja en la declaracion de herramientas que ve el modelo: es para el
 * log y para quien llama.
 */
export type ClaseError =
  /** Fallo la validacion zod. */
  | "argumentos_invalidos"
  /** El nombre no esta en el registro. */
  | "herramienta_desconocida"
  /** execute lanzo y ejecutar() lo capturo. */
  | "excepcion_contenida"
  /** execute devolvio algo que no es un sobre valido. */
  | "sobre_invalido"
  /** La herramienta devolvio ok:false a proposito. */
  | "error_herramienta";

const CLASES_ERROR: readonly ClaseError[] = [
  "argumentos_invalidos",
  "herramienta_desconocida",
  "excepcion_contenida",
  "sobre_invalido",
  "error_herramienta",
];

export function esClaseError(valor: unknown): valor is ClaseError {
  return (
    typeof valor === "string" &&
    (CLASES_ERROR as readonly string[]).includes(valor)
  );
}

/** Sobre de exito. Sin cambios: nunca lleva clase. */
export function respuestaOk(data: unknown): string {
  return JSON.stringify({ ok: true, data: data === undefined ? null : data });
}

/** Sobre de error. Por defecto, el fallo deliberado de una herramienta. */
export function respuestaError(
  error: string,
  clase: ClaseError = "error_herramienta",
): string {
  return JSON.stringify({ ok: false, error, clase });
}

function describirFallo(error: z.ZodError): string {
  const campos = error.issues.map((incidencia) => {
    const ruta = incidencia.path.map((parte) => String(parte)).join(".");
    return `${ruta === "" ? "(raiz)" : ruta}: ${incidencia.message}`;
  });
  return `argumentos invalidos -> ${campos.join("; ")}`;
}

function describirExcepcion(causa: unknown): string {
  if (causa instanceof Error) {
    return `${causa.name}: ${causa.message}`;
  }
  return `excepcion no-Error: ${String(causa)}`;
}

/**
 * Toma el objeto de tres campos y lo convierte en HerramientaPreparada.
 * Aqui es donde se aplica la validacion zod antes de tocar execute.
 */
export function definir<E extends EsquemaArgumentos>(
  herramienta: Herramienta<E>,
): HerramientaPreparada {
  return {
    description: herramienta.description,
    args: herramienta.args,
    validarYEjecutar: async (argumentosCrudos: unknown): Promise<string> => {
      const resultado = herramienta.args.safeParse(argumentosCrudos);
      if (!resultado.success) {
        return respuestaError(
          describirFallo(resultado.error),
          "argumentos_invalidos",
        );
      }
      return await herramienta.execute(resultado.data);
    },
  };
}

/**
 * Arma el registro con los nombres <archivo>_<export>.
 * El archivo puede venir con o sin extension: "matematica" y "matematica.ts"
 * producen el mismo prefijo.
 */
export function registrar(
  archivo: string,
  exports: Readonly<Record<string, HerramientaPreparada>>,
): Registro {
  const prefijo = archivo.replace(/\.[cm]?[jt]s$/u, "");
  const registro: Record<string, HerramientaPreparada> = {};
  for (const [exportado, herramienta] of Object.entries(exports)) {
    registro[`${prefijo}_${exportado}`] = herramienta;
  }
  return registro;
}

/** Une varios registros parciales en uno solo. */
export function combinar(...registros: readonly Registro[]): Registro {
  return Object.assign({}, ...registros) as Registro;
}

/**
 * Unico punto de entrada para invocar una herramienta.
 * Nunca lanza: todo camino de fallo sale como string de error.
 */
export async function ejecutar(
  registro: Registro,
  nombre: string,
  argumentosCrudos: unknown,
): Promise<string> {
  const herramienta = registro[nombre];
  if (herramienta === undefined) {
    const conocidas = Object.keys(registro).join(", ");
    return respuestaError(
      `herramienta desconocida: "${nombre}". Disponibles: ${conocidas === "" ? "(ninguna)" : conocidas}`,
      "herramienta_desconocida",
    );
  }

  let crudo: string;
  try {
    crudo = await herramienta.validarYEjecutar(argumentosCrudos);
  } catch (causa: unknown) {
    return respuestaError(
      `la herramienta "${nombre}" lanzo -> ${describirExcepcion(causa)}`,
      "excepcion_contenida",
    );
  }

  return normalizarSobre(nombre, crudo);
}

/**
 * execute puede estar mal escrita y devolver algo que no es el sobre. En vez
 * de dejar que eso llegue al modelo, se convierte en un error explicito.
 * De paso completa la clase del sobre de error cuando la herramienta no la
 * declaro.
 */
function normalizarSobre(nombre: string, crudo: unknown): string {
  if (typeof crudo !== "string") {
    return respuestaError(
      `la herramienta "${nombre}" devolvio ${typeof crudo} en vez de un string JSON`,
      "sobre_invalido",
    );
  }
  let analizado: unknown;
  try {
    analizado = JSON.parse(crudo);
  } catch {
    return respuestaError(
      `la herramienta "${nombre}" devolvio un string que no es JSON valido`,
      "sobre_invalido",
    );
  }
  if (typeof analizado !== "object" || analizado === null) {
    return respuestaError(
      `la herramienta "${nombre}" devolvio un JSON que no es un objeto`,
      "sobre_invalido",
    );
  }
  const sobre = analizado as {
    ok?: unknown;
    error?: unknown;
    clase?: unknown;
  };
  if (typeof sobre.ok !== "boolean") {
    return respuestaError(
      `la herramienta "${nombre}" devolvio un JSON sin el campo booleano "ok"`,
      "sobre_invalido",
    );
  }
  if (sobre.ok) {
    return crudo;
  }
  if (esClaseError(sobre.clase)) {
    return crudo;
  }
  // Sobre de error sin clase declarada: es un fallo deliberado.
  return respuestaError(
    typeof sobre.error === "string" ? sobre.error : "error sin descripcion",
    "error_herramienta",
  );
}

/** Formato de declaracion de herramientas que espera el modelo. */
export interface DeclaracionHerramienta {
  name: string;
  description: string;
  input_schema: z.core.JSONSchema.BaseSchema;
}

/** Deriva las declaraciones desde los esquemas zod del registro. */
export function declarar(registro: Registro): DeclaracionHerramienta[] {
  return Object.entries(registro).map(([name, herramienta]) => ({
    name,
    description: herramienta.description,
    input_schema: z.toJSONSchema(herramienta.args, {
      target: "draft-7",
      io: "input",
    }),
  }));
}

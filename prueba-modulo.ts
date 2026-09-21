import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// IMPORTANTE: este archivo importa SOLO desde modulo\, nunca desde src\.
//
// Es la prueba de que el modulo se puede consumir de fuera. Si alguna vez
// hiciera falta importar algo de src\ para que funcione, el modulo no seria
// reutilizable y esta verificacion habria dejado de probar lo que dice.
// ---------------------------------------------------------------------------
import {
  alertas,
  extraer,
  leer_buzon,
  registrar,
  validar,
} from "./modulo/tools/contratos.js";

/**
 * Verificacion del modulo reutilizable (PRD 9.4).
 *
 * Un modulo que nadie ha reutilizado no esta probado. Esto lo consume como
 * lo haria alguien ajeno al proyecto: importando de modulo\, sin servidor,
 * sin ciclo, sin registro de herramientas, sin proveedor y sin clave.
 *
 * Sin framework. Sale con codigo distinto de cero si algo falla.
 */

const RAIZ_MODULO = "modulo";
const RUTA_AGENTE = join(RAIZ_MODULO, "agent.md");
const RUTA_SKILL = join(
  RAIZ_MODULO,
  "skill",
  "registro-contratos",
  "SKILL.md",
);
const RUTA_HERRAMIENTAS = join(RAIZ_MODULO, "tools", "contratos.ts");

let pasan = 0;
let total = 0;

function verificar(titulo: string, pasa: boolean, detalle: string): void {
  total += 1;
  if (pasa) {
    pasan += 1;
  }
  console.log(`${total}. ${pasa ? "PASA" : "FALLA"} - ${titulo}`);
  console.log(`   ${detalle}`);
}

interface Sobre {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function leerSobre(crudo: string): Sobre {
  const analizado: unknown = JSON.parse(crudo);
  if (typeof analizado !== "object" || analizado === null) {
    return { ok: false, error: "sobre ilegible" };
  }
  return analizado as Sobre;
}

function campo(valor: unknown, clave: string): unknown {
  if (typeof valor !== "object" || valor === null) {
    return undefined;
  }
  return (valor as Record<string, unknown>)[clave];
}

/** Frontmatter YAML de un documento del modulo, como texto crudo. */
function frontmatter(texto: string): string | null {
  if (!texto.startsWith("---")) {
    return null;
  }
  const lineas = texto.split(/\r?\n/u);
  for (let indice = 1; indice < lineas.length; indice += 1) {
    if ((lineas[indice] ?? "").trim() === "---") {
      return lineas.slice(1, indice).join("\n");
    }
  }
  return null;
}

/** Huella de un arbol: ruta, tamano y fecha de modificacion. */
function huella(raiz: string): string {
  if (!existsSync(raiz)) {
    return "(no existe)";
  }
  const lineas: string[] = [];
  const recorrer = (directorio: string): void => {
    for (const entrada of readdirSync(directorio, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const ruta = join(directorio, entrada.name);
      if (entrada.isDirectory()) {
        recorrer(ruta);
        continue;
      }
      const info = statSync(ruta);
      lineas.push(`${ruta}|${info.size}|${info.mtimeMs}`);
    }
  };
  recorrer(raiz);
  return lineas.join("\n");
}

async function principal(): Promise<void> {
  // El estado de salida lo limpia el ARNES, no el modulo: sin esto la
  // suite dependeria de lo que dejara la corrida anterior.
  for (const entrada of ["sharepoint", "procesados.json", "alertas.md"]) {
    rmSync(join("out", entrada), { recursive: true, force: true });
  }

  console.log("Consumiendo modulo\\ como lo haria alguien de fuera.");
  console.log("Sin servidor, sin ciclo, sin registro, sin proveedor, sin clave.");
  console.log("");

  // 1. Las tres piezas que exige el PRD 9.4 existen.
  {
    const faltan = [RUTA_AGENTE, RUTA_SKILL, RUTA_HERRAMIENTAS].filter(
      (ruta) => !existsSync(ruta),
    );
    verificar(
      "modulo\\ tiene las tres piezas: agent.md, tools\\ y skill\\",
      faltan.length === 0,
      faltan.length === 0
        ? `${RUTA_AGENTE}, ${RUTA_HERRAMIENTAS}, ${RUTA_SKILL}`
        : `faltan: ${faltan.join(", ")}`,
    );
  }

  // 2. Frontmatter con lo que el PRD pide en cada pieza.
  {
    const agente = frontmatter(readFileSync(RUTA_AGENTE, "utf8")) ?? "";
    const skill = frontmatter(readFileSync(RUTA_SKILL, "utf8")) ?? "";
    const problemas: string[] = [];
    for (const clave of ["description", "mode: primary", "edit: deny", "bash: deny"]) {
      if (!agente.includes(clave)) {
        problemas.push(`agent.md sin ${clave}`);
      }
    }
    for (const clave of ["name:", "description"]) {
      if (!skill.includes(clave)) {
        problemas.push(`SKILL.md sin ${clave}`);
      }
    }
    verificar(
      "el frontmatter declara lo que el PRD 9.4 exige en cada pieza",
      problemas.length === 0,
      problemas.length === 0
        ? "agent.md: description, mode: primary, permission {edit: deny, bash: deny} | SKILL.md: name, description"
        : problemas.join("; "),
    );
  }

  // 3. Las cinco herramientas se importan y tienen la forma del contrato.
  {
    const herramientas = {
      leer_buzon,
      extraer,
      validar,
      registrar,
      alertas,
    };
    const problemas: string[] = [];
    for (const [nombre, herramienta] of Object.entries(herramientas)) {
      if (typeof herramienta.description !== "string") {
        problemas.push(`${nombre}: sin description`);
      }
      if (typeof herramienta.validarYEjecutar !== "function") {
        problemas.push(`${nombre}: sin validarYEjecutar`);
      }
      if (herramienta.args === undefined) {
        problemas.push(`${nombre}: sin esquema de argumentos`);
      }
    }
    verificar(
      "las cinco herramientas se importan del modulo y cumplen el contrato",
      problemas.length === 0,
      problemas.length === 0
        ? `${Object.keys(herramientas).join(", ")}`
        : problemas.join("; "),
    );
  }

  // 4. Una herramienta CORRE de verdad, sin nada del resto del proyecto.
  {
    const sobre = leerSobre(await leer_buzon.validarYEjecutar({}));
    const mensajes = campo(sobre.data, "mensajes");
    const cuantos = Array.isArray(mensajes) ? mensajes.length : -1;
    verificar(
      "leer_buzon corre sin servidor ni registro y devuelve el buzon",
      sobre.ok === true && cuantos === 6,
      sobre.ok
        ? `ok:true con ${cuantos} mensajes, invocada como herramienta.validarYEjecutar({})`
        : `ok:false -> ${sobre.error ?? ""}`,
    );
  }

  // 5. Y el flujo de lectura completo: extraer + validar encadenados.
  {
    const extraccion = leerSobre(
      await extraer.validarYEjecutar({ mensaje_id: "msg-001" }),
    );
    const juicio = leerSobre(
      await validar.validarYEjecutar({ mensaje_id: "msg-001" }),
    );
    const clasificacion = campo(juicio.data, "clasificacion");
    const comprobante = campo(juicio.data, "comprobante");
    verificar(
      "extraer y validar encadenados desde el modulo dan el resultado esperado",
      extraccion.ok === true &&
        juicio.ok === true &&
        campo(extraccion.data, "tipo_documento") === "contrato" &&
        clasificacion === "nuevo" &&
        typeof comprobante === "string" &&
        comprobante.length > 0,
      `msg-001: tipo=${String(campo(extraccion.data, "tipo_documento"))} clasificacion=${String(clasificacion)} comprobante=${String(comprobante).slice(0, 8)}...`,
    );
  }

  // 6. La validacion de argumentos viaja con la herramienta.
  {
    const sobre = leerSobre(
      await extraer.validarYEjecutar({ mensaje_id: 42 }),
    );
    verificar(
      "zod valida los argumentos tambien fuera del servidor",
      sobre.ok === false && (sobre.error ?? "").includes("mensaje_id"),
      `ok:false -> ${(sobre.error ?? "").slice(0, 90)}`,
    );
  }

  // 7. Ninguna herramienta de solo lectura escribio nada.
  {
    const antesFixtures = huella("fixtures");
    const antesSalida = huella("out");
    await leer_buzon.validarYEjecutar({});
    await extraer.validarYEjecutar({ mensaje_id: "msg-003" });
    await validar.validarYEjecutar({ mensaje_id: "msg-003" });
    const problemas: string[] = [];
    if (huella("fixtures") !== antesFixtures) {
      problemas.push("el arbol fixtures cambio");
    }
    if (huella("out") !== antesSalida) {
      problemas.push("el arbol out cambio");
    }
    verificar(
      "leer_buzon, extraer y validar no escriben, tambien consumidas desde el modulo",
      problemas.length === 0,
      problemas.length === 0
        ? "fixtures y out identicos por huella tras tres llamadas"
        : problemas.join("; "),
    );
  }

  // 8. El modulo NO arrastra el servidor ni el proveedor.
  {
    const fuente = readFileSync(RUTA_HERRAMIENTAS, "utf8");
    const prohibidos = ["server.js", "ciclo.js", "openai.js", "adapter.js"].filter(
      (aguja) => fuente.includes(`from "${aguja}`) || fuente.includes(`/${aguja}"`),
    );
    // Y la reexportacion no tiene logica propia: no puede divergir.
    const lineasDeCodigo = fuente
      .split(/\r?\n/u)
      .filter((linea) => {
        const limpia = linea.trim();
        return (
          limpia !== "" &&
          !limpia.startsWith("*") &&
          !limpia.startsWith("/*") &&
          !limpia.startsWith("//")
        );
      });
    const soloReexporta = lineasDeCodigo.every((linea) => {
      const limpia = linea.trim();
      return (
        limpia.startsWith("export") ||
        limpia.startsWith("}") ||
        limpia.startsWith("from ") ||
        /^[A-Za-z_][A-Za-z0-9_]*,?$/u.test(limpia)
      );
    });
    verificar(
      "el modulo no arrastra servidor ni proveedor, y no tiene logica propia",
      prohibidos.length === 0 && soloReexporta,
      prohibidos.length === 0 && soloReexporta
        ? `${lineasDeCodigo.length} lineas, todas de reexportacion: no hay nada de que divergir`
        : `arrastra: ${prohibidos.join(", ")}; soloReexporta=${soloReexporta}`,
    );
  }

  console.log("");
  console.log(`${pasan} de ${total} verificaciones pasan`);
  if (pasan !== total) {
    process.exitCode = 1;
  }
}

await principal();

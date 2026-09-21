# Imagen del agente conversacional.
#
# Tres etapas: dependencias completas para compilar, dependencias de
# produccion, y una final que solo lleva JavaScript ya compilado.
#
# La clave NO entra aqui: ni ARG, ni ENV con valor, ni .env copiado. Se
# inyecta al arrancar el contenedor con -e OPENAI_API_KEY=...

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# --- Etapa 1: compilar TypeScript a JavaScript -------------------------
# node_modules se instala AQUI DENTRO, en Linux. El del host es Windows y
# esta excluido en .dockerignore, asi que pnpm resuelve el binario de
# esbuild que toca (@esbuild/linux-*) desde el lockfile y nunca se arrastra
# el de win32.
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm exec tsc -p tsconfig.build.json

# --- Etapa 2: solo dependencias de produccion --------------------------
# Deja fuera typescript, tsx y esbuild: la imagen final corre node a secas.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

# --- Etapa 3: imagen final ---------------------------------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
# Bind abierto: dentro de un contenedor, 127.0.0.1 no lo alcanza nadie.
# El puerto real lo decide PORT si el servicio de despliegue lo inyecta.
ENV HOST=0.0.0.0
WORKDIR /app

# --chown en cada COPY, no un chown -R despues: un chown recursivo
# reescribe cada archivo en una capa nueva y duplica su peso.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node web ./web
COPY --chown=node:node agent ./agent

# out\ se limpia y se reescribe en cada arranque: tiene que ser escribible
# por el usuario sin privilegios.
RUN mkdir -p /app/out && chown node:node /app/out /app

USER node
EXPOSE 3000

CMD ["node", "dist/inicio.js"]

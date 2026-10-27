# Remote (Streamable HTTP) ImageAT MCP server — deploy target for e.g. mcp.imageat.com.
# The stdio entry (npx @imageat/mcp) does not need this; this image runs dist/http.js.
#
# Build context is THIS DIRECTORY (mcp-server/), not the repository root — the build
# needs nothing from outside it, and Dokploy builds with the app's own directory as
# context. Keep every COPY below relative to mcp-server/.
#   docker build -t imageat-mcp mcp-server/
FROM node:24.22.1-alpine

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# Build the TypeScript sources.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
# IMAGEAT_BASE_URL defaults to https://imageat.com; override if needed.
EXPOSE 8787

CMD ["node", "dist/http.js"]

# Remote (Streamable HTTP) ImageAT MCP server — deploy target for e.g. mcp.imageat.com.
# The stdio entry (npx @imageat/mcp) does not need this; this image runs dist/http.js.
FROM node:20-alpine

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

# ---------- Base ----------
FROM node:20-alpine AS base
WORKDIR /app

# ---------- Dependencies ----------
FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

# ---------- Runner (Dev) ----------
FROM base AS runner
WORKDIR /app

# Copy deps
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./

# Copy source
COPY . .

EXPOSE 8081

CMD ["npm", "start"]

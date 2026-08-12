FROM node:20-alpine AS builder

WORKDIR /app

COPY shared/package.json ./shared/
COPY backend/package.json ./backend/

WORKDIR /app/backend
RUN npm install

COPY shared/ ../shared/
COPY backend/ .

RUN npm run build

FROM node:20-alpine AS runner

WORKDIR /app/backend

ENV NODE_ENV=production

COPY shared/ /app/shared/
COPY backend/package.json ./
RUN npm install --omit=dev

COPY --from=builder /app/backend/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]

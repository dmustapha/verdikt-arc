FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV PORT=8080
ENV APP_ENTRY=facilitator
EXPOSE 8080
# One image, two apps: APP_ENTRY=seller runs the x402 seller, else the facilitator.
CMD ["sh", "-c", "if [ \"$APP_ENTRY\" = \"seller\" ]; then exec npx tsx src/seller.ts; else exec npx tsx src/server.ts; fi"]

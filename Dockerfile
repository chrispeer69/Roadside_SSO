# Roadside SSO - single service: API + OIDC provider + built portal
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/portal/package.json apps/portal/package.json
COPY packages/auth/package.json packages/auth/package.json
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app /app
RUN npm prune --omit=dev
EXPOSE 8787
CMD ["node", "apps/api/src/index.js"]

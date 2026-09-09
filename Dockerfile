FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# مجلد البيانات يُركَّب من الخارج (volume) حتى تبقى القاعدة بعد تحديث النظام
RUN mkdir -p data backups uploads
VOLUME ["/app/data", "/app/backups"]

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]

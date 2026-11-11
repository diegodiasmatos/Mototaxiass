# Assis MotoTáxi — imagem de produção.
# Funciona em Render, Railway, Fly.io, Koyeb, Google Cloud Run ou qualquer VPS com Docker.
FROM node:24-alpine

WORKDIR /app

# Sem dependências npm: basta copiar o código.
COPY package.json ./
COPY server ./server
COPY public ./public
COPY tools ./tools

# Banco, documentos e segredo de sessão vivem aqui.
# Monte um disco persistente neste caminho (ver README).
ENV DATA_DIR=/data
ENV PORT=8780
RUN mkdir -p /data

EXPOSE 8780

# Checagem de saúde: a plataforma reinicia o container se a API parar de responder.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8780)+'/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.ts"]

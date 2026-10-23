# Anonymous Messenger

Messenger anônimo com mensagens criptografadas ponta a ponta (AES-256-GCM no navegador).

## Rodar

```
docker compose up --build
```

Acesse http://localhost:3045 (API direta em http://localhost:3046, só na máquina local; WebCrypto exige `localhost` ou HTTPS).

## Como funciona

- Conta = login + senha (mínimo 6 caracteres, sem e-mail). Usuários e amizades ficam no SQLite (volume `db-data`).
- Adicionar amigo pelo login envia um pedido; a amizade só existe depois que a outra pessoa aceita (ou se os dois se adicionarem). Dá para remover amigos e bloquear (quem foi bloqueado não é avisado).
- Mensagens ficam no SQLite do backend, apenas cifradas, sem limite de quantidade. Qualquer um dos dois lados pode apagar a conversa permanentemente pelo botão "Limpar chat".
- A **chave da conversa** é digitada por cada um dos dois lados e fica só em memória no navegador (nunca é gravada; precisa ser digitada de novo após recarregar a página). Ela deriva (PBKDF2) uma chave AES-GCM; o servidor só vê texto cifrado.
- Sem chave, ou com chave errada, a mensagem aparece como 🔒.

## Dev local

```
cd backend && npm install && npm start
cd frontend && npm install && npm run dev
```

## Segurança

- SQL sempre parametrizado; senhas com scrypt (assíncrono); verificação de senha em tempo constante também para logins inexistentes.
- Sessão = token aleatório em cookie `HttpOnly` + `SameSite=Strict`; só o hash fica no banco, então o logout revoga de verdade (7 dias de validade). O WebSocket usa o mesmo cookie, sem token na URL.
- Checagem de `Origin` nas requisições de escrita e no WebSocket; CSP restritiva no nginx; `helmet` no backend.
- Limites: tentativas de login/cadastro por IP, pedidos de amizade, envio de mensagens, usuários (`MAX_USERS`), amigos, sockets por usuário e tamanho de cada mensagem (1 MB).

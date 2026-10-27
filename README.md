# Anonymous Messenger

Messenger anônimo com mensagens criptografadas ponta a ponta (AES-256-GCM no navegador).

## Rodar

```
docker compose up --build
```

Acesse https://sysware.com.br/anonymous-messenger/. O Nginx do host termina o TLS e encaminha esse caminho para o frontend em `http://127.0.0.1:3045` (API direta em http://localhost:3046, só na máquina local).

Para desenvolvimento sem o Nginx do host, o frontend fica disponível em http://localhost:3045/anonymous-messenger/; WebCrypto funciona em `localhost` ou via HTTPS.

As `location`s usadas em produção estão em `deploy/nginx/anonymous-messenger.location.conf`. Esse arquivo deve ser incluído no bloco HTTPS de `sysware.com.br`.

## Como funciona

- Conta = login + senha (mínimo 6 caracteres, sem e-mail). Usuários e amizades ficam no SQLite (volume `db-data`).
- Adicionar amigo pelo login envia um pedido; a amizade só existe depois que a outra pessoa aceita (ou se os dois se adicionarem). Dá para remover amigos e bloquear (quem foi bloqueado não é avisado).
- Mensagens ficam no SQLite do backend, apenas cifradas, sem limite de quantidade. Qualquer um dos dois lados pode apagar a conversa permanentemente pelo botão "Limpar chat".
- A **chave da conversa** é digitada por cada um dos dois lados e é lembrada no `localStorage` do navegador, uma por amigo (por conta), e apagada ao clicar em Sair. Ela deriva (PBKDF2) uma chave AES-GCM; o servidor só vê texto cifrado.
- Sem chave, ou com chave errada, a mensagem aparece como 🔒.

## Mensagens de áudio e transcrição

- O botão 🎤 grava até 60 s. O áudio vai dentro da mensagem cifrada, junto com a transcrição.
- A transcrição usa o **faster-whisper** (Whisper em CPU, int8) no container `transcriber`, acessível só pelo backend. O áudio chega ao servidor **em claro**, apenas durante a transcrição; é processado em memória e descartado (nada é gravado em disco nem em log). Depois disso, áudio e texto existem só cifrados.
- Se a transcrição falhar ou demorar, o áudio é enviado sem texto.
- Modelo e idioma: `WHISPER_MODEL` (build arg: tiny, base, small, medium) e `WHISPER_LANGUAGE` (`pt` por padrão; vazio detecta sozinho) em `docker-compose.yml`. O modelo é baixado no build (~500 MB). Em CPU o `small` leva cerca de 1x a duração do áudio.

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

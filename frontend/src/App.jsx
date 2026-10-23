import { useCallback, useEffect, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { IMAGE_RE, cryptoAvailable, decryptText, encryptText, imageToDataUrl } from './crypto.js';

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (mode === 'register' && password.length < 6) {
        throw new Error('A senha deve ter no mínimo 6 caracteres');
      }
      const res = await api[mode](login, password);
      onAuth(res.login);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="auth" onSubmit={submit}>
      <h1>Anonymous Messenger</h1>
      <input placeholder="Login" value={login} onChange={(e) => setLogin(e.target.value)} autoFocus />
      <input placeholder="Senha" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      <button type="submit">{mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
      <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? 'Não tenho conta' : 'Já tenho conta'}
      </button>
    </form>
  );
}

function Chat({ me, friend, secret, onSecretChange, incoming, cleared, onBack, onRemove, onBlock }) {
  const [raw, setRaw] = useState([]);
  const [plain, setPlain] = useState({});
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [zoom, setZoom] = useState(null);
  const bottom = useRef(null);

  useEffect(() => {
    setRaw([]);
    api.messages(friend).then(setRaw).catch((e) => setError(e.message));
  }, [friend]);

  useEffect(() => {
    if (cleared > 0) setRaw([]);
  }, [cleared]);

  useEffect(() => {
    if (!incoming) return;
    const { from, to } = incoming;
    if ((from === friend && to === me) || (from === me && to === friend)) {
      setRaw((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    }
  }, [incoming, friend, me]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const next = {};
      if (secret) {
        for (const m of raw) next[m.id] = await decryptText(m.data, secret, me, friend);
      }
      if (!cancelled) setPlain(next);
    })();
    return () => { cancelled = true; };
  }, [raw, secret, me, friend]);

  useEffect(() => bottom.current?.scrollIntoView(), [raw, plain]);

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim() || !secret) return;
    setError('');
    try {
      await api.send(friend, await encryptText(text, secret, me, friend));
      setText('');
    } catch (err) {
      setError(err.message);
    }
  };

  const paste = async (e) => {
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    if (!secret) return;
    setError('');
    try {
      await api.send(friend, await encryptText(await imageToDataUrl(file), secret, me, friend));
    } catch (err) {
      setError(err.message);
    }
  };

  const clear = async () => {
    if (!window.confirm(`Apagar permanentemente todas as mensagens com ${friend}? Isso apaga para os dois lados e não pode ser desfeito.`)) return;
    setError('');
    try {
      await api.clearMessages(friend);
    } catch (err) {
      setError(err.message);
    }
  };

  const show = (m) => {
    if (!secret) return <em className="locked">🔒 {m.data.slice(0, 40)}…</em>;
    if (plain[m.id] === undefined) return '…';
    const p = plain[m.id];
    if (p == null) return <em className="locked">🔒 chave incorreta</em>;
    return IMAGE_RE.test(p) ? <img src={p} alt="imagem" onClick={() => setZoom(p)} /> : p;
  };

  return (
    <section className="chat">
      <header>
        <button type="button" className="link back" onClick={onBack}>←</button>
        <strong>{friend}</strong>
        <button type="button" className="link" onClick={onRemove}>Remover</button>
        <button type="button" className="link danger" onClick={clear}>Limpar chat</button>
        <button type="button" className="link danger" onClick={onBlock}>Bloquear</button>
        <input
          type="password"
          placeholder="Chave da conversa"
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
        />
      </header>
      <p className="notice">
        🔒 As mensagens (e imagens) são criptografadas no seu navegador. O backend nunca salva a chave da
        conversa, apenas a mensagem já criptografada. Por segurança, a chave não é memorizada em lugar nenhum:
        você precisa digitá-la toda vez que quiser ler o chat, e ela nunca é enviada ao backend. Você pode
        conferir isso na aba Rede (Network) do developer tools do navegador: nenhuma requisição contém a chave.
      </p>
      <div className="messages">
        {raw.map((m) => (
          <div key={m.id} className={`msg ${m.from === me ? 'mine' : 'theirs'}`}>
            {show(m)}
            <time>{new Date(m.ts).toLocaleTimeString()}</time>
          </div>
        ))}
        <div ref={bottom} />
      </div>
      {error && <p className="error">{error}</p>}
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="imagem" />
        </div>
      )}
      <form className="composer" onSubmit={send}>
        <input
          placeholder={secret ? 'Mensagem' : 'Informe a chave da conversa para enviar'}
          value={text}
          disabled={!secret}
          onChange={(e) => setText(e.target.value)}
          onPaste={paste}
        />
        <button type="submit" disabled={!secret}>Enviar</button>
      </form>
    </section>
  );
}

function Messenger({ me, onLogout }) {
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [active, setActive] = useState(null);
  const [newFriend, setNewFriend] = useState('');
  const [info, setInfo] = useState({ text: '', error: false });
  const [incoming, setIncoming] = useState(null);
  const [cleared, setCleared] = useState({}); // contador por amigo; muda quando a conversa é apagada
  // só em memória: a chave da conversa nunca é persistida
  const [secrets, setSecrets] = useState({});
  const [unread, setUnread] = useState({});
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  // refs para o handler do WebSocket enxergar sempre o estado atual
  const activeRef = useRef(null);
  const secretsRef = useRef(secrets);
  const permRef = useRef(perm);
  activeRef.current = active;
  secretsRef.current = secrets;
  permRef.current = perm;

  const say = (text, error = false) => setInfo({ text, error });

  const refresh = useCallback(async () => {
    const [f, r, b] = await Promise.all([api.friends(), api.requests(), api.blocks()]);
    setFriends(f);
    setRequests(r);
    setBlocked(b);
    setActive((a) => (a && !f.includes(a) ? null : a));
  }, []);

  const notifyMessage = useCallback(async (m) => {
    if (document.hasFocus() && activeRef.current === m.from) return;
    setUnread((u) => ({ ...u, [m.from]: (u[m.from] || 0) + 1 }));
    if (permRef.current !== 'granted') return;
    const secret = secretsRef.current[m.from];
    const plain = secret && (await decryptText(m.data, secret, me, m.from));
    const body = !plain ? 'Nova mensagem 🔒' : IMAGE_RE.test(plain) ? '📷 Imagem' : plain;
    const n = new Notification(m.from, { body, tag: `msg:${m.from}` });
    n.onclick = () => { window.focus(); setActive(m.from); n.close(); };
  }, [me]);
  const notifyMessageRef = useRef(notifyMessage);
  notifyMessageRef.current = notifyMessage;

  const total = Object.values(unread).reduce((a, b) => a + b, 0);
  useEffect(() => {
    document.title = total ? `(${total}) Anonymous Messenger` : 'Anonymous Messenger';
  }, [total]);

  const openChat = (f) => {
    setActive(f);
    setUnread((u) => ({ ...u, [f]: 0 }));
  };
  useEffect(() => {
    const clear = () => active && setUnread((u) => (u[active] ? { ...u, [active]: 0 } : u));
    window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, [active]);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  useEffect(() => {
    let ws;
    let closed = false;
    let delay = 1000;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => { delay = 1000; };
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'message') {
          setIncoming(ev.message);
          if (ev.message.from !== me) notifyMessageRef.current(ev.message);
        }
        if (ev.type === 'cleared') setCleared((c) => ({ ...c, [ev.with]: (c[ev.with] || 0) + 1 }));
        if (ev.type === 'friend' || ev.type === 'request') refresh().catch(() => {});
        if (ev.type === 'request' && permRef.current === 'granted' && !document.hasFocus()) {
          new Notification('Pedido de amizade', { body: `${ev.login} quer ser seu amigo`, tag: `req:${ev.login}` });
        }
      };
      ws.onclose = () => {
        if (closed) return;
        setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    };
    connect();
    return () => { closed = true; ws.close(); };
  }, [me, refresh]);

  const setSecret = (friend, value) => setSecrets((s) => ({ ...s, [friend]: value }));

  // Executa uma ação da API, mostra o erro se houver e atualiza as listas.
  const act = async (fn, okText) => {
    try {
      await fn();
      if (okText) say(okText);
      await refresh();
    } catch (err) {
      say(err.message, true);
    }
  };

  const addFriend = async (e) => {
    e.preventDefault();
    try {
      const r = await api.addFriend(newFriend);
      say(r.status === 'friends' ? 'Agora vocês são amigos' : 'Pedido enviado');
      setNewFriend('');
      await refresh();
    } catch (err) {
      say(err.message, true);
    }
  };

  return (
    <div className={`app ${active ? 'in-chat' : ''}`}>
      <aside>
        <div className="me">
          <span>{me}</span>
          <button className="link" onClick={onLogout}>Sair</button>
        </div>
        {perm === 'default' && (
          <button onClick={() => Notification.requestPermission().then(setPerm)}>Ativar notificações</button>
        )}
        <form onSubmit={addFriend}>
          <input placeholder="Adicionar amigo (login)" value={newFriend} onChange={(e) => setNewFriend(e.target.value)} />
        </form>
        {info.text && <p className={info.error ? 'error' : 'ok'}>{info.text}</p>}
        {requests.length > 0 && (
          <div className="requests">
            <h3>Pedidos de amizade</h3>
            {requests.map((r) => (
              <div key={r} className="request">
                <span>{r}</span>
                <button onClick={() => act(() => api.acceptRequest(r))}>✓</button>
                <button className="secondary" onClick={() => act(() => api.rejectRequest(r))}>✗</button>
              </div>
            ))}
          </div>
        )}
        <ul>
          {friends.map((f) => (
            <li key={f} className={f === active ? 'active' : ''} onClick={() => openChat(f)}>
              {f}{unread[f] > 0 && <span className="badge">{unread[f]}</span>}
            </li>
          ))}
        </ul>
        {blocked.length > 0 && (
          <details className="blocked">
            <summary>Bloqueados ({blocked.length})</summary>
            {blocked.map((b) => (
              <div key={b} className="request">
                <span>{b}</span>
                <button className="link" onClick={() => act(() => api.unblock(b))}>Desbloquear</button>
              </div>
            ))}
          </details>
        )}
      </aside>
      {active ? (
        <Chat
          key={active}
          me={me}
          friend={active}
          secret={secrets[active] || ''}
          onSecretChange={(v) => setSecret(active, v)}
          incoming={incoming}
          cleared={cleared[active] || 0}
          onBack={() => setActive(null)}
          onRemove={() => window.confirm(`Remover ${active} dos amigos?`) && act(() => api.removeFriend(active))}
          onBlock={() => window.confirm(`Bloquear ${active}?`) && act(() => api.block(active))}
        />
      ) : (
        <section className="chat empty">Selecione ou adicione um amigo</section>
      )}
    </div>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = verificando a sessão

  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    api.me().then((r) => setMe(r.login)).catch(() => setMe(null));
  }, []);

  if (!cryptoAvailable) {
    return <p className="error pad">
      Este navegador exige HTTPS ou localhost para usar criptografia (WebCrypto).
    </p>;
  }
  if (me === undefined) return null;

  const logout = async () => {
    await api.logout().catch(() => {});
    setMe(null);
  };

  return me ? <Messenger me={me} onLogout={logout} /> : <AuthScreen onAuth={setMe} />;
}

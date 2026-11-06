import { createContext, forwardRef, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { api, convApi, setUnauthorizedHandler } from './api.js';
import { takeShare } from './share.js';
import GifPicker from './GifPicker.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useCall } from './useCall.js';
import { blockUpdate } from './updater.js';
import { disablePush, enablePush, notify, syncPush } from './push.js';
import { embedOf, splitLinks } from './embeds.js';
import { assertMediaFile, audioMessage, fileMime, hasPreview, cryptoAvailable, decryptText, deriveKey, encryptText, fetchDecryptedBlob, gifToDataUrl, imageToDataUrl, makeThumb, mediaOf, messageOf, previewOf, saveFileStreaming, uploadFile, withReply } from './crypto.js';
import { avatarBlob } from './avatar.js';

const EMOJIS = [...'😀😃😄😁😆😅😂🤣🙂😉😊😇🥰😍🤩😘😋😛😜🤪🤔🤨😐😑😶🙄😏😒😞😔😟😕🙁😮😲😳🥺😢😭😤😠😡🤬🤯😱😨😰😥😓🤗🤭🤫😴🤤😷🤒🤕🤢🤮🥳😎🤓🧐👍👎👌✌️🤞🤟🤘👏🙌🙏💪👋🤝👀🧠❤️🧡💛💚💙💜🖤💔💕💖🔥✨🎉🎂🎁💯✅❌⚠️❓❗💤💩👻💀🤖🐶🐱🐭🐸🐵🍕🍔🍟🍺☕⚽🎮🎵🚀🌈☀️🌙⭐'.matchAll(/\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu)].map((m) => m[0]);

// login -> versão do avatar enviado (quem não tem aparece com a inicial numa cor derivada do login)
const AvatarsCtx = createContext({});
const hueOf = (s) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return h % 360;
};
function Avatar({ login, size = 40 }) {
  const v = useContext(AvatarsCtx)[login];
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [v]);
  const img = v && !broken;
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.45, ...(!img && { background: `hsl(${hueOf(login)} 45% 40%)` }) }} aria-hidden="true">
      {img ? <img src={api.avatarUrl(login, v)} alt="" onError={() => setBroken(true)} /> : [...login][0]?.toUpperCase()}
    </span>
  );
}

const ICON = {
  smile: 'M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z',
  reply: 'M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z',
  edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
  trash: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
};
const Icon = ({ name }) => <svg className="ico" viewBox="0 0 24 24" aria-hidden="true"><path d={ICON[name]} /></svg>;

// "Hoje às 14:05" / "27/10/2026 14:05"
function stamp(ts) {
  const d = new Date(ts);
  const clock = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Hoje às ${clock}` : `${d.toLocaleDateString()} ${clock}`;
}
const GROUP_MS = 5 * 60 * 1000; // mensagens seguidas do mesmo autor dentro disso ficam agrupadas

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState('login'); // login | register | pending | forgot
  const [login, setLogin] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [unverifiedEmail, setUnverifiedEmail] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setUnverifiedEmail('');
    try {
      if (mode === 'register') {
        if (password.length < 6) throw new Error('A senha deve ter no mínimo 6 caracteres');
        await api.register(login, email, password);
        setMode('pending');
      } else {
        const res = await api.login(login, password);
        onAuth(res.login);
      }
    } catch (err) {
      setError(err.message);
      if (err.status === 403) setUnverifiedEmail(login.includes('@') ? login : '');
    }
  };

  const resend = async (to) => {
    setInfo('');
    try {
      await api.resendConfirmation(to);
      setInfo('Se o e-mail existir e não estiver confirmado, enviamos um novo link.');
    } catch (err) {
      setError(err.message);
    }
  };

  const sendReset = async (e) => {
    e.preventDefault();
    setError('');
    setInfo('');
    try {
      await api.forgotPassword(email);
      setInfo('Se esse e-mail estiver cadastrado, enviamos um link para criar uma nova senha (veja também o spam).');
    } catch (err) {
      setError(err.message);
    }
  };

  if (mode === 'forgot') {
    return (
      <form className="auth" onSubmit={sendReset}>
        <h1>Recuperar senha</h1>
        <input placeholder="E-mail da conta" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        {error && <p className="error">{error}</p>}
        {info && <p>{info}</p>}
        <button type="submit">Enviar link</button>
        <button type="button" className="link" onClick={() => { setMode('login'); setError(''); setInfo(''); }}>Voltar</button>
      </form>
    );
  }

  if (mode === 'pending') {
    return (
      <div className="auth">
        <h1>Confirme seu e-mail</h1>
        <p>Enviamos um link de confirmação para <b>{email}</b>. Abra-o para ativar a conta e entrar automaticamente.</p>
        <p className="hint">Pode levar alguns minutos e cair na caixa de spam.</p>
        {info && <p>{info}</p>}
        {error && <p className="error">{error}</p>}
        <button type="button" onClick={() => resend(email)}>Reenviar e-mail</button>
        <button type="button" className="link" onClick={() => { setMode('login'); setError(''); setInfo(''); }}>Voltar</button>
      </div>
    );
  }

  return (
    <form className="auth" onSubmit={submit}>
      <h1>Anonymous Messenger</h1>
      <input
        placeholder={mode === 'login' ? 'E-mail ou usuário' : 'Nome de usuário'}
        value={login}
        onChange={(e) => setLogin(e.target.value)}
        autoFocus
      />
      {mode === 'register' && (
        <input placeholder="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      )}
      <input placeholder="Senha" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      {error && <p className="error">{error}</p>}
      {info && <p>{info}</p>}
      {unverifiedEmail && <button type="button" className="link" onClick={() => resend(unverifiedEmail)}>Reenviar e-mail de confirmação</button>}
      <button type="submit">{mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
      {mode === 'login' && <button type="button" className="link" onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}>Esqueci a senha</button>}
      <button type="button" className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>
        {mode === 'login' ? 'Cadastrar' : 'Já tenho conta'}
      </button>
    </form>
  );
}

const fmtSize = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1024 ** 2))} MB`);
const AUTO_LOAD_BYTES = 8 * 1024 * 1024; // até aqui o vídeo/GIF carrega sozinho; acima, só ao clicar

// Vídeo/GIF guardado como arquivo cifrado: baixa os bytes, decifra no navegador e toca. Acima de
// PLAY_LIMIT (200 MB) não toca: vira um arquivo para baixar, decifrado em stream pelo service worker.
function FileMedia({ media, conv, secret, saltA, saltB, onZoom }) {
  const f = media.file;
  const [url, setUrl] = useState(null);
  const [loaded, setLoaded] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const made = useRef(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (made.current) URL.revokeObjectURL(made.current); };
  }, []);

  const load = async () => {
    setError('');
    setBusy(true);
    try {
      const key = await deriveKey(secret, saltA, saltB);
      const blob = await fetchDecryptedBlob({
        url: conv.fileUrl(f.id), fid: f.id, key, size: f.size, mime: f.mime,
        onProgress: (b) => alive.current && setLoaded(b),
      });
      if (!alive.current) return;
      made.current = URL.createObjectURL(blob);
      setUrl(made.current);
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const save = async () => {
    setError('');
    try {
      const key = await deriveKey(secret, saltA, saltB);
      try {
        await saveFileStreaming({ url: conv.fileUrl(f.id), fid: f.id, key, size: f.size, name: f.name });
      } catch (err) {
        // sem service worker: até 200 MB dá para decifrar na memória e baixar de uma vez
        if (f.size > 200 * 1024 * 1024) throw err;
        setBusy(true);
        const blob = await fetchDecryptedBlob({
          url: conv.fileUrl(f.id), fid: f.id, key, size: f.size, mime: 'application/octet-stream',
          onProgress: (b) => alive.current && setLoaded(b),
        });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  useEffect(() => {
    if (f.playable && f.size <= AUTO_LOAD_BYTES && secret && !url) load();
  }, [f.id, secret]);

  if (url) {
    return f.mime === 'video/mp4'
      ? <video src={url} controls loop muted playsInline preload="metadata" />
      : <img src={url} alt="GIF" onClick={() => onZoom(url)} />;
  }
  const icon = f.generic ? '📎' : f.mime === 'video/mp4' ? '🎬' : '🖼️';
  const fmtDur = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
  const pct = Math.min(100, Math.floor((loaded / f.size) * 100));
  if (f.thumb) {
    // miniatura com botão no meio: ▶ carrega e toca; ⬇ (arquivo grande) baixa decifrado em stream
    return (
      <div>
        <button
          type="button"
          className="file-thumb"
          style={f.w && f.h ? { aspectRatio: `${f.w} / ${f.h}` } : undefined}
          disabled={busy}
          title={f.name}
          onClick={f.playable ? load : save}
        >
          <img src={f.thumb} alt={f.name} />
          <span className="play">{busy ? `${pct}%` : f.playable ? '▶' : '⬇'}</span>
          <span className="meta">{f.duration ? `${fmtDur(f.duration)} · ` : ''}{fmtSize(f.size)}</span>
        </button>
        {!f.playable && <small className="hint">Grande demais para tocar aqui (máx. {fmtSize(200 * 1024 * 1024)}); baixa já decifrado.</small>}
        {error && <small className="error">{error}</small>}
      </div>
    );
  }
  return (
    <div className="file-card">
      <span>{icon} {f.name} · {fmtSize(f.size)}</span>
      {f.playable ? (
        <button type="button" disabled={busy} onClick={load}>
          {busy ? `Baixando… ${Math.min(100, Math.floor((loaded / f.size) * 100))}%` : `▶ Carregar ${f.mime === 'video/mp4' ? 'vídeo' : 'GIF'}`}
        </button>
      ) : (
        <>
          {!f.generic && <small>Grande demais para tocar aqui (máx. {fmtSize(200 * 1024 * 1024)}). É baixado já decifrado.</small>}
          <button type="button" disabled={busy} onClick={save}>{busy ? `Baixando… ${pct}%` : '⬇ Baixar'}</button>
        </>
      )}
      {error && <small className="error">{error}</small>}
    </div>
  );
}

// Página aberta pelo link de recuperação: define a nova senha e já entra.
function ResetPassword({ token, onAuth }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (password.length < 6) throw new Error('A senha deve ter no mínimo 6 caracteres');
      const res = await api.resetPassword(token, password);
      history.replaceState(null, '', import.meta.env.BASE_URL);
      onAuth(res.login);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <form className="auth" onSubmit={submit}>
      <h1>Nova senha</h1>
      <input placeholder="Nova senha" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
      {error && <p className="error">{error}</p>}
      <button type="submit">Salvar e entrar</button>
      <button type="button" className="link" onClick={() => { history.replaceState(null, '', import.meta.env.BASE_URL); location.reload(); }}>Cancelar</button>
    </form>
  );
}

// Página aberta pelo link do e-mail: confirma, já entra com a sessão e segue para o app.
function ConfirmEmail({ token, onAuth }) {
  const [state, setState] = useState('loading'); // loading | ok | error
  const [message, setMessage] = useState('');
  useEffect(() => {
    api.confirmEmail(token).then(
      (res) => {
        setState('ok');
        setTimeout(() => {
          history.replaceState(null, '', import.meta.env.BASE_URL);
          onAuth(res.login);
        }, 1500);
      },
      (err) => { setState('error'); setMessage(err.message); }
    );
  }, [token, onAuth]);
  return (
    <div className="auth">
      <h1>Anonymous Messenger</h1>
      {state === 'loading' && <p>Confirmando e-mail…</p>}
      {state === 'ok' && <p>E-mail confirmado! Entrando…</p>}
      {state === 'error' && (
        <>
          <p className="error">{message}</p>
          <button type="button" onClick={() => { history.replaceState(null, '', import.meta.env.BASE_URL); location.reload(); }}>
            Ir para o login
          </button>
        </>
      )}
    </div>
  );
}

// YouTube e posts do X são carregados direto ao exibir a mensagem (o provedor vê o IP de quem lê).
function EmbedCard({ embed }) {
  const tweet = embed.kind === 'tweet';
  const src = tweet
    ? `https://platform.twitter.com/embed/Tweet.html?id=${embed.id}&theme=dark&dnt=true`
    : `https://www.youtube-nocookie.com/embed/${embed.id}?rel=0${embed.start ? `&start=${embed.start}` : ''}`;
  return (
    <iframe
      className={`embed ${tweet ? 'tweet' : 'yt'}`}
      src={src}
      title={tweet ? 'Post do X/Twitter' : 'Vídeo do YouTube'}
      loading="lazy"
      allow={tweet ? '' : 'encrypted-media; picture-in-picture; fullscreen'}
      allowFullScreen={!tweet}
      referrerPolicy="strict-origin-when-cross-origin"
    />
  );
}

function Linkified({ text }) {
  return splitLinks(text).map((part, i) => part.link
    ? <a key={i} href={part.href} target="_blank" rel="noopener noreferrer nofollow">{part.text}</a>
    : part.text);
}

let playingAudio = null; // só um áudio toca por vez
const fmtDuration = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

// Mensagem de voz: ícone de play à esquerda (com a duração embaixo) e o texto transcrito ao lado.
function VoiceMessage({ media, pending }) {
  const audio = useRef(null);
  const [on, setOn] = useState(false);
  const [duration, setDuration] = useState(media.duration);
  const toggle = () => {
    const a = audio.current;
    if (!a.paused) return a.pause();
    if (playingAudio && playingAudio !== a) playingAudio.pause();
    playingAudio = a;
    a.play().catch(() => {});
  };
  return (
    <div className="voice">
      <div className="voice-play">
        <button type="button" className="play" onClick={toggle} aria-label={on ? 'Pausar áudio' : 'Tocar áudio'}>
          {on ? '⏸' : '▶'}
        </button>
        <span className="dur">{fmtDuration(duration)}</span>
      </div>
      <p className={`voice-text ${media.transcript ? '' : 'none'}`}>
        {media.transcript ? <Linkified text={media.transcript} /> : pending ? 'Transcrevendo…' : 'Mensagem de áudio'}
      </p>
      <audio
        ref={audio}
        src={media.src}
        preload="metadata"
        onPlay={() => setOn(true)}
        onPause={() => setOn(false)}
        onEnded={() => setOn(false)}
        onLoadedMetadata={(e) => {
          const d = e.target.duration; // gravações do navegador podem não informar (Infinity)
          if (!media.duration && Number.isFinite(d)) setDuration(Math.round(d));
        }}
      />
    </div>
  );
}

const secretsKey = (me) => `am:secrets:${me}`;
function loadSecrets(me) {
  try {
    const v = JSON.parse(localStorage.getItem(secretsKey(me)));
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}
function saveSecrets(me, secrets) {
  try {
    if (Object.keys(secrets).length) localStorage.setItem(secretsKey(me), JSON.stringify(secrets));
    else localStorage.removeItem(secretsKey(me));
  } catch {}
}

const MAX_RECORDING_SECONDS = 60; // o Whisper na CPU leva ~1x a duração do áudio para transcrever
const DEFAULT_CHANNELS = [{ id: 'main', name: 'geral' }];

// Caixa de texto da mensagem. O texto digitado fica aqui dentro: a cada tecla só este componente
// renderiza, não o chat inteiro. O Chat fala com ele pelo ref (get/clear/insert/append/focus) e só é
// avisado quando a caixa passa de vazia para preenchida (onHasText).
const MessageInput = forwardRef(function MessageInput({ placeholder, disabled, hidden, onHasText, onEscape, onPaste }, ref) {
  const [text, setText] = useState('');
  const el = useRef(null);
  useImperativeHandle(ref, () => ({
    get: () => text,
    clear: () => setText(''),
    focus: () => el.current?.focus(),
    append: (add) => setText((t) => (t ? `${t}\n` : '') + add),
    insert: (emoji) => {
      const node = el.current;
      const start = node?.selectionStart ?? text.length;
      const end = node?.selectionEnd ?? text.length;
      setText(text.slice(0, start) + emoji + text.slice(end));
      requestAnimationFrame(() => {
        node?.focus();
        node?.setSelectionRange(start + emoji.length, start + emoji.length);
      });
    },
  }), [text]);
  useEffect(() => { onHasText(text.trim() !== ''); }, [text]);
  // a caixa cresce com as linhas (até um limite) e volta ao tamanho de uma linha ao esvaziar
  useLayoutEffect(() => {
    const node = el.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${node.scrollHeight}px`;
  }, [text, hidden]);
  return (
    <textarea
      ref={el}
      rows={1}
      placeholder={placeholder}
      value={text}
      style={hidden ? { display: 'none' } : undefined}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        // Enter envia e Shift+Enter quebra a linha; no celular (teclado de toque) Enter quebra a linha
        if (e.key === 'Escape') return onEscape();
        if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || matchMedia('(pointer: coarse)').matches) return;
        e.preventDefault();
        e.currentTarget.form.requestSubmit();
      }}
      onPaste={onPaste}
    />
  );
});

function Chat({
  me, friend, server, canManage, memberCount, channel, channels, unreadCh, onChannel, onCreateChannel, onDeleteChannel,
  secret, onSecretChange, incoming, reactionEv, editEv, deleteEv, online, pendingShare, onShareDone, readEv, cleared, onBack, onRemove, onBlock, onCall, callBusy,
}) {
  const [raw, setRaw] = useState([]);
  const [plain, setPlain] = useState({});
  const [hasText, setHasText] = useState(false); // a caixa de mensagem tem algo digitado
  const [error, setError] = useState('');
  const [mediaJobs, setMediaJobs] = useState([]); // envios de mídia grande em andamento: { id, text } ('Codificando vídeo…' / 'Enviando…')
  const jobId = useRef(0);
  const [zoom, setZoom] = useState(null);
  // gravação de áudio: null | { seconds } enquanto grava; 'sending' enquanto transcreve e envia
  const [noticeOpen, setNoticeOpen] = useState(false);
  const [noticeHidden, setNoticeHidden] = useState(() => {
    try { return localStorage.getItem('am:notice-closed') === '1'; } catch { return false; }
  });
  const hideNotice = () => {
    setNoticeHidden(true);
    try { localStorage.setItem('am:notice-closed', '1'); } catch {}
  };
  const [selected, setSelected] = useState(null); // mensagem clicada: mostra as ações (responder, editar, apagar)
  const [replyTo, setReplyTo] = useState(null); // { id, from, p } da mensagem que está sendo respondida
  const [editing, setEditing] = useState(null); // { id, text }
  const [rec, setRec] = useState(null);
  const [transcribing, setTranscribing] = useState(() => new Set()); // ids dos áudios aguardando transcrição
  const recorder = useRef(null);
  useEffect(() => { blockUpdate('rec', !!rec); return () => blockUpdate('rec', false); }, [rec]);
  const hold = useRef(null); // { startY } enquanto o dedo/ponteiro está sobre o microfone
  const [willCancel, setWillCancel] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [pickerTab, setPickerTab] = useState('gif');
  const [picker, setPicker] = useState(null); // null | 'compose' | id da mensagem que vai receber a reação
  const input = useRef(null);
  const bottom = useRef(null);
  const list = useRef(null);
  const [hasMore, setHasMore] = useState(false); // há mensagens mais antigas no servidor
  const [friendRead, setFriendRead] = useState(0); // até que seq o amigo já leu
  const stick = useRef(true); // a lista está perto do fim: novas mensagens rolam para baixo
  const anchor = useRef(null); // posição antes de inserir mensagens antigas, para não "pular"
  const loadingOlder = useRef(false);
  const readSent = useRef(0);
  const cache = useRef({ secret: null, map: {} }); // mensagens já decifradas com a chave atual
  // Num servidor a chave é do servidor inteiro: o "par" do salt da criptografia é o próprio servidor.
  const conv = convApi(server ? { server: server.id } : { friend });
  const [saltA, saltB] = server ? [`server:${server.id}`, `server:${server.id}`] : [me, friend];
  const encrypt = (text) => encryptText(text, secret, saltA, saltB);

  useEffect(() => {
    let cancelled = false;
    setRaw([]);
    setHasMore(false);
    stick.current = true;
    conv.messages(channel)
      .then((r) => {
        if (cancelled) return;
        setRaw(r.messages);
        setHasMore(r.hasMore);
        setFriendRead(r.read);
      })
      .catch((e) => setError(e.message));
    return () => { cancelled = true; };
  }, [friend, channel]);

  useEffect(() => {
    if (cleared > 0) { setRaw([]); setHasMore(false); }
  }, [cleared]);

  useEffect(() => {
    if (!incoming) return;
    const { from, to } = incoming;
    if (incoming.channel !== channel) return;
    const mine = server ? incoming.server === server.id : (from === friend && to === me) || (from === me && to === friend);
    if (mine) {
      if (from === me) stick.current = true; // ao enviar, vai para o fim
      setRaw((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    }
  }, [incoming, friend, server?.id, me, channel]);

  useEffect(() => {
    if (!editEv || editEv.channel !== channel) return;
    if (!raw.some((m) => m.id === editEv.id)) return;
    delete cache.current.map[editEv.id]; // decifra de novo com o conteúdo atualizado
    setRaw((prev) => prev.map((m) => (m.id === editEv.id ? { ...m, data: editEv.data, ...(editEv.edited && { edited: editEv.edited }) } : m)));
  }, [editEv]);

  useEffect(() => {
    if (!deleteEv || deleteEv.channel !== channel) return;
    delete cache.current.map[deleteEv.id];
    setRaw((prev) => prev.filter((m) => m.id !== deleteEv.id));
    setReplyTo((r) => (r?.id === deleteEv.id ? null : r));
    setEditing((e) => (e?.id === deleteEv.id ? null : e));
  }, [deleteEv]);

  useEffect(() => {
    if (!reactionEv) return;
    setRaw((prev) => prev.map((m) => (m.id === reactionEv.id ? { ...m, reactions: reactionEv.reactions } : m)));
  }, [reactionEv]);

  // Decifra só o que ainda não foi decifrado com a chave atual (a lista cresce aos poucos).
  const decryptMissing = async (msgs) => {
    if (cache.current.secret !== secret) {
      cache.current = { secret, map: {} };
      setPlain({});
    }
    const cur = cache.current;
    if (!secret) return;
    let changed = false;
    for (const m of msgs) {
      if (m.id in cur.map) continue;
      cur.map[m.id] = await decryptText(m.data, secret, saltA, saltB);
      changed = true;
    }
    if (changed && cache.current === cur) setPlain({ ...cur.map });
  };

  useEffect(() => { decryptMissing(raw); }, [raw, secret, saltA, saltB]);

  useEffect(() => {
    if (readEv && readEv.with === friend && readEv.channel === channel) setFriendRead((r) => Math.max(r, readEv.seq));
  }, [readEv]);

  // Marca como lido o que o amigo mandou, mas só se a janela está em foco, a lista no fim e a mensagem decifrada.
  const markRead = () => {
    if (!document.hasFocus() || document.visibilityState !== 'visible' || !stick.current) return;
    const last = raw.reduce((a, m) => (m.from === friend && m.seq > a && plain[m.id] != null ? m.seq : a), 0);
    if (last > readSent.current) {
      readSent.current = last;
      conv.markRead(channel, last).catch(() => {});
    }
  };
  useEffect(() => {
    markRead();
    window.addEventListener('focus', markRead);
    return () => window.removeEventListener('focus', markRead);
  }, [raw, plain]);

  // Rolagem: mensagens antigas entram por cima sem mexer na posição; o resto acompanha o fim.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
    } else if (stick.current) {
      bottom.current?.scrollIntoView();
    }
  }, [raw, plain]);

  const loadOlder = async () => {
    const el = list.current;
    if (!el || loadingOlder.current || !hasMore || !raw.length) return;
    loadingOlder.current = true;
    try {
      const r = await conv.messages(channel, raw[0].seq);
      await decryptMissing(r.messages); // decifra antes de mostrar, para a altura não mudar depois
      anchor.current = { height: el.scrollHeight, top: el.scrollTop };
      setRaw((prev) => {
        const ids = new Set(prev.map((m) => m.id));
        return [...r.messages.filter((m) => !ids.has(m.id)), ...prev];
      });
      setHasMore(r.hasMore);
    } catch (err) {
      setError(err.message);
    } finally {
      loadingOlder.current = false;
    }
  };

  const onScroll = () => {
    const el = list.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
    if (el.scrollTop < 120) loadOlder();
    if (stick.current) markRead();
  };

  const send = async (e) => {
    e.preventDefault();
    const text = input.current?.get() ?? '';
    if (!text.trim() || !secret) return;
    setError('');
    try {
      await conv.send(channel, await encrypt(withReply(text, replyTo)));
      input.current?.clear();
      setReplyTo(null);
    } catch (err) {
      setError(err.message);
    }
  };

  const guard = (fn) => async (...args) => {
    setError('');
    try {
      await fn(...args);
    } catch (err) {
      setError(err.message);
    }
  };

  const newChannel = guard(async () => {
    const name = window.prompt('Nome do novo canal:');
    if (name?.trim()) await onCreateChannel(name);
  });

  const delChannel = guard(async () => {
    const name = channels.find((c) => c.id === channel)?.name;
    if (window.confirm(`Apagar o canal #${name} e todas as mensagens dele, para ${server ? 'todos' : 'os dois lados'}? Não pode ser desfeito.`)) {
      await onDeleteChannel(channel);
    }
  });

  const react = guard((id, emoji) => conv.react(id, emoji));

  const partsOf = (m) => (typeof plain[m.id] === 'string' ? messageOf(plain[m.id]) : null); // { reply, body } ou null (sem chave)
  const canEdit = (m) => m.from === me && !!partsOf(m) && !mediaOf(partsOf(m).body);
  const canDelete = (m) => m.from === me || (!!server && canManage);

  const startReply = (m) => {
    const parts = partsOf(m);
    if (!parts) return;
    setReplyTo({ id: m.id, from: m.from, p: previewOf(parts.body) });
    setSelected(null);
    input.current?.focus();
  };
  const startEdit = (m) => {
    setEditing({ id: m.id, text: partsOf(m).body });
    setSelected(null);
  };
  const saveEdit = guard(async (m) => {
    const parts = partsOf(m);
    const text = editing.text.trim();
    setEditing(null);
    if (!text || text === parts.body) return;
    await conv.editMessage(m.id, await encrypt(withReply(text, parts.reply)), true);
  });
  const remove = guard(async (m) => {
    setSelected(null);
    if (window.confirm('Apagar esta mensagem? Não pode ser desfeito.')) await conv.deleteMessage(m.id);
  });
  const jumpTo = (id) => {
    const el = document.getElementById(`msg-${id}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 1500);
  };

  const sendGif = async (src) => {
    setPicker(null);
    try {
      await sendImage(new File([await api.gifBlob(src)], 'gif.gif', { type: 'image/gif' }));
    } catch (err) {
      setError(err.message);
    }
  };

  const pickEmoji = (emoji) => {
    if (picker === 'compose') return addEmoji(emoji);
    setPicker(null);
    react(picker, emoji);
  };

  const addEmoji = (emoji) => input.current?.insert(emoji);

  const sendImage = async (file) => {
    if (!secret) return;
    setError('');
    const job = ++jobId.current;
    const setJob = (text) => setMediaJobs((j) => (j.some((x) => x.id === job) ? j.map((x) => (x.id === job ? { ...x, text } : x)) : [...j, { id: job, text }]));
    try {
      if (file.type === 'video/mp4' || (file.type === 'image/gif' && file.size > 512 * 1024) || !file.type.startsWith('image/')) {
        // vídeo/GIF grande: bytes cifrados em blocos (AES-GCM, chave da conversa) e enviados como arquivo
        await assertMediaFile(file);
        const thumb = hasPreview(file) ? await makeThumb(file) : {};
        const fid = crypto.randomUUID();
        const key = await deriveKey(secret, saltA, saltB);
        const what = file.type === 'video/mp4' ? 'vídeo' : file.type === 'image/gif' ? 'GIF' : 'arquivo';
        setJob(`🔒 Cifrando ${what}… 0%`);
        await uploadFile(file, fid, key, (blob, offset, final) => conv.putFilePart(fid, channel, offset, final, blob),
          ({ phase, enc, sent }) => setJob(phase === 'encrypt'
            ? `🔒 Cifrando ${what}… ${enc}% (enviado ${sent}%)`
            : `⬆ Enviando ${what}… ${sent}% (cifrado ${enc}%)`));
        const body = JSON.stringify({ k: 'file', id: fid, m: fileMime(file), n: file.name || 'arquivo', s: file.size, ...thumb });
        await conv.send(channel, await encrypt(withReply(body, replyTo)), fid);
      } else {
        const url = file.type === 'image/gif' ? await gifToDataUrl(file) : await imageToDataUrl(file);
        await conv.send(channel, await encrypt(withReply(url, replyTo)));
      }
      setReplyTo(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setMediaJobs((j) => j.filter((x) => x.id !== job));
    }
  };

  const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  // Grava do microfone; ao enviar, o áudio vai ao servidor só para ser transcrito (Whisper) e a
  // mensagem segue cifrada com o áudio e o texto dentro.
  const startRecording = guard(async () => {
    if (!secret || recorder.current) return;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      throw new Error(err?.name === 'NotAllowedError' ? 'Permissão do microfone negada' : 'Não foi possível acessar o microfone');
    }
    if (!hold.current) { // soltou antes de o microfone ficar pronto (ex.: prompt de permissão)
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t));
    const mr = new MediaRecorder(stream, { ...(mimeType && { mimeType }), audioBitsPerSecond: 32000 });
    const r = { mr, stream, chunks: [], started: Date.now(), cancelled: false, timer: null };
    recorder.current = r;
    mr.ondataavailable = (e) => e.data.size && r.chunks.push(e.data);
    mr.onstop = () => {
      clearInterval(r.timer);
      stream.getTracks().forEach((t) => t.stop());
      recorder.current = null;
      if (r.cancelled) return setRec(null);
      const duration = (Date.now() - r.started) / 1000;
      finishRecording(new Blob(r.chunks, { type: mr.mimeType || mimeType || 'audio/webm' }), duration);
    };
    mr.start(1000);
    setRec({ seconds: 0 });
    r.timer = setInterval(() => {
      const seconds = Math.floor((Date.now() - r.started) / 1000);
      setRec({ seconds });
      if (seconds >= MAX_RECORDING_SECONDS) mr.stop();
    }, 500);
  });

  const stopRecording = (cancel) => {
    const r = recorder.current;
    if (!r) return;
    r.cancelled = cancel;
    r.mr.stop();
  };

  const CANCEL_DRAG = 60; // px arrastados para cima até a lixeira
  const micDown = (e) => {
    if (!secret || recorder.current || e.button > 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    hold.current = { startY: e.clientY };
    setWillCancel(false);
    startRecording();
  };
  const micMove = (e) => {
    if (hold.current) setWillCancel(hold.current.startY - e.clientY > CANCEL_DRAG);
  };
  const micUp = (e, aborted) => {
    const h = hold.current;
    if (!h) return;
    hold.current = null;
    setWillCancel(false);
    stopRecording(aborted || h.startY - e.clientY > CANCEL_DRAG);
  };

  // O áudio é enviado na hora; a transcrição roda depois e, quando termina, a mensagem é atualizada.
  const finishRecording = guard(async (blob, duration) => {
    if (duration < 0.5) return setRec(null);
    setRec('sending');
    let sent;
    try {
      sent = await conv.send(channel, await encrypt(withReply(await audioMessage(blob, '', duration), replyTo)));
      setReplyTo(null);
    } finally {
      setRec(null);
    }
    transcribeLater(sent.id, blob, duration, replyTo);
  });

  const transcribeLater = async (id, blob, duration, reply) => {
    setTranscribing((s) => new Set(s).add(id));
    try {
      const text = (await api.transcribe(blob)).text.trim();
      if (text) await conv.editMessage(id, await encrypt(withReply(await audioMessage(blob, text, duration), reply)));
    } catch {
      // sem transcrição (serviço fora do ar, fila cheia...): o áudio já foi enviado
    } finally {
      setTranscribing((s) => { const n = new Set(s); n.delete(id); return n; });
    }
  };

  // sair do chat durante a gravação descarta o áudio e libera o microfone
  useEffect(() => () => {
    const r = recorder.current;
    if (r) { r.cancelled = true; r.mr.stop(); }
  }, []);

  const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
  // veio do menu Compartilhar do sistema: o texto vai para a caixa e as mídias são enviadas
  useEffect(() => {
    if (!pendingShare) return;
    if (pendingShare.text) input.current?.append(pendingShare.text);
    if (pendingShare.files.length) sendFiles(pendingShare.files);
    onShareDone();
  }, [pendingShare]);

  const sendFiles = async (files) => {
    if (!secret) return setError('Informe a chave da conversa para enviar arquivos');
    const ok = files.filter((f) => f.size > 0);
    if (!ok.length) return setError('Arquivo vazio');
    if (files.length > 5) setError('Máximo de 5 arquivos por vez; enviando os 5 primeiros');
    for (const f of ok.slice(0, 5)) await sendImage(f);
  };
  const dnd = {
    onDragEnter: (e) => { if (hasFiles(e)) { e.preventDefault(); dragDepth.current++; setDragging(true); } },
    onDragOver: (e) => { if (hasFiles(e)) e.preventDefault(); },
    onDragLeave: (e) => { if (hasFiles(e) && --dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } },
    onDrop: (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      sendFiles([...e.dataTransfer.files]);
    },
  };

  const paste = (e) => {
    const file = [...e.clipboardData.files][0];
    if (!file) return;
    e.preventDefault();
    sendImage(file);
  };

  const pick = (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) sendImage(file);
  };

  const clear = async () => {
    const name = channels.find((c) => c.id === channel)?.name ?? 'geral';
    const where = server ? `no servidor ${server.name}? Isso apaga para todos os membros` : `com ${friend}? Isso apaga para os dois lados`;
    if (!window.confirm(`Apagar permanentemente todas as mensagens de #${name} ${where} e não pode ser desfeito.`)) return;
    setError('');
    try {
      await conv.clearMessages(channel);
    } catch (err) {
      setError(err.message);
    }
  };

  const show = (m) => {
    if (!secret) return <em className="locked">🔒 {m.data.slice(0, 40)}…</em>;
    if (plain[m.id] === undefined) return '…';
    if (plain[m.id] == null) return <em className="locked">🔒 chave incorreta</em>;
    const p = messageOf(plain[m.id]).body;
    const media = mediaOf(p);
    if (media?.kind === 'audio') return <VoiceMessage media={media} pending={transcribing.has(m.id)} />;
    if (!media) {
      const embed = embedOf(p);
      return <><Linkified text={p} />{embed && <EmbedCard embed={embed} />}</>;
    }
    if (media.file) {
      return <FileMedia media={media} conv={conv} secret={secret} saltA={saltA} saltB={saltB} onZoom={setZoom} />;
    }
    if (media.kind === 'video') {
      return <video src={media.src} controls loop muted playsInline preload="metadata" referrerPolicy="no-referrer" />;
    }
    return <img src={media.src} alt="imagem" referrerPolicy="no-referrer" onClick={() => setZoom(media.src)} />;
  };

  return (
    <section className="chat" {...dnd}>
      {dragging && <div className="drop-overlay">Solte para enviar (imagens, vídeos e arquivos)</div>}
      <header>
        <button type="button" className="link back" onClick={onBack}>←</button>
        {server ? (
          <strong># {channels.find((c) => c.id === channel)?.name ?? 'geral'}<small>{server.name} · {memberCount ?? '…'} membros</small></strong>
        ) : (
          <strong>{friend}<small className={`status${online ? ' on' : ''}`}>{online ? 'online' : 'offline'}</small></strong>
        )}
        {!server && <button type="button" className="link" title="Chamada de áudio" disabled={callBusy} onClick={onCall}>📞</button>}
        {!server && <button type="button" className="link danger" onClick={onRemove}>Desfazer amizade</button>}
        {server && canManage && channel !== 'main' && <button type="button" className="link danger" onClick={delChannel}>Apagar canal</button>}
        {canManage && <button type="button" className="link danger" onClick={clear}>Limpar chat</button>}
        {!server && <button type="button" className="link danger" onClick={onBlock}>Bloquear</button>}
        <input
          type="text"
          className="secret-input"
          name="conversation-key"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          placeholder={server ? 'Chave do servidor' : 'Chave da conversa'}
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
        />
      </header>
      {!server && <nav className="channels">
        {channels.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`chip ${c.id === channel ? 'active' : ''}`}
            onClick={() => c.id !== channel && onChannel(c.id)}
          >
            # {c.name}{unreadCh[c.id] > 0 && <span className="badge">{unreadCh[c.id]}</span>}
          </button>
        ))}
        <button type="button" className="chip" title="Novo canal" onClick={newChannel}><PlusIcon /></button>
        {channel !== 'main' && <button type="button" className="chip" title="Apagar este canal" onClick={delChannel}>🗑</button>}
      </nav>}
      {!noticeHidden && (
        <div className="notice info-notice">
          <span className={`notice-text${noticeOpen ? ' open' : ''}`}>
            🔒 As mensagens (e mídias enviadas) são criptografadas no seu navegador (exceção: o áudio de uma mensagem de voz é enviado em claro ao servidor apenas para ser transcrito e logo descartado). O backend nunca salva a chave da
            conversa, apenas a mensagem já criptografada. A chave fica memorizada só neste navegador (localStorage, uma por
            amigo) e é apagada ao clicar em Sair. Ela nunca é enviada ao backend. Você pode conferir isso na aba Rede
            (Network) do developer tools do navegador: nenhuma requisição contém a chave.
          </span>
          <button type="button" className="link" onClick={() => setNoticeOpen((o) => !o)}>{noticeOpen ? 'ver menos' : 'ver mais'}</button>
          <button type="button" className="link" title="Fechar" onClick={hideNotice}>✕</button>
        </div>
      )}
      <div className="messages" ref={list} onScroll={onScroll}>
        {hasMore && <p className="older">Carregando mensagens anteriores…</p>}
        {raw.map((m, i) => {
          const parts = partsOf(m);
          const reply = parts?.reply;
          const prev = raw[i - 1];
          const head = !prev || prev.from !== m.from || m.ts - prev.ts > GROUP_MS || !!reply;
          const isEditing = editing?.id === m.id;
          return (
            <div
              key={m.id}
              id={`msg-${m.id}`}
              className={`msg${head ? ' head' : ''}${m.from === me ? ' mine' : ''}${selected === m.id ? ' selected' : ''}`}
              onClick={(e) => {
                if (e.target.closest('a,button,img,video,audio,textarea,iframe')) return;
                setSelected(selected === m.id ? null : m.id);
              }}
            >
              <div className="msg-gutter">
                {head ? <Avatar login={m.from} /> : <time>{new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
              </div>
              <div className="msg-main">
                {reply && (
                  <button type="button" className="reply-ref" title="Ir para a mensagem" onClick={() => jumpTo(reply.id)}>
                    <Icon name="reply" /><b>{reply.from}</b><span>{reply.p}</span>
                  </button>
                )}
                {head && (
                  <div className="msg-head">
                    <b className="author">{m.from}</b>
                    <time>{stamp(m.ts)}</time>
                  </div>
                )}
                {isEditing ? (
                  <div className="editor">
                    <textarea
                      autoFocus
                      rows={2}
                      value={editing.text}
                      onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') setEditing(null);
                        else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !matchMedia('(pointer: coarse)').matches) {
                          e.preventDefault();
                          saveEdit(m);
                        }
                      }}
                    />
                    <div className="editor-actions">
                      <button type="button" onClick={() => saveEdit(m)}>Salvar</button>
                      <button type="button" className="secondary" onClick={() => setEditing(null)}>Cancelar</button>
                      <small>Esc cancela · Enter salva</small>
                    </div>
                  </div>
                ) : (
                  <div className="msg-body">
                    {show(m)}
                    {m.edited && <small className="edited" title={stamp(m.edited)}>(editado)</small>}
                    {m.from === me && !server && (
                      <span className={`ticks ${m.seq <= friendRead ? 'read' : ''}`} title={m.seq <= friendRead ? 'Lida' : 'Enviada'}>
                        {m.seq <= friendRead ? '✓✓' : '✓'}
                      </span>
                    )}
                  </div>
                )}
                {(m.reactions ?? []).length > 0 && (
                  <div className="reactions">
                    {m.reactions.map((r) => (
                      <button
                        key={r.emoji}
                        type="button"
                        className={`reaction ${r.users.includes(me) ? 'mine' : ''}`}
                        title={r.users.join(', ')}
                        onClick={() => react(m.id, r.emoji)}
                      >
                        {r.emoji} {r.users.length}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {!isEditing && (
                <div className="msg-actions" role="toolbar">
                  <button type="button" title="Reagir" aria-label="Reagir" onClick={() => { setSelected(null); setPicker(picker === m.id ? null : m.id); }}><Icon name="smile" /></button>
                  {parts && <button type="button" title="Responder" aria-label="Responder" onClick={() => startReply(m)}><Icon name="reply" /></button>}
                  {canEdit(m) && <button type="button" title="Editar" aria-label="Editar" onClick={() => startEdit(m)}><Icon name="edit" /></button>}
                  {canDelete(m) && <button type="button" className="danger" title="Apagar" aria-label="Apagar" onClick={() => remove(m)}><Icon name="trash" /></button>}
                </div>
              )}
            </div>
          );
        })}
        <div ref={bottom} />
      </div>
      {mediaJobs.map((j) => <p key={j.id} className="media-status"><span className="spinner" /> {j.text}</p>)}
      {error && <p className="error">{error}</p>}
      {zoom && (
        <div className="lightbox" onClick={() => setZoom(null)}>
          <img src={zoom} alt="imagem" />
        </div>
      )}
      {picker === 'compose' && (
        <div className="picker-tabs">
          <button type="button" className={`chip${pickerTab === 'gif' ? ' active' : ''}`} onClick={() => setPickerTab('gif')}>GIF</button>
          <button type="button" className={`chip${pickerTab === 'emoji' ? ' active' : ''}`} onClick={() => setPickerTab('emoji')}>Emoji</button>
        </div>
      )}
      {picker === 'compose' && pickerTab === 'gif' && <GifPicker onPick={sendGif} />}
      {picker && !(picker === 'compose' && pickerTab === 'gif') && (
        <div className="emoji-picker">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className="emoji" onClick={() => pickEmoji(e)}>{e}</button>
          ))}
        </div>
      )}
      {rec && rec !== 'sending' && (
        <p className="notice rec-notice">
          🎙️ Ao enviar, o áudio é mandado ao servidor em claro só para a transcrição (Whisper) e descartado.
          Depois disso, áudio e texto ficam guardados apenas cifrados.
        </p>
      )}
      {replyTo && (
        <div className="reply-bar">
          <Icon name="reply" />
          <span>Respondendo a <b>{replyTo.from}</b></span>
          <span className="reply-preview">{replyTo.p}</span>
          <button type="button" className="link" title="Cancelar resposta" aria-label="Cancelar resposta" onClick={() => setReplyTo(null)}><Icon name="close" /></button>
        </div>
      )}
      <form className="composer" onSubmit={(e) => { setPicker(null); send(e); }}>
        <button type="button" className="link emoji-toggle" title="GIFs e emojis" aria-label="GIFs e emojis" disabled={!secret} onClick={() => setPicker((p) => (p === 'compose' ? null : 'compose'))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" /></svg>
        </button>
        <MessageInput
          ref={input}
          placeholder={secret ? 'Mensagem' : 'Informe a chave da conversa para enviar'}
          hidden={!!rec}
          disabled={!secret}
          onHasText={setHasText}
          onEscape={() => replyTo && setReplyTo(null)}
          onPaste={paste}
        />
        {rec ? (
          <div className="recording">
            {rec === 'sending' ? (
              <span>⏳ Enviando…</span>
            ) : (
              <>
                <span className="rec-dot">●</span>
                <span>{fmtTime(rec.seconds)}</span>
                <span className="rec-hint">{willCancel ? 'Solte para cancelar' : 'Solte para enviar · arraste ↑ para cancelar'}</span>
              </>
            )}
          </div>
        ) : null}
        <label className="attach" title="Enviar imagem, GIF ou MP4">
          📎
          <input type="file" hidden disabled={!secret} onChange={pick} />
        </label>
        {hasText && !rec ? (
          <button type="submit" className="round" title="Enviar" aria-label="Enviar" disabled={!secret}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11h12.17l-5.58-5.59L12 4l8 8-8 8-1.41-1.41L16.17 13H4z" /></svg>
          </button>
        ) : (
          <div className="mic-wrap">
            {rec && rec !== 'sending' && <div className={`trash${willCancel ? ' active' : ''}`}>🗑️</div>}
            <button
              type="button"
              className={`round mic${rec && rec !== 'sending' ? ' held' : ''}`}
              title="Segure para gravar mensagem de áudio"
              aria-label="Gravar mensagem de áudio"
              disabled={!secret || rec === 'sending'}
              onPointerDown={micDown}
              onPointerMove={micMove}
              onPointerUp={micUp}
              onPointerCancel={(e) => micUp(e, true)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2z" /></svg>
            </button>
          </div>
        )}
      </form>
    </section>
  );
}

// Cada conversa tem uma chave: o login do amigo ou, num servidor, o id dele com um prefixo que nenhum
// login pode ter (caractere de controle). Assim secrets, não lidas e canais usam o mesmo mapa.
const SERVER_PREFIX = '\u0001';
const serverKey = (id) => SERVER_PREFIX + id;
const isServerKey = (k) => typeof k === 'string' && k.startsWith(SERVER_PREFIX);
const serverIdOf = (k) => k.slice(1);
const targetOf = (k) => (isServerKey(k) ? { server: serverIdOf(k) } : { friend: k });

const SERVER_COLORS = ['#5865f2', '#2f6feb', '#1f9d8f', '#3fb950', '#d29922', '#e5484d', '#db61a2', '#a371f7'];
const initials = (name) => [...name.trim()].slice(0, 2).join('').toUpperCase();
const serverIcon = (s) => s.icon || initials(s.name);

// Rota na URL (#/amigo/canal ou #/@s/servidor/canal): o refresh volta para a mesma conversa e o botão
// voltar do aparelho funciona. "@s" sem codificar nunca é um login, pois o login vai codificado.
function routeFromHash() {
  const raw = location.hash.replace(/^#\/?/, '').split('/');
  const dec = (p) => {
    try { return decodeURIComponent(p ?? ''); } catch { return ''; }
  };
  if (raw[0] === '@s') {
    const id = dec(raw[1]);
    return id ? { key: serverKey(id), channel: dec(raw[2]) || 'main' } : null;
  }
  const friend = dec(raw[0]);
  return friend ? { key: friend, channel: dec(raw[1]) || 'main' } : null;
}
function hashFor(key, channel) {
  if (!key) return '';
  const ch = channel && channel !== 'main' ? `/${encodeURIComponent(channel)}` : '';
  return isServerKey(key) ? `#/@s/${encodeURIComponent(serverIdOf(key))}${ch}` : `#/${encodeURIComponent(key)}${ch}`;
}

const PlusIcon = () => (
  <svg className="plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z" /></svg>
);

function CreateServer({ onClose, onCreate }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('🚀');
  const [color, setColor] = useState(SERVER_COLORS[0]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim()) return setError('Dê um nome ao servidor');
    setBusy(true);
    setError('');
    try {
      await onCreate(name.trim(), icon, color);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <div className="share-overlay" onClick={onClose}>
      <form className="share-box create-server" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <h3>Criar servidor</h3>
        <div className="server-preview" style={{ background: color }}>{icon || initials(name) || '?'}</div>
        <input placeholder="Nome do servidor" maxLength={32} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <div className="swatches">
          {SERVER_COLORS.map((c) => (
            <button key={c} type="button" aria-label={`Cor ${c}`} className={`swatch${c === color ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />
          ))}
        </div>
        <div className="icon-grid">
          {EMOJIS.map((e) => (
            <button key={e} type="button" className={`emoji${e === icon ? ' on' : ''}`} onClick={() => setIcon(e)}>{e}</button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={busy}>Criar</button>
        <button type="button" className="secondary" onClick={onClose}>Cancelar</button>
      </form>
    </div>
  );
}

function Messenger({ me, onLogout }) {
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [active, setActive] = useState(() => routeFromHash()?.key ?? null);
  const [serverView, setServerView] = useState(() => { const k = routeFromHash()?.key; return isServerKey(k) ? serverIdOf(k) : null; }); // servidor aberto na lateral
  const [servers, setServers] = useState([]);
  const [serverInfo, setServerInfo] = useState(null); // detalhes (membros) do servidor aberto
  const [creating, setCreating] = useState(false);
  const [newMember, setNewMember] = useState('');
  const [newFriend, setNewFriend] = useState('');
  const [info, setInfo] = useState({ text: '', error: false });
  const [incoming, setIncoming] = useState(null);
  const [cleared, setCleared] = useState({}); // conversa -> canal -> contador; muda quando o canal é apagado
  const [channelsBy, setChannelsBy] = useState({}); // conversa -> [{ id, name }]
  const [channelOf, setChannelOf] = useState(() => { const r = routeFromHash(); return r ? { [r.key]: r.channel } : {}; }); // conversa -> canal aberto
  const [reactionEv, setReactionEv] = useState(null);
  const [readEv, setReadEv] = useState(null);
  const [editEv, setEditEv] = useState(null);
  const [deleteEv, setDeleteEv] = useState(null);
  const [avatars, setAvatars] = useState({});
  const [online, setOnline] = useState(() => new Set());
  const [share, setShare] = useState(null); // algo recebido pelo menu Compartilhar, aguardando escolher o amigo
  const [sharePick, setSharePick] = useState(null); // ... e depois de escolhido, entregue ao chat aberto
  useEffect(() => { takeShare().then((s) => s && setShare(s)); }, []);
  // chave de cada conversa (amigo), lembrada neste navegador; sai junto com o logout
  const [secrets, setSecrets] = useState(() => loadSecrets(me));
  const [unread, setUnread] = useState({}); // conversa -> canal -> não lidas
  const { call, audio, canShare, start: startCall, accept: acceptCall, hangup, toggleMute, startShare, stopShare, handle: handleCall } = useCall();
  useEffect(() => { blockUpdate('call', call.status !== 'idle'); }, [call.status]);
  const handleCallRef = useRef(handleCall);
  handleCallRef.current = handleCall;
  const [pushIssue, setPushIssue] = useState('');
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  // refs para o handler do WebSocket enxergar sempre o estado atual
  const activeRef = useRef(null);
  const secretsRef = useRef(secrets);
  const permRef = useRef(perm);
  const channelOfRef = useRef(channelOf);
  const channelsByRef = useRef(channelsBy);
  const serversRef = useRef(servers);
  const viewKeyRef = useRef(null);
  serversRef.current = servers;
  viewKeyRef.current = serverView ? serverKey(serverView) : null;
  channelOfRef.current = channelOf;
  channelsByRef.current = channelsBy;
  activeRef.current = active;
  secretsRef.current = secrets;
  permRef.current = perm;

  const say = (text, error = false) => setInfo({ text, error });

  const refresh = useCallback(async () => {
    const [f, r, b, on, sv, av] = await Promise.all([api.friends(), api.requests(), api.blocks(), api.presence().catch(() => []), api.servers().catch(() => null), api.avatars().catch(() => null)]);
    if (av) setAvatars(av);
    setOnline(new Set(on));
    setFriends(f);
    setRequests(r);
    setBlocked(b);
    if (sv) {
      setServers(sv);
      // saiu/foi removido/apagaram o servidor aberto
      setServerView((v) => (v && !sv.some((s) => s.id === v) ? null : v));
      setActive((a) => (isServerKey(a) && !sv.some((s) => serverKey(s.id) === a) ? null : a));
    }
    setActive((a) => (a && !isServerKey(a) && !f.includes(a) ? null : a));
  }, []);

  useEffect(() => {
    if (!serverView) return setServerInfo(null);
    let cancelled = false;
    api.server(serverView).then((i) => !cancelled && setServerInfo(i)).catch(() => {});
    return () => { cancelled = true; };
  }, [serverView, servers]);

  const loadChannels = useCallback(async (key) => {
    const list = await convApi(targetOf(key)).channels();
    setChannelsBy((c) => ({ ...c, [key]: list }));
    // o canal aberto pode ter sido apagado pelo outro lado
    setChannelOf((c) => (c[key] && !list.some((ch) => ch.id === c[key]) ? { ...c, [key]: 'main' } : c));
  }, []);

  const notifyMessage = useCallback(async (m) => {
    const key = m.server ? serverKey(m.server) : m.from;
    const openCh = channelOfRef.current[key] ?? 'main';
    if (document.hasFocus() && activeRef.current === key && openCh === m.channel) return;
    setUnread((u) => ({ ...u, [key]: { ...u[key], [m.channel]: (u[key]?.[m.channel] || 0) + 1 } }));
    if (permRef.current !== 'granted') return;
    const secret = secretsRef.current[key];
    const salt = `server:${m.server}`;
    const plain = secret && (await (m.server ? decryptText(m.data, secret, salt, salt) : decryptText(m.data, secret, me, m.from)));
    const inner = plain && messageOf(plain).body;
    const text = !inner ? 'Nova mensagem 🔒' : mediaOf(inner)?.kind === 'video' ? '🎬 Vídeo' : mediaOf(inner)?.kind === 'audio' ? '🎤 Áudio' : mediaOf(inner)?.kind === 'file' ? '📎 Arquivo' : mediaOf(inner) ? '📷 Imagem' : inner;
    const chName = (m.server || m.channel !== 'main') && channelsByRef.current[key]?.find((c) => c.id === m.channel)?.name;
    const place = m.server ? serversRef.current.find((s) => s.id === m.server)?.name ?? 'Servidor' : m.from;
    notify(chName ? `${place} · #${chName}` : place, {
      body: m.server ? `${m.from}: ${text}` : text,
      tag: `msg:${key}:${m.channel}`,
      data: { from: m.from, channel: m.channel, server: m.server },
    });
  }, [me]);
  // clique na notificação: o service worker avisa a página (ou abre o app com ?open=amigo&ch=canal)
  const openFromNotice = (key, ch) => {
    setChannelOf((c) => ({ ...c, [key]: ch }));
    openChat(key, ch);
  };
  const openFromNoticeRef = useRef(openFromNotice);
  openFromNoticeRef.current = openFromNotice;
  useEffect(() => {
    syncPush().then(setPushIssue);
    const params = new URLSearchParams(location.search);
    if (params.get('open') || params.get('server')) {
      openFromNoticeRef.current(params.get('server') ? serverKey(params.get('server')) : params.get('open'), params.get('ch') || 'main');
      history.replaceState(null, '', location.pathname);
    }
    const onMsg = (e) => e.data?.type === 'open-chat'
      && openFromNoticeRef.current(e.data.server ? serverKey(e.data.server) : e.data.from, e.data.channel);
    navigator.serviceWorker?.addEventListener('message', onMsg);
    return () => navigator.serviceWorker?.removeEventListener('message', onMsg);
  }, []);
  const notifyMessageRef = useRef(notifyMessage);
  notifyMessageRef.current = notifyMessage;

  const friendUnread = (f) => Object.values(unread[f] ?? {}).reduce((a, b) => a + b, 0);
  const total = Object.keys(unread).reduce((a, f) => a + friendUnread(f), 0);
  useEffect(() => {
    document.title = total ? `(${total}) Anonymous Messenger` : 'Anonymous Messenger';
  }, [total]);

  const clearUnread = (f, ch) => setUnread((u) => (u[f]?.[ch] ? { ...u, [f]: { ...u[f], [ch]: 0 } } : u));
  function openChat(key, ch = channelOfRef.current[key] ?? 'main') {
    setActive(key);
    setServerView(isServerKey(key) ? serverIdOf(key) : null);
    clearUnread(key, ch);
  }
  const viewKey = serverView ? serverKey(serverView) : null;
  // No celular a lista de canais e membros vem antes; no computador já abre a conversa.
  const openServer = (id) => {
    setServerView(id);
    if (matchMedia('(min-width: 701px)').matches) openChat(serverKey(id));
    else setActive(null);
  };
  const goHome = () => {
    setServerView(null);
    setActive(null);
  };
  const openServerChannel = (ch) => {
    setChannelOf((c) => ({ ...c, [viewKey]: ch }));
    openChat(viewKey, ch);
  };
  const openChannel = (ch) => {
    setChannelOf((c) => ({ ...c, [active]: ch }));
    clearUnread(active, ch);
  };
  const activeChannel = active ? channelOf[active] ?? 'main' : null;
  useEffect(() => {
    const clear = () => active && clearUnread(active, channelOfRef.current[active] ?? 'main');
    window.addEventListener('focus', clear);
    return () => window.removeEventListener('focus', clear);
  }, [active]);
  useEffect(() => {
    const want = hashFor(active, activeChannel);
    if (want !== (location.hash === '#' ? '' : location.hash)) {
      if (want) location.hash = want;
      else history.pushState(null, '', location.pathname + location.search);
    }
  }, [active, activeChannel]);
  useEffect(() => {
    const onHash = () => {
      const r = routeFromHash();
      if (!r) return setActive(null);
      openFromNoticeRef.current(r.key, r.channel);
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
  }, []);
  useEffect(() => { if (active) loadChannels(active).catch(() => {}); }, [active, loadChannels]);
  useEffect(() => { if (viewKey) loadChannels(viewKey).catch(() => {}); }, [viewKey, loadChannels]);

  useEffect(() => { refresh().catch(() => {}); }, [refresh]);

  // Soltar um arquivo fora da área do chat faria o navegador abri-lo e sair do app (derrubando a chamada).
  useEffect(() => {
    const stop = (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => { window.removeEventListener('dragover', stop); window.removeEventListener('drop', stop); };
  }, []);

  useEffect(() => {
    let ws;
    let closed = false;
    let delay = 1000;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
      ws = new WebSocket(`${proto}://${location.host}${basePath}/ws`);
      ws.onopen = () => { delay = 1000; refresh().catch(() => {}); }; // ao reconectar, ressincroniza (inclui quem está online)
      ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        if (ev.type === 'message') {
          setIncoming(ev.message);
          if (ev.message.from !== me) notifyMessageRef.current(ev.message);
        }
        if (ev.type === 'call') {
          handleCallRef.current(ev);
          if (ev.signal.type === 'invite' && permRef.current === 'granted' && !document.hasFocus()) {
            notify('Chamada de áudio', { body: `${ev.from} está ligando`, tag: `call:${ev.from}`, data: { from: ev.from } });
          }
        }
        const key = ev.server ? serverKey(ev.server) : ev.with; // conversa a que o evento se refere
        if (ev.type === 'cleared') {
          setCleared((c) => ({ ...c, [key]: { ...c[key], [ev.channel]: (c[key]?.[ev.channel] || 0) + 1 } }));
        }
        if (ev.type === 'reactions') setReactionEv(ev);
        if (ev.type === 'edited') setEditEv(ev);
        if (ev.type === 'deleted') setDeleteEv(ev);
        if (ev.type === 'avatar') {
          setAvatars((a) => {
            const n = { ...a };
            if (ev.v) n[ev.login] = ev.v; else delete n[ev.login];
            return n;
          });
        }
        if (ev.type === 'presence') {
          setOnline((s) => {
            const n = new Set(s);
            if (ev.online) n.add(ev.login); else n.delete(ev.login);
            return n;
          });
        }
        if (ev.type === 'read') setReadEv(ev);
        if (ev.type === 'channels' && (key === activeRef.current || key === viewKeyRef.current)) loadChannels(key).catch(() => {});
        if (ev.type === 'friend' || ev.type === 'request' || ev.type === 'servers') refresh().catch(() => {});
        if (ev.type === 'request' && permRef.current === 'granted' && !document.hasFocus()) {
          notify('Pedido de amizade', { body: `${ev.login} quer ser seu amigo`, tag: `req:${ev.login}` });
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
  }, [me, refresh, loadChannels]);

  const setSecret = (friend, value) => setSecrets((s) => {
    const next = { ...s, [friend]: value };
    if (!value) delete next[friend];
    saveSecrets(me, next);
    return next;
  });

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

  const view = servers.find((s) => s.id === serverView) ?? null; // servidor aberto na lateral
  const isOwner = view?.owner === me;
  const members = view && serverInfo?.id === view.id ? serverInfo.members : [];
  const dmUnread = Object.keys(unread).reduce((a, k) => a + (isServerKey(k) ? 0 : friendUnread(k)), 0);
  const activeServer = isServerKey(active) ? servers.find((s) => serverKey(s.id) === active) ?? null : null;

  const pickAvatar = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { v } = await api.setAvatar(await avatarBlob(file));
      setAvatars((a) => ({ ...a, [me]: v }));
    } catch (err) {
      say(err.message, true);
    }
  };
  const removeAvatar = async () => {
    try {
      await api.removeAvatar();
      setAvatars((a) => { const n = { ...a }; delete n[me]; return n; });
    } catch (err) {
      say(err.message, true);
    }
  };

  const createServer = async (name, icon, color) => {
    const server = await api.createServer(name, icon, color);
    await refresh();
    setCreating(false);
    openServer(server.id);
  };

  const newServerChannel = async () => {
    const name = window.prompt('Nome do novo canal:');
    if (!name?.trim()) return;
    try {
      const ch = await convApi({ server: view.id }).createChannel(name);
      await loadChannels(viewKey);
      openServerChannel(ch.id);
    } catch (err) {
      say(err.message, true);
    }
  };

  const addMember = async (e) => {
    e.preventDefault();
    const login = newMember.trim();
    if (!login) return;
    try {
      await api.addServerMember(view.id, login);
      say(`${login} entrou no servidor`);
      setNewMember('');
      await refresh();
    } catch (err) {
      say(err.message, true);
    }
  };

  const removeMember = (login) => window.confirm(`Remover ${login} do servidor ${view.name}?`) && act(() => api.removeServerMember(view.id, login), `${login} removido`);

  const dropServer = async (fn, text) => {
    if (!window.confirm(text)) return;
    const key = viewKey;
    try {
      await fn();
      setSecret(key, ''); // esquece a chave do servidor que não é mais seu
      await refresh();
    } catch (err) {
      say(err.message, true);
    }
  };
  const leaveServer = () => dropServer(() => api.removeServerMember(view.id, me), `Sair do servidor ${view.name}?`);
  const deleteServer = () => dropServer(
    () => api.deleteServer(view.id),
    `Apagar o servidor ${view.name} com todos os canais e mensagens, para todos os membros? Não pode ser desfeito.`
  );

  return (
    <AvatarsCtx.Provider value={avatars}>
    <div className={`app ${active ? 'in-chat' : ''}`}>
      <audio ref={audio} autoPlay />
      {(call.status !== 'idle' || call.error) && (
        <div className="call">
          {call.status === 'idle' ? (
            <>
              <span className="error">{call.error}</span>
              <button className="secondary" onClick={hangup}>OK</button>
            </>
          ) : (
            <>
              <span>
                {call.error && <span className="error">{call.error} · </span>}
                📞 {call.peer} —{' '}
                {{ calling: 'chamando…', incoming: 'chamada recebida', connecting: 'conectando…', active: 'em chamada' }[call.status]}
              </span>
              {call.status === 'incoming' && <button className="accept" onClick={acceptCall}>Atender</button>}
              {(call.status === 'connecting' || call.status === 'active') && (
                <button className="secondary" onClick={toggleMute}>{call.muted ? '🔇 Ativar mic' : '🎙️ Mutar'}</button>
              )}
              {call.status === 'active' && canShare && (
                <button className="secondary" onClick={call.sharing ? stopShare : startShare}>
                  {call.sharing ? '⏹ Parar tela' : '🖥️ Compartilhar tela'}
                </button>
              )}
              <button className="decline" onClick={hangup}>{call.status === 'incoming' ? 'Recusar' : 'Desligar'}</button>
            </>
          )}
        </div>
      )}
      {call.remoteScreen && (
        <div className="screen-view">
          <video
            autoPlay
            playsInline
            muted
            ref={(el) => { if (el && el.srcObject !== call.remoteScreen) el.srcObject = call.remoteScreen; }}
          />
          <button className="secondary" onClick={(e) => e.currentTarget.previousSibling.requestFullscreen?.()}>⛶ Tela cheia</button>
        </div>
      )}
      {share && (
        <div className="share-overlay" onClick={() => setShare(null)}>
          <div className="share-box" onClick={(e) => e.stopPropagation()}>
            <h3>Enviar para…</h3>
            <p className="share-what">
              {share.text && <span>{share.text.length > 120 ? `${share.text.slice(0, 120)}…` : share.text}</span>}
              {share.files.length > 0 && <span>📎 {share.files.length} arquivo{share.files.length > 1 ? 's' : ''}</span>}
            </p>
            <ul>
              {friends.map((f) => (
                <li key={f} onClick={() => { setSharePick({ friend: f, ...share }); setShare(null); openChat(f); }}>
                  <span><i className={`presence${online.has(f) ? ' on' : ''}`} />{f}</span>
                </li>
              ))}
            </ul>
            {!friends.length && <p className="share-what">Você ainda não tem amigos.</p>}
            <button type="button" className="secondary" onClick={() => setShare(null)}>Cancelar</button>
          </div>
        </div>
      )}
      {creating && <CreateServer onClose={() => setCreating(false)} onCreate={createServer} />}
      <nav className="rail" aria-label="Servidores">
        <button type="button" className={`rail-btn home${view ? '' : ' active'}`} title="Mensagens diretas" onClick={goHome}>
          💬{dmUnread > 0 && <span className="badge">{dmUnread}</span>}
        </button>
        <span className="rail-sep" />
        {servers.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`rail-btn${view?.id === s.id ? ' active' : ''}`}
            style={{ background: s.color }}
            title={s.name}
            onClick={() => openServer(s.id)}
          >
            {serverIcon(s)}
            {friendUnread(serverKey(s.id)) > 0 && <span className="badge">{friendUnread(serverKey(s.id))}</span>}
          </button>
        ))}
        <button type="button" className="rail-btn add" title="Criar servidor" aria-label="Criar servidor" onClick={() => setCreating(true)}><PlusIcon /></button>
      </nav>
      <aside className={view ? 'server-side' : undefined}>
        <div className="me">
          <label className="avatar-edit" title="Alterar avatar">
            <Avatar login={me} size={36} />
            <span className="edit-badge"><Icon name="edit" /></span>
            <input type="file" accept="image/*" hidden onChange={pickAvatar} />
          </label>
          <span className="me-name">{me}</span>
          {avatars[me] && <button type="button" className="link" title="Remover avatar" aria-label="Remover avatar" onClick={removeAvatar}><Icon name="close" /></button>}
          <button className="link" onClick={onLogout}>Sair</button>
        </div>
        {perm === 'default' && (
          <button onClick={() => enablePush().then((p) => { setPerm(p); syncPush().then(setPushIssue); })}>Ativar notificações</button>
        )}
        {pushIssue && <p className="error">{pushIssue}</p>}
        {view ? (
          <>
            <div className="server-head">
              <span className="server-icon" style={{ background: view.color }}>{serverIcon(view)}</span>
              <strong>{view.name}</strong>
            </div>
            {info.text && <p className={info.error ? 'error' : 'ok'}>{info.text}</p>}
            <h3 className="side-title">
              Canais
              {isOwner && <button type="button" className="link" title="Novo canal" onClick={newServerChannel}><PlusIcon /></button>}
            </h3>
            <ul>
              {(channelsBy[viewKey] ?? DEFAULT_CHANNELS).map((c) => (
                <li key={c.id} className={active === viewKey && activeChannel === c.id ? 'active' : ''} onClick={() => openServerChannel(c.id)}>
                  <span># {c.name}</span>
                  {unread[viewKey]?.[c.id] > 0 && <span className="badge">{unread[viewKey][c.id]}</span>}
                </li>
              ))}
            </ul>
            <h3 className="side-title">Membros — {members.length}</h3>
            <ul>
              {members.map((m) => (
                <li key={m} className="member">
                  <span><i className={`presence${m === me || online.has(m) ? ' on' : ''}`} />{m}{m === view.owner && ' 👑'}</span>
                  {isOwner && m !== me && (
                    <button type="button" className="link danger" title="Remover do servidor" onClick={() => removeMember(m)}>✕</button>
                  )}
                </li>
              ))}
            </ul>
            {isOwner && (
              <form onSubmit={addMember}>
                <input
                  list="addable-friends"
                  placeholder="Adicionar amigo ao servidor"
                  value={newMember}
                  onChange={(e) => setNewMember(e.target.value)}
                />
                <datalist id="addable-friends">
                  {friends.filter((f) => !members.includes(f)).map((f) => <option key={f} value={f} />)}
                </datalist>
              </form>
            )}
            <button type="button" className="secondary danger" onClick={isOwner ? deleteServer : leaveServer}>
              {isOwner ? 'Apagar servidor' : 'Sair do servidor'}
            </button>
          </>
        ) : (
          <>
        <form onSubmit={addFriend}>
          <input type="email" placeholder="Adicionar amigo (e-mail dele)" value={newFriend} onChange={(e) => setNewFriend(e.target.value)} />
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
              <span><i className={`presence${online.has(f) ? ' on' : ''}`} title={online.has(f) ? 'online' : 'offline'} />{f}</span>{friendUnread(f) > 0 && <span className="badge">{friendUnread(f)}</span>}
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
          </>
        )}
      </aside>
      {active && (!isServerKey(active) || activeServer) ? (
        <ErrorBoundary global={false} key={`${active}/${activeChannel}`}>
        <Chat
          me={me}
          friend={active}
          server={activeServer}
          canManage={activeServer ? activeServer.owner === me : true}
          memberCount={activeServer && serverInfo?.id === activeServer.id ? serverInfo.members.length : undefined}
          channel={activeChannel}
          channels={channelsBy[active] ?? DEFAULT_CHANNELS}
          unreadCh={unread[active] ?? {}}
          onChannel={openChannel}
          onCreateChannel={async (name) => {
            const ch = await convApi(targetOf(active)).createChannel(name);
            await loadChannels(active);
            openChannel(ch.id);
          }}
          onDeleteChannel={async (id) => {
            await convApi(targetOf(active)).deleteChannel(id);
            openChannel('main');
            await loadChannels(active);
          }}
          reactionEv={reactionEv}
          online={online.has(active)}
          pendingShare={sharePick?.friend === active ? sharePick : null}
          onShareDone={() => setSharePick(null)}
          editEv={editEv}
          deleteEv={deleteEv}
          readEv={readEv}
          secret={secrets[active] || ''}
          onSecretChange={(v) => setSecret(active, v)}
          incoming={incoming}
          cleared={cleared[active]?.[activeChannel] || 0}
          onCall={() => startCall(active)}
          callBusy={call.status !== 'idle'}
          onBack={() => setActive(null)}
          onRemove={() => window.confirm(`Desfazer a amizade com ${active}? Todas as mensagens e arquivos da conversa serão apagados para os dois lados e não dá para recuperar.`) && act(() => api.removeFriend(active))}
          onBlock={() => window.confirm(`Bloquear ${active}?`) && act(() => api.block(active))}
        />
        </ErrorBoundary>
      ) : (
        <section className="chat empty">{view ? 'Selecione um canal' : 'Selecione ou adicione um amigo'}</section>
      )}
    </div>
    </AvatarsCtx.Provider>
  );
}

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = verificando a sessão

  // Link do e-mail: <base>/confirmar-email?token=...
  const [confirmToken] = useState(() =>
    location.pathname.replace(/\/$/, '').endsWith('/confirmar-email') ? new URLSearchParams(location.search).get('token') : null
  );

  const [resetToken] = useState(() =>
    location.pathname.replace(/\/$/, '').endsWith('/redefinir-senha') ? new URLSearchParams(location.search).get('token') : null
  );

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
    await disablePush();
    saveSecrets(me, {});
    await api.logout().catch(() => {});
    setMe(null);
  };

  if (resetToken && !me) return <ResetPassword token={resetToken} onAuth={setMe} />;
  if (confirmToken && !me) return <ConfirmEmail token={confirmToken} onAuth={setMe} />;
  return me ? <Messenger me={me} onLogout={logout} /> : <AuthScreen onAuth={setMe} />;
}

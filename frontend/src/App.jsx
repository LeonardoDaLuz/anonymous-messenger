import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import GifPicker from './GifPicker.jsx';
import ErrorBoundary from './ErrorBoundary.jsx';
import { useCall } from './useCall.js';
import { blockUpdate } from './updater.js';
import { disablePush, enablePush, notify, syncPush } from './push.js';
import { embedOf, splitLinks } from './embeds.js';
import { audioMessage, cryptoAvailable, decryptText, encryptText, gifToDataUrl, imageToDataUrl, mediaOf, mp4ToDataUrl } from './crypto.js';

const EMOJIS = [...'😀😃😄😁😆😅😂🤣🙂😉😊😇🥰😍🤩😘😋😛😜🤪🤔🤨😐😑😶🙄😏😒😞😔😟😕🙁😮😲😳🥺😢😭😤😠😡🤬🤯😱😨😰😥😓🤗🤭🤫😴🤤😷🤒🤕🤢🤮🥳😎🤓🧐👍👎👌✌️🤞🤟🤘👏🙌🙏💪👋🤝👀🧠❤️🧡💛💚💙💜🖤💔💕💖🔥✨🎉🎂🎁💯✅❌⚠️❓❗💤💩👻💀🤖🐶🐱🐭🐸🐵🍕🍔🍟🍺☕⚽🎮🎵🚀🌈☀️🌙⭐'.matchAll(/\p{Extended_Pictographic}(?:\uFE0F)?(?:\u200D\p{Extended_Pictographic}\uFE0F?)*/gu)].map((m) => m[0]);

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

function Chat({
  me, friend, channel, channels, unreadCh, onChannel, onCreateChannel, onDeleteChannel,
  secret, onSecretChange, incoming, reactionEv, editEv, online, readEv, cleared, onBack, onRemove, onBlock, onCall, callBusy,
}) {
  const [raw, setRaw] = useState([]);
  const [plain, setPlain] = useState({});
  const [text, setText] = useState('');
  const [error, setError] = useState('');
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

  useEffect(() => {
    let cancelled = false;
    setRaw([]);
    setHasMore(false);
    stick.current = true;
    api.messages(friend, channel)
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
    if ((from === friend && to === me) || (from === me && to === friend)) {
      if (from === me) stick.current = true; // ao enviar, vai para o fim
      setRaw((prev) => (prev.some((m) => m.id === incoming.id) ? prev : [...prev, incoming]));
    }
  }, [incoming, friend, me, channel]);

  useEffect(() => {
    if (!editEv || editEv.channel !== channel) return;
    if (!raw.some((m) => m.id === editEv.id)) return;
    delete cache.current.map[editEv.id]; // decifra de novo com o conteúdo atualizado
    setRaw((prev) => prev.map((m) => (m.id === editEv.id ? { ...m, data: editEv.data } : m)));
  }, [editEv]);

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
      cur.map[m.id] = await decryptText(m.data, secret, me, friend);
      changed = true;
    }
    if (changed && cache.current === cur) setPlain({ ...cur.map });
  };

  useEffect(() => { decryptMissing(raw); }, [raw, secret, me, friend]);

  useEffect(() => {
    if (readEv && readEv.with === friend && readEv.channel === channel) setFriendRead((r) => Math.max(r, readEv.seq));
  }, [readEv]);

  // Marca como lido o que o amigo mandou, mas só se a janela está em foco, a lista no fim e a mensagem decifrada.
  const markRead = () => {
    if (!document.hasFocus() || document.visibilityState !== 'visible' || !stick.current) return;
    const last = raw.reduce((a, m) => (m.from === friend && m.seq > a && plain[m.id] != null ? m.seq : a), 0);
    if (last > readSent.current) {
      readSent.current = last;
      api.markRead(friend, channel, last).catch(() => {});
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
      const r = await api.messages(friend, channel, raw[0].seq);
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
    if (!text.trim() || !secret) return;
    setError('');
    try {
      await api.send(friend, channel, await encryptText(text, secret, me, friend));
      setText('');
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
    if (window.confirm(`Apagar o canal #${name} e todas as mensagens dele, para os dois lados? Não pode ser desfeito.`)) {
      await onDeleteChannel(channel);
    }
  });

  const react = guard((id, emoji) => api.react(friend, id, emoji));

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

  // a caixa cresce com as linhas (até um limite) e volta ao tamanho de uma linha ao esvaziar
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [text, rec]);

  const addEmoji = (emoji) => {
    const el = input.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + emoji + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + emoji.length, start + emoji.length);
    });
  };

  const sendImage = async (file) => {
    if (!secret) return;
    setError('');
    try {
      const url = file.type === 'image/gif' ? await gifToDataUrl(file)
        : file.type === 'video/mp4' ? await mp4ToDataUrl(file)
        : await imageToDataUrl(file);
      await api.send(friend, channel, await encryptText(url, secret, me, friend));
    } catch (err) {
      setError(err.message);
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
      sent = await api.send(friend, channel, await encryptText(await audioMessage(blob, '', duration), secret, me, friend));
    } finally {
      setRec(null);
    }
    transcribeLater(sent.id, blob, duration, { friend, secret });
  });

  const transcribeLater = async (id, blob, duration, { friend, secret }) => {
    setTranscribing((s) => new Set(s).add(id));
    try {
      const text = (await api.transcribe(blob)).text.trim();
      if (text) await api.editMessage(friend, id, await encryptText(await audioMessage(blob, text, duration), secret, me, friend));
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
  const sendFiles = async (files) => {
    if (!secret) return setError('Informe a chave da conversa para enviar arquivos');
    const ok = files.filter((f) => f.type.startsWith('image/') || f.type === 'video/mp4');
    if (!ok.length) return setError('Só é possível enviar imagens, GIFs e MP4');
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
    const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/') || f.type === 'video/mp4');
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
    if (!window.confirm(`Apagar permanentemente todas as mensagens de #${name} com ${friend}? Isso apaga para os dois lados e não pode ser desfeito.`)) return;
    setError('');
    try {
      await api.clearMessages(friend, channel);
    } catch (err) {
      setError(err.message);
    }
  };

  const show = (m) => {
    if (!secret) return <em className="locked">🔒 {m.data.slice(0, 40)}…</em>;
    if (plain[m.id] === undefined) return '…';
    const p = plain[m.id];
    if (p == null) return <em className="locked">🔒 chave incorreta</em>;
    const media = mediaOf(p);
    if (media?.kind === 'audio') return <VoiceMessage media={media} pending={transcribing.has(m.id)} />;
    if (!media) {
      const embed = embedOf(p);
      return <><Linkified text={p} />{embed && <EmbedCard embed={embed} />}</>;
    }
    if (media.kind === 'video') {
      return <video src={media.src} controls loop muted playsInline preload="metadata" referrerPolicy="no-referrer" />;
    }
    return <img src={media.src} alt="imagem" referrerPolicy="no-referrer" onClick={() => setZoom(media.src)} />;
  };

  return (
    <section className="chat" {...dnd}>
      {dragging && <div className="drop-overlay">Solte para enviar (imagens, GIFs ou MP4)</div>}
      <header>
        <button type="button" className="link back" onClick={onBack}>←</button>
        <strong>{friend}<small className={`status${online ? ' on' : ''}`}>{online ? 'online' : 'offline'}</small></strong>
        <button type="button" className="link" title="Chamada de áudio" disabled={callBusy} onClick={onCall}>📞</button>
        <button type="button" className="link" onClick={onRemove}>Remover</button>
        <button type="button" className="link danger" onClick={clear}>Limpar chat</button>
        <button type="button" className="link danger" onClick={onBlock}>Bloquear</button>
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
          placeholder="Chave da conversa"
          value={secret}
          onChange={(e) => onSecretChange(e.target.value)}
        />
      </header>
      <nav className="channels">
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
        <button type="button" className="chip" title="Novo canal" onClick={newChannel}>＋</button>
        {channel !== 'main' && <button type="button" className="chip" title="Apagar este canal" onClick={delChannel}>🗑</button>}
      </nav>
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
        {raw.map((m) => (
          <div key={m.id} className={`msg ${m.from === me ? 'mine' : 'theirs'}`}>
            {show(m)}
            <time>
              {new Date(m.ts).toLocaleTimeString()}
              {m.from === me && (
                <span className={`ticks ${m.seq <= friendRead ? 'read' : ''}`} title={m.seq <= friendRead ? 'Lida' : 'Enviada'}>
                  {m.seq <= friendRead ? '✓✓' : '✓'}
                </span>
              )}
            </time>
            <div className="reactions">
              {(m.reactions ?? []).map((r) => (
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
              <button type="button" className="reaction react-add" title="Reagir" onClick={() => setPicker(picker === m.id ? null : m.id)}>☺＋</button>
            </div>
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
      <form className="composer" onSubmit={(e) => { setPicker(null); send(e); }}>
        <button type="button" className="link emoji-toggle" title="GIFs e emojis" aria-label="GIFs e emojis" disabled={!secret} onClick={() => setPicker((p) => (p === 'compose' ? null : 'compose'))}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm3.5-9c.83 0 1.5-.67 1.5-1.5S16.33 8 15.5 8 14 8.67 14 9.5s.67 1.5 1.5 1.5zm-7 0c.83 0 1.5-.67 1.5-1.5S9.33 8 8.5 8 7 8.67 7 9.5 7.67 11 8.5 11zm3.5 6.5c2.33 0 4.31-1.46 5.11-3.5H6.89c.8 2.04 2.78 3.5 5.11 3.5z" /></svg>
        </button>
        <textarea
          ref={input}
          rows={1}
          placeholder={secret ? 'Mensagem' : 'Informe a chave da conversa para enviar'}
          value={text}
          style={rec ? { display: 'none' } : undefined}
          disabled={!secret}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Enter envia e Shift+Enter quebra a linha; no celular (teclado de toque) Enter quebra a linha
            if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || matchMedia('(pointer: coarse)').matches) return;
            e.preventDefault();
            e.currentTarget.form.requestSubmit();
          }}
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
          <input type="file" accept="image/*,video/mp4" hidden disabled={!secret} onChange={pick} />
        </label>
        {text.trim() && !rec ? (
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

// Rota na URL (#/amigo/canal): o refresh volta para a mesma conversa e o botão voltar do aparelho funciona.
function routeFromHash() {
  const [friend, channel] = location.hash.replace(/^#\/?/, '').split('/').map((p) => {
    try { return decodeURIComponent(p); } catch { return ''; }
  });
  return friend ? { friend, channel: channel || 'main' } : null;
}
const hashFor = (friend, channel) => (friend ? `#/${encodeURIComponent(friend)}${channel && channel !== 'main' ? `/${encodeURIComponent(channel)}` : ''}` : '');

function Messenger({ me, onLogout }) {
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [active, setActive] = useState(() => routeFromHash()?.friend ?? null);
  const [newFriend, setNewFriend] = useState('');
  const [info, setInfo] = useState({ text: '', error: false });
  const [incoming, setIncoming] = useState(null);
  const [cleared, setCleared] = useState({}); // amigo -> canal -> contador; muda quando o canal é apagado
  const [channelsBy, setChannelsBy] = useState({}); // amigo -> [{ id, name }]
  const [channelOf, setChannelOf] = useState(() => { const r = routeFromHash(); return r ? { [r.friend]: r.channel } : {}; }); // amigo -> canal aberto
  const [reactionEv, setReactionEv] = useState(null);
  const [readEv, setReadEv] = useState(null);
  const [editEv, setEditEv] = useState(null);
  const [online, setOnline] = useState(() => new Set());
  // chave de cada conversa (amigo), lembrada neste navegador; sai junto com o logout
  const [secrets, setSecrets] = useState(() => loadSecrets(me));
  const [unread, setUnread] = useState({}); // amigo -> canal -> não lidas
  const { call, audio, canShare, start: startCall, accept: acceptCall, hangup, toggleMute, startShare, stopShare, handle: handleCall } = useCall();
  useEffect(() => { blockUpdate('call', call.status !== 'idle'); }, [call.status]);
  const handleCallRef = useRef(handleCall);
  handleCallRef.current = handleCall;
  const [perm, setPerm] = useState(() => ('Notification' in window ? Notification.permission : 'denied'));
  // refs para o handler do WebSocket enxergar sempre o estado atual
  const activeRef = useRef(null);
  const secretsRef = useRef(secrets);
  const permRef = useRef(perm);
  const channelOfRef = useRef(channelOf);
  const channelsByRef = useRef(channelsBy);
  channelOfRef.current = channelOf;
  channelsByRef.current = channelsBy;
  activeRef.current = active;
  secretsRef.current = secrets;
  permRef.current = perm;

  const say = (text, error = false) => setInfo({ text, error });

  const refresh = useCallback(async () => {
    const [f, r, b, on] = await Promise.all([api.friends(), api.requests(), api.blocks(), api.presence().catch(() => [])]);
    setOnline(new Set(on));
    setFriends(f);
    setRequests(r);
    setBlocked(b);
    setActive((a) => (a && !f.includes(a) ? null : a));
  }, []);

  const loadChannels = useCallback(async (friend) => {
    const list = await api.channels(friend);
    setChannelsBy((c) => ({ ...c, [friend]: list }));
    // o canal aberto pode ter sido apagado pelo outro lado
    setChannelOf((c) => (c[friend] && !list.some((ch) => ch.id === c[friend]) ? { ...c, [friend]: 'main' } : c));
  }, []);

  const notifyMessage = useCallback(async (m) => {
    const openCh = channelOfRef.current[m.from] ?? 'main';
    if (document.hasFocus() && activeRef.current === m.from && openCh === m.channel) return;
    setUnread((u) => ({ ...u, [m.from]: { ...u[m.from], [m.channel]: (u[m.from]?.[m.channel] || 0) + 1 } }));
    if (permRef.current !== 'granted') return;
    const secret = secretsRef.current[m.from];
    const plain = secret && (await decryptText(m.data, secret, me, m.from));
    const body = !plain ? 'Nova mensagem 🔒' : mediaOf(plain)?.kind === 'video' ? '🎬 Vídeo' : mediaOf(plain)?.kind === 'audio' ? '🎤 Áudio' : mediaOf(plain) ? '📷 Imagem' : plain;
    const chName = m.channel !== 'main' && channelsByRef.current[m.from]?.find((c) => c.id === m.channel)?.name;
    notify(chName ? `${m.from} · #${chName}` : m.from, { body, tag: `msg:${m.from}:${m.channel}`, data: { from: m.from, channel: m.channel } });
  }, [me]);
  // clique na notificação: o service worker avisa a página (ou abre o app com ?open=amigo&ch=canal)
  const openFromNotice = (f, ch) => {
    setChannelOf((c) => ({ ...c, [f]: ch }));
    openChat(f, ch);
  };
  const openFromNoticeRef = useRef(openFromNotice);
  openFromNoticeRef.current = openFromNotice;
  useEffect(() => {
    syncPush();
    const params = new URLSearchParams(location.search);
    if (params.get('open')) {
      openFromNoticeRef.current(params.get('open'), params.get('ch') || 'main');
      history.replaceState(null, '', location.pathname);
    }
    const onMsg = (e) => e.data?.type === 'open-chat' && openFromNoticeRef.current(e.data.from, e.data.channel);
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
  function openChat(f, ch = channelOfRef.current[f] ?? 'main') {
    setActive(f);
    clearUnread(f, ch);
  }
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
      openFromNoticeRef.current(r.friend, r.channel);
    };
    window.addEventListener('hashchange', onHash);
    window.addEventListener('popstate', onHash);
    return () => { window.removeEventListener('hashchange', onHash); window.removeEventListener('popstate', onHash); };
  }, []);
  useEffect(() => { if (active) loadChannels(active).catch(() => {}); }, [active, loadChannels]);

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
        if (ev.type === 'cleared') {
          setCleared((c) => ({ ...c, [ev.with]: { ...c[ev.with], [ev.channel]: (c[ev.with]?.[ev.channel] || 0) + 1 } }));
        }
        if (ev.type === 'reactions') setReactionEv(ev);
        if (ev.type === 'edited') setEditEv(ev);
        if (ev.type === 'presence') {
          setOnline((s) => {
            const n = new Set(s);
            if (ev.online) n.add(ev.login); else n.delete(ev.login);
            return n;
          });
        }
        if (ev.type === 'read') setReadEv(ev);
        if (ev.type === 'channels' && ev.with === activeRef.current) loadChannels(ev.with).catch(() => {});
        if (ev.type === 'friend' || ev.type === 'request') refresh().catch(() => {});
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

  return (
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
      <aside>
        <div className="me">
          <span>{me}</span>
          <button className="link" onClick={onLogout}>Sair</button>
        </div>
        {perm === 'default' && (
          <button onClick={() => enablePush().then(setPerm)}>Ativar notificações</button>
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
      </aside>
      {active ? (
        <ErrorBoundary global={false} key={`${active}/${activeChannel}`}>
        <Chat
          me={me}
          friend={active}
          channel={activeChannel}
          channels={channelsBy[active] ?? DEFAULT_CHANNELS}
          unreadCh={unread[active] ?? {}}
          onChannel={openChannel}
          onCreateChannel={async (name) => {
            const ch = await api.createChannel(active, name);
            await loadChannels(active);
            openChannel(ch.id);
          }}
          onDeleteChannel={async (id) => {
            await api.deleteChannel(active, id);
            openChannel('main');
            await loadChannels(active);
          }}
          reactionEv={reactionEv}
          online={online.has(active)}
          editEv={editEv}
          readEv={readEv}
          secret={secrets[active] || ''}
          onSecretChange={(v) => setSecret(active, v)}
          incoming={incoming}
          cleared={cleared[active]?.[activeChannel] || 0}
          onCall={() => startCall(active)}
          callBusy={call.status !== 'idle'}
          onBack={() => setActive(null)}
          onRemove={() => window.confirm(`Remover ${active} dos amigos?`) && act(() => api.removeFriend(active))}
          onBlock={() => window.confirm(`Bloquear ${active}?`) && act(() => api.block(active))}
        />
        </ErrorBoundary>
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
    await disablePush();
    saveSecrets(me, {});
    await api.logout().catch(() => {});
    setMe(null);
  };

  return me ? <Messenger me={me} onLogout={logout} /> : <AuthScreen onAuth={setMe} />;
}

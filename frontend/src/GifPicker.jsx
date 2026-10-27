import { useEffect, useRef, useState } from 'react';
import { api } from './api.js';

// Busca de GIFs (Klipy, via backend). Sem texto mostra os GIFs em alta.
export default function GifPicker({ onPick }) {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const seq = useRef(0);

  // nova busca (com atraso enquanto digita) ou próxima página
  useEffect(() => {
    const mine = ++seq.current;
    const t = setTimeout(() => {
      setLoading(true);
      api.gifs(query.trim(), page)
        .then((r) => {
          if (mine !== seq.current) return;
          setError('');
          setItems((prev) => (page === 1 ? r.items : [...prev, ...r.items.filter((i) => !prev.some((p) => p.id === i.id))]));
          setHasNext(r.hasNext);
        })
        .catch((e) => mine === seq.current && setError(e.message))
        .finally(() => mine === seq.current && setLoading(false));
    }, page === 1 && query ? 350 : 0);
    return () => clearTimeout(t);
  }, [query, page]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    if (hasNext && !loading && el.scrollTop + el.clientHeight >= el.scrollHeight - 120) setPage((p) => p + 1);
  };

  return (
    <div className="gif-picker">
      <input
        type="search"
        placeholder="Buscar GIFs"
        value={query}
        onChange={(e) => { setQuery(e.target.value); setPage(1); }}
      />
      <div className="gif-grid" onScroll={onScroll}>
        {items.map((g) => (
          <button key={g.id} type="button" className="gif-item" title={g.title} onClick={() => onPick(g.src)}>
            <img src={api.gifMediaUrl(g.preview)} alt={g.title} loading="lazy" style={{ aspectRatio: `${g.w} / ${g.h}` }} />
          </button>
        ))}
        {!items.length && !loading && !error && <p className="gif-note">Nenhum GIF encontrado</p>}
        {error && <p className="gif-note error">{error}</p>}
        {loading && <p className="gif-note">Carregando…</p>}
      </div>
    </div>
  );
}

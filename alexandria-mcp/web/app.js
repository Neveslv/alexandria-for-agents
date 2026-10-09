(() => {
  'use strict';

  const VIEWS = ['buscar', 'capturas', 'conexoes', 'saude'];
  const loaded = new Set();

  const el = (id) => document.getElementById(id);
  const tokenInput = el('token');
  const workbench = document.querySelector('.workbench');
  const reader = el('reader');

  let current = { path: '', title: '' };

  tokenInput.value = sessionStorage.getItem('alexandria-token') || '';
  tokenInput.addEventListener('change', () => {
    sessionStorage.setItem('alexandria-token', tokenInput.value.trim());
  });

  // ── Transporte ──────────────────────────────────────────

  function headers(hasBody) {
    const h = {};
    if (hasBody) h['content-type'] = 'application/json';
    const token = tokenInput.value.trim();
    if (token) h['X-Alexandria-Token'] = token;
    return h;
  }

  async function api(path, options = {}) {
    let res;
    try {
      res = await fetch(path, options);
    } catch {
      return { ok: false, status: 0, body: null, reason: 'O servidor não respondeu. Confirme que ele está rodando em 127.0.0.1.' };
    }
    const text = await res.text();
    let body = text;
    try { body = JSON.parse(text); } catch { /* texto puro */ }
    if (res.ok) return { ok: true, status: res.status, body };
    return { ok: false, status: res.status, body, reason: failureReason(res.status, body) };
  }

  function failureReason(status, body) {
    const message = body && typeof body === 'object' ? body.message : String(body || '');
    if (status === 401) return 'Este servidor exige token. Abra "Token" no topo e cole o valor de X-Alexandria-Token.';
    if (status === 403) return 'Requisição bloqueada. Acesse pelo endereço 127.0.0.1 no próprio computador.';
    if (status === 404) return message || 'Nada encontrado nesse caminho.';
    return message || `Falha ${status}.`;
  }

  const get = (path) => api(path, { headers: headers(false) });
  const post = (path, payload) => api(path, {
    method: 'POST',
    headers: headers(true),
    body: JSON.stringify(payload),
  });

  // ── Formatação ──────────────────────────────────────────

  function relTime(value) {
    const ts = Date.parse(value);
    if (!Number.isFinite(ts)) return '';
    const days = Math.floor((Date.now() - ts) / 86400000);
    if (days <= 0) return 'hoje';
    if (days === 1) return 'ontem';
    if (days < 30) return `há ${days} dias`;
    const months = Math.round(days / 30);
    if (months < 12) return `há ${months} ${months === 1 ? 'mês' : 'meses'}`;
    const years = Math.round(days / 365);
    return `há ${years} ${years === 1 ? 'ano' : 'anos'}`;
  }

  function categoryOf(item) {
    if (item.category) return item.category;
    const slash = String(item.path || '').indexOf('/');
    return slash > 0 ? item.path.slice(0, slash) : 'raiz';
  }

  function terms(query) {
    return String(query || '')
      .split(/\s+/)
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, ''))
      .filter((word) => word.length >= 3)
      .slice(0, 8);
  }

  // Marca os termos da busca sem passar por innerHTML.
  function highlighted(text, query) {
    const frag = document.createDocumentFragment();
    const list = terms(query);
    if (!list.length) {
      frag.append(text);
      return frag;
    }
    const re = new RegExp(`(${list.join('|')})`, 'gi');
    let last = 0;
    for (const match of text.matchAll(re)) {
      if (match.index > last) frag.append(text.slice(last, match.index));
      const mark = document.createElement('mark');
      mark.textContent = match[0];
      frag.append(mark);
      last = match.index + match[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  // O frontmatter é ruído no resumo: separa metadados do texto que a pessoa escreveu.
  function splitFrontmatter(raw) {
    const text = String(raw || '');
    const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!match) return { meta: [], body: text };
    const meta = match[1].split(/\r?\n/).reduce((acc, line) => {
      const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.+)$/);
      if (pair) acc.push([pair[1], pair[2].replace(/^["']|["']$/g, '')]);
      return acc;
    }, []);
    return { meta, body: text.slice(match[0].length) };
  }

  // O snippet do índice chega com as quebras colapsadas, então o frontmatter
  // aparece como "--- title: ... ---" no meio da frase. Corta os dois formatos.
  function cleanExcerpt(raw, title) {
    let text = splitFrontmatter(raw).body;
    if (text.trimStart().startsWith('---')) {
      const start = text.indexOf('---');
      const end = text.indexOf('---', start + 3);
      if (end !== -1) text = text.slice(end + 3);
    }
    text = text.replace(/\s+/g, ' ').trim();
    const heading = String(title || '').trim();
    if (heading) {
      const lead = new RegExp(`^#{1,6}\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'i');
      text = text.replace(lead, '');
    }
    return text.trim();
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function setMeta(target, text, isError) {
    target.textContent = text;
    target.classList.toggle('is-error', Boolean(isError));
  }

  function showEmpty(container, lines) {
    container.replaceChildren();
    const box = node('div', 'empty');
    lines.forEach((line, index) => {
      if (index) box.append(document.createElement('br'));
      box.append(line);
    });
    container.append(box);
  }

  // ── Cartão de resultado ─────────────────────────────────

  function hitCard(item, options = {}) {
    const card = node('button', 'hit');
    card.type = 'button';

    const top = node('div', 'hit-top');
    top.append(node('span', 'hit-title', item.title || item.path || 'sem título'));
    const when = relTime(item.modified);
    if (when) top.append(node('span', 'hit-when', when));
    card.append(top);

    if (typeof options.strength === 'number') {
      const bar = node('div', 'hit-score');
      const fill = node('span');
      fill.style.width = `${Math.max(6, Math.round(options.strength * 100))}%`;
      bar.append(fill);
      card.append(bar);
    }

    const excerpt = cleanExcerpt(item.snippet || item.matched_text || item.summary || '', item.title);
    if (excerpt) {
      const snippet = node('p', 'hit-snippet');
      snippet.append(highlighted(excerpt.slice(0, 320), options.query));
      card.append(snippet);
    }

    const foot = node('div', 'hit-foot');
    foot.append(node('span', options.chipWarn ? 'chip warn' : 'chip', options.chip || categoryOf(item)));
    foot.append(node('span', 'hit-path', item.path || ''));
    card.append(foot);

    card.addEventListener('click', () => {
      if (options.onOpen) options.onOpen(item);
      else openNote(item.path, item.title);
    });

    if (options.actions && options.actions.length) {
      const row = node('div', 'hit-actions');
      for (const action of options.actions) {
        const button = node('button', 'ghost', action.label);
        button.type = 'button';
        button.addEventListener('click', (event) => {
          event.stopPropagation();
          action.run(item, button);
        });
        row.append(button);
      }
      card.append(row);
    }

    return card;
  }

  function renderHits(container, items, options = {}) {
    container.replaceChildren();
    const top = Math.max(...items.map((item) => Number(item.score) || 0), 0);
    for (const item of items) {
      const strength = top > 0 && Number.isFinite(Number(item.score))
        ? Number(item.score) / top
        : undefined;
      container.append(hitCard(item, { ...options, strength }));
    }
  }

  // ── Leitor ──────────────────────────────────────────────

  // Renderiza o markdown do vault: títulos, listas, citações, código,
  // observações tipadas (- [decision] ...) e wikilinks que abrem a nota citada.
  function inline(target, text) {
    const re = /\[\[([^\]]+)\]\]|`([^`]+)`|\*\*([^*]+)\*\*/g;
    let last = 0;
    for (const match of text.matchAll(re)) {
      if (match.index > last) target.append(text.slice(last, match.index));
      if (match[1] !== undefined) {
        const link = node('button', 'wikilink', match[1].split('|')[0]);
        link.type = 'button';
        link.addEventListener('click', () => openNote(match[1].split('|')[0], match[1].split('|')[0]));
        target.append(link);
      } else if (match[2] !== undefined) {
        target.append(node('code', null, match[2]));
      } else {
        target.append(node('strong', null, match[3]));
      }
      last = match.index + match[0].length;
    }
    if (last < text.length) target.append(text.slice(last));
  }

  function renderMarkdown(container, raw) {
    const { meta, body } = splitFrontmatter(raw);
    container.replaceChildren();

    if (meta.length) {
      const strip = node('dl', 'note-meta');
      for (const [key, value] of meta.slice(0, 6)) {
        strip.append(node('dt', null, key));
        strip.append(node('dd', null, value));
      }
      container.append(strip);
    }

    let list = null;
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();

      if (!trimmed) { list = null; continue; }

      const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        list = null;
        const level = Math.min(heading[1].length + 1, 6);
        const title = node(`h${level}`, 'note-h');
        inline(title, heading[2]);
        container.append(title);
        continue;
      }

      if (/^([-*_])\1{2,}$/.test(trimmed)) { list = null; container.append(node('hr')); continue; }

      const bullet = trimmed.match(/^[-*+]\s+(.*)$/);
      if (bullet) {
        if (!list) { list = node('ul', 'note-list'); container.append(list); }
        const li = document.createElement('li');
        const typed = bullet[1].match(/^\[([a-z_]+)\]\s+(.*)$/i);
        if (typed) {
          li.append(node('span', 'obs', typed[1]));
          inline(li, typed[2]);
        } else {
          inline(li, bullet[1]);
        }
        list.append(li);
        continue;
      }

      list = null;
      const quote = trimmed.match(/^>\s?(.*)$/);
      if (quote) {
        const block = node('blockquote', 'note-quote');
        inline(block, quote[1]);
        container.append(block);
        continue;
      }

      const paragraph = node('p', 'note-p');
      inline(paragraph, trimmed);
      container.append(paragraph);
    }

    if (!container.childNodes.length) container.append(node('p', 'note-p', '(nota vazia)'));
  }

  function markSelected(path) {
    document.querySelectorAll('.hit').forEach((hit) => hit.classList.remove('on'));
    document.querySelectorAll('.hit-path').forEach((label) => {
      if (label.textContent === path) label.closest('.hit')?.classList.add('on');
    });
  }

  async function openNote(path, title) {
    if (!path) return;
    current = { path, title: title || path };
    reader.hidden = false;
    workbench.classList.add('reading');
    el('reader-title').textContent = current.title;
    el('reader-path').textContent = path;
    markSelected(path);

    const body = el('reader-body');
    body.className = 'reader-body is-loading';
    body.textContent = 'Abrindo nota…';

    const res = await get(`/v1/note?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      body.className = 'reader-body is-error';
      body.textContent = res.status === 404
        ? 'Esta nota saiu do vault ou foi renomeada. Refaça a busca para pegar o caminho atual.'
        : res.reason;
      return;
    }
    body.className = 'reader-body';
    renderMarkdown(body, res.body.content);
    body.scrollTop = 0;
  }

  function closeReader() {
    reader.hidden = true;
    workbench.classList.remove('reading');
    document.querySelectorAll('.hit').forEach((hit) => hit.classList.remove('on'));
  }

  el('reader-close').addEventListener('click', closeReader);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !reader.hidden) closeReader();
  });

  el('reader-copy').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    try {
      await navigator.clipboard.writeText(current.path);
      button.textContent = 'Caminho copiado';
    } catch {
      button.textContent = 'Copie manualmente da linha acima';
    }
    setTimeout(() => { button.textContent = 'Copiar caminho'; }, 2000);
  });

  el('reader-graph').addEventListener('click', () => {
    el('graph-input').value = current.path;
    location.hash = '#conexoes';
    loadGraph(current.path);
  });

  // ── Buscar ──────────────────────────────────────────────

  el('ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = el('ask-query').value.trim();
    if (!query) return;

    const meta = el('ask-meta');
    const out = el('ask-results');
    const raw = el('ask-raw');
    setMeta(meta, 'Procurando no vault…');
    out.replaceChildren();
    raw.hidden = true;

    const started = performance.now();
    const res = await post('/v1/ask', { query, limit: 8 });
    const ms = Math.round(performance.now() - started);

    if (!res.ok) {
      setMeta(meta, res.reason, true);
      return;
    }

    const items = Array.isArray(res.body.items) ? res.body.items : [];
    el('ask-raw-body').textContent = [res.body.recall, res.body.search]
      .filter(Boolean).join('\n\n———\n\n');
    raw.hidden = false;

    if (!items.length) {
      setMeta(meta, `Nenhuma nota casou com "${query}" · ${ms} ms`);
      showEmpty(out, [
        'O índice não achou nada com esses termos.',
        'Tente palavras que você realmente escreveu na nota, ou veja o texto completo da resposta abaixo.',
      ]);
      return;
    }

    setMeta(meta, `${items.length} ${items.length === 1 ? 'nota' : 'notas'} para "${query}" · ${ms} ms · clique para ler`);
    renderHits(out, items, { query });
  });

  // ── Capturas ────────────────────────────────────────────

  async function loadInbox() {
    const meta = el('inbox-meta');
    const out = el('inbox-results');
    setMeta(meta, 'Lendo capturas…');

    const res = await post('/v1/search', {
      query: 'inbox',
      category: 'sessions',
      tags: ['inbox'],
      limit: 20,
    });
    if (!res.ok) {
      setMeta(meta, res.reason, true);
      out.replaceChildren();
      return;
    }

    const items = Array.isArray(res.body.items) ? res.body.items : [];
    if (!items.length) {
      setMeta(meta, 'Nenhuma captura pendente.');
      showEmpty(out, [
        'A fila está vazia — tudo que você capturou já foi arquivado.',
        'Novas capturas chegam por POST /v1/capture ou pelo bot.',
      ]);
      return;
    }

    setMeta(meta, `${items.length} ${items.length === 1 ? 'captura' : 'capturas'} na fila · clique para ler antes de promover`);
    renderHits(out, items, {
      chip: 'captura',
      actions: [{
        label: 'Promover',
        run: async (item, button) => {
          button.disabled = true;
          button.textContent = 'Promovendo…';
          const promoted = await post('/v1/promote', { path: item.path });
          if (!promoted.ok) {
            button.disabled = false;
            button.textContent = 'Promover';
            setMeta(meta, promoted.reason, true);
            return;
          }
          const target = promoted.body.canonical_path || '';
          setMeta(meta, `Promovida para ${target}`);
          loadInbox();
          if (target) openNote(target, item.title);
        },
      }],
    });
  }

  el('inbox-refresh').addEventListener('click', loadInbox);

  // ── Conexões ────────────────────────────────────────────

  el('graph-form').addEventListener('submit', (event) => {
    event.preventDefault();
    loadGraph(el('graph-input').value.trim());
  });

  async function loadGraph(reference) {
    if (!reference) return;
    const meta = el('graph-meta');
    const out = el('graph-results');
    setMeta(meta, 'Seguindo os links…');
    out.replaceChildren();

    const key = reference.includes('/') || reference.endsWith('.md') ? 'path' : 'title';
    const res = await get(`/v1/graph?${key}=${encodeURIComponent(reference)}`);
    if (!res.ok) {
      if (res.status === 404) {
        setMeta(meta, `Nenhuma nota chamada "${reference}"`, true);
        showEmpty(out, [
          'O índice não tem uma nota com esse título nem com esse caminho.',
          'Busque a nota em Buscar e use o botão "Ver conexões" — ele preenche o caminho exato.',
        ]);
        return;
      }
      setMeta(meta, res.reason, true);
      return;
    }

    const source = res.body.source || {};
    const edges = Array.isArray(res.body.edges) ? res.body.edges : [];
    const nodes = Array.isArray(res.body.nodes) ? res.body.nodes : [];
    const byPath = new Map(nodes.map((item) => [item.path, item]));

    const outgoing = edges.filter((edge) => edge.from === source.path);
    const incoming = edges.filter((edge) => edge.to === source.path);

    setMeta(meta, `${source.title || source.path} · cita ${outgoing.length} · citada por ${incoming.length}`);

    const anchor = hitCard({ ...source, snippet: 'Nota de partida. Clique para ler.' }, {
      chip: 'partida',
      onOpen: () => openNote(source.path, source.title),
    });
    out.append(anchor);

    const groups = [
      { title: 'Esta nota cita', list: outgoing, other: (edge) => edge.to },
      { title: 'Citada por', list: incoming, other: (edge) => edge.from },
    ];

    for (const group of groups) {
      if (!group.list.length) continue;
      out.append(node('p', 'group-head', `${group.title} (${group.list.length})`));
      for (const edge of group.list) {
        const path = group.other(edge);
        const target = byPath.get(path) || { path, title: path };
        out.append(hitCard(
          { ...target, snippet: `relação: ${edge.relation_type || 'wikilink'}` },
          {
            chip: categoryOf(target),
            actions: [{
              label: 'Centrar aqui',
              run: () => {
                el('graph-input').value = target.path;
                loadGraph(target.path);
              },
            }],
            onOpen: () => openNote(target.path, target.title),
          },
        ));
      }
    }

    if (!outgoing.length && !incoming.length) {
      showEmpty(out, [
        'Esta nota está isolada: não cita ninguém e ninguém cita ela.',
        'Adicione wikilinks como [[Outra nota]] para conectá-la ao resto do vault.',
      ]);
    }
  }

  // ── Saúde ───────────────────────────────────────────────

  async function loadHealth() {
    const tiles = el('health-tiles');
    const out = el('health-results');
    const raw = el('health-raw');
    tiles.replaceChildren(node('p', 'meta', 'Lendo o índice…'));
    out.replaceChildren();
    raw.hidden = true;

    const res = await get('/v1/vault/health?limit=20');
    if (!res.ok) {
      tiles.replaceChildren();
      setMeta(out.appendChild(node('p', 'meta')), res.reason, true);
      return;
    }

    const counts = res.body.counts || {};
    const orphans = res.body.orphans || [];
    const stale = res.body.stale || [];
    const failures = res.body.index_failures || [];

    tiles.replaceChildren();
    const cards = [
      { k: 'notas indexadas', n: counts.pages ?? counts.total_pages ?? '—' },
      { k: 'sem backlinks', n: counts.orphans ?? orphans.length, warn: (counts.orphans ?? orphans.length) > 0 },
      { k: 'paradas há 30+ dias', n: counts.stale ?? stale.length },
      { k: 'falhas de leitura', n: counts.index_failures ?? failures.length, warn: failures.length > 0 },
    ];
    for (const card of cards) {
      const tile = node('div', 'tile');
      tile.append(node('div', `tile-n${card.warn ? ' warn' : ''}`, String(card.n)));
      tile.append(node('div', 'tile-k', card.k));
      tiles.append(tile);
    }

    el('health-raw-body').textContent = res.body.stats || '';
    raw.hidden = !res.body.stats;

    if (failures.length) {
      out.append(node('p', 'group-head', `Arquivos que o índice não leu (${failures.length})`));
      for (const failure of failures) {
        out.append(hitCard(
          { path: failure.path, title: failure.path, snippet: failure.message },
          { chip: 'falha', chipWarn: true, onOpen: () => openNote(failure.path, failure.path) },
        ));
      }
    }

    if (orphans.length) {
      out.append(node('p', 'group-head', `Sem ninguém apontando para elas (${orphans.length})`));
      for (const orphan of orphans) {
        out.append(hitCard(
          { ...orphan, snippet: 'Nenhuma outra nota cita esta. Vale conectar ou arquivar.' },
          { chip: categoryOf(orphan), actions: [{
            label: 'Ver conexões',
            run: () => { el('graph-input').value = orphan.path; location.hash = '#conexoes'; loadGraph(orphan.path); },
          }] },
        ));
      }
    }

    if (stale.length) {
      out.append(node('p', 'group-head', `Paradas há mais de 30 dias (${stale.length})`));
      for (const item of stale) {
        out.append(hitCard(
          { ...item, snippet: `Última edição ${relTime(item.modified)}.` },
          { chip: categoryOf(item) },
        ));
      }
    }

    if (!failures.length && !orphans.length && !stale.length) {
      showEmpty(out, [
        'Vault saudável: tudo conectado, tudo recente, nada ilegível.',
        'Volte aqui depois de uma leva grande de capturas.',
      ]);
    }
  }

  el('health-refresh').addEventListener('click', loadHealth);

  // ── Navegação ───────────────────────────────────────────

  function setView(name) {
    const view = VIEWS.includes(name) ? name : 'buscar';
    for (const id of VIEWS) {
      el(`view-${id}`).hidden = id !== view;
      const tab = document.querySelector(`[data-view="${id}"]`);
      tab.classList.toggle('on', id === view);
      if (id === view) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    if (view === 'capturas' && !loaded.has('capturas')) { loaded.add('capturas'); loadInbox(); }
    if (view === 'saude' && !loaded.has('saude')) { loaded.add('saude'); loadHealth(); }
    if (view === 'buscar') el('ask-query').focus({ preventScroll: true });
  }

  window.addEventListener('hashchange', () => setView(location.hash.slice(1)));
  setView(location.hash.slice(1) || 'buscar');

  // ── Estado do servidor ──────────────────────────────────

  (async () => {
    const status = el('status');
    const res = await get('/v1/healthz');
    if (res.ok) {
      status.className = 'status is-ok';
      status.textContent = 'índice respondendo';
      return;
    }
    status.className = 'status is-down';
    status.textContent = res.status === 0 ? 'servidor offline' : `servidor devolveu ${res.status}`;
  })();
})();

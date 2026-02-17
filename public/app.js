(() => {
  const socket = io();

  // DOM refs
  const joinSection = document.getElementById('joinSection');
  const chatSection = document.getElementById('chatSection');
  const joinForm = document.getElementById('joinForm');
  const nameInput = document.getElementById('nameInput');
  const groupInput = document.getElementById('groupInput');
  const onlineEl = document.getElementById('online');
  const usersList = document.getElementById('usersList');
  const messagesEl = document.getElementById('messages');
  const messageForm = document.getElementById('messageForm');
  const messageInput = document.getElementById('messageInput');
  const fileInput = document.getElementById('fileInput');
  const typingEl = document.getElementById('typing');
  const lightbox = document.getElementById('lightbox');
  const lbMedia = lightbox ? lightbox.querySelector('[data-role="media"]') : null;
  const lbDownload = lightbox ? lightbox.querySelector('[data-role="download"]') : null;
  const lbBackdrop = lightbox ? lightbox.querySelector('[data-role="backdrop"]') : null;

  let me = null;
  let typingTimeout = null;
  const seenLocal = new Set();
  let observer = null;
  let lastSentMessageId = null;

  // notification sound using Web Audio API
  function playNotificationSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.02;
      o.connect(g);
      g.connect(ctx.destination);
      o.start(0);
      setTimeout(() => { o.stop(); ctx.close(); }, 120);
    } catch (e) {
      // fallback: no audio
      console.warn('sound error', e);
    }
  }

  function ensureObserver() {
    if (observer) return observer;
    observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting && entry.intersectionRatio > 0.4) {
          const el = entry.target;
          const mid = el.dataset.id;
          if (mid && !seenLocal.has(mid)) {
            socket.emit('seen', { messageId: mid });
            seenLocal.add(mid);
          }
        }
      });
    }, { root: messagesEl, threshold: [0.4] });
    return observer;
  }

  function makeAvatar(name) {
    const initials = (name || 'A').split(' ').map(s => s[0]).slice(0,2).join('').toUpperCase();
    const hue = Math.floor((Array.from((name||'')).reduce((s,c)=>s+c.charCodeAt(0),0) % 360));
    return { initials, color: `hsl(${hue} 60% 45%)` };
  }

  function showSection(joined) {
    if (joined) {
      joinSection.classList.add('hidden');
      chatSection.classList.remove('hidden');
    } else {
      joinSection.classList.remove('hidden');
      chatSection.classList.add('hidden');
    }
  }

  function prependMessage(node) { messagesEl.appendChild(node); messagesEl.scrollTop = messagesEl.scrollHeight; }

  function renderMessage(m) {
    const d = new Date(m.ts || Date.now());
    const box = document.createElement('div');
    box.className = 'message';
    box.dataset.id = m.id || '';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = m.from.avatar && m.from.avatar.color ? m.from.avatar.color : '#888';
    avatar.textContent = m.from.avatar && m.from.avatar.initials ? m.from.avatar.initials : (m.from.name||'A').charAt(0).toUpperCase();

    const body = document.createElement('div');
    body.className = 'body';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `${m.from.name} ${m.from.group ? '('+m.from.group+')' : ''}`;
    const time = document.createElement('span'); time.className = 'time'; time.textContent = d.toLocaleTimeString();
    head.appendChild(time);

    const text = document.createElement('div'); text.className = 'text';
    text.textContent = m.text || '';

    body.appendChild(head);
    body.appendChild(text);

  if (m.file) {
      const f = m.file;
      const container = document.createElement('div'); container.className = 'file';
      // Create media element with a small thumbnail preview, click to open full size, and a download button
      if (f.mime.startsWith('image/')) {
        const img = document.createElement('img'); img.src = f.url; img.alt = f.originalName || 'image'; img.className = 'media thumbnail';
        img.style.cursor = 'pointer';
        img.addEventListener('click', () => openLightbox(f.url, f.mime, f.originalName));
        container.appendChild(img);
        // download button
        const dl = document.createElement('a'); dl.href = f.url; dl.className = 'download-btn'; dl.textContent = 'Download'; dl.setAttribute('download', f.originalName || 'image'); dl.style.marginLeft = '8px'; container.appendChild(dl);
      } else if (f.mime.startsWith('video/')) {
        const wrapper = document.createElement('div'); wrapper.className = 'video-wrap';
        const v = document.createElement('video'); v.src = f.url; v.controls = true; v.preload = 'none'; v.className = 'media thumbnail'; v.style.cursor = 'pointer';
        // clicking opens the media in the page lightbox
        v.addEventListener('click', () => openLightbox(f.url, f.mime, f.originalName));
        wrapper.appendChild(v);
        container.appendChild(wrapper);
        const dl = document.createElement('a'); dl.href = f.url; dl.className = 'download-btn'; dl.textContent = 'Download'; dl.setAttribute('download', f.originalName || 'video'); dl.style.marginLeft = '8px'; container.appendChild(dl);
      } else if (f.mime.startsWith('audio/')) {
        const a = document.createElement('audio'); a.src = f.url; a.controls = true; a.preload = 'none'; container.appendChild(a);
        const dl = document.createElement('a'); dl.href = f.url; dl.className = 'download-btn'; dl.textContent = 'Download'; dl.setAttribute('download', f.originalName || 'audio'); dl.style.marginLeft = '8px'; container.appendChild(dl);
      } else {
        const a = document.createElement('a'); a.href = f.url; a.textContent = f.originalName || 'file'; a.target = '_blank'; container.appendChild(a);
        const dl = document.createElement('a'); dl.href = f.url; dl.className = 'download-btn'; dl.textContent = 'Download'; dl.setAttribute('download', f.originalName || 'file'); dl.style.marginLeft = '8px'; container.appendChild(dl);
      }
      body.appendChild(container);
    }

    box.appendChild(avatar);
    box.appendChild(body);

  // reactions container
  const reactionsWrap = document.createElement('div'); reactionsWrap.className = 'reactions-wrap';
  const reactionsInner = document.createElement('div'); reactionsInner.className = 'reactions-inner';
  reactionsWrap.appendChild(reactionsInner);
  body.appendChild(reactionsWrap);

  // seen receipts container (shown only for your most recent sent message)
  const seenWrap = document.createElement('div'); seenWrap.className = 'seen-wrap';
  const seenInner = document.createElement('div'); seenInner.className = 'seen-inner';
  seenWrap.appendChild(seenInner);
  box.appendChild(seenWrap);

    return box;
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim() || 'Anonymous';
    const group = groupInput.value.trim();
    const avatar = makeAvatar(name);
    me = { name, group, avatar };
    socket.emit('join', { name, group, avatar });
    showSection(true);
    // reveal header and focus message input
    const hdr = document.getElementById('siteHeader'); if (hdr) hdr.classList.remove('hidden');
    setTimeout(() => { if (messageInput) messageInput.focus(); }, 250);
    // request persisted history from server
    socket.emit('request-history', { limit: 300 });
  });

  socket.on('userlist', (payload) => {
    onlineEl.textContent = `Online: ${payload.count}`;
    usersList.innerHTML = '';
    payload.list.forEach(u => {
      const li = document.createElement('li');
      const av = document.createElement('span'); av.className = 'miniavatar'; av.style.background = u.avatar && u.avatar.color ? u.avatar.color : '#666'; av.textContent = u.avatar && u.avatar.initials ? u.avatar.initials : (u.name||'A').charAt(0).toUpperCase();
      li.appendChild(av);
      const t = document.createElement('span'); t.textContent = `${u.name}${u.group ? ' ('+u.group+')' : ''}`;
      li.appendChild(t);
      usersList.appendChild(li);
    });
  });

  socket.on('user-joined', (u) => {
    const info = document.createElement('div'); info.className = 'sys'; info.textContent = `${u.name} joined the chat.`; messagesEl.appendChild(info); messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  socket.on('user-left', (u) => {
    const info = document.createElement('div'); info.className = 'sys'; info.textContent = `${u.name} left.`; messagesEl.appendChild(info); messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  socket.on('message', (m) => {
    const node = renderMessage(m);
    messagesEl.appendChild(node);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // Do not immediately mark as seen; observe and emit when visible
    if (m.id) {
      ensureObserver().observe(node);
    }
    // set lastSentMessageId when a message from me arrives
    if (m.from && m.from.id && m.from.id === socket.id) {
      lastSentMessageId = m.id;
    } else {
      // play notification for messages from others
      playNotificationSound();
    }
  });

  // load persisted history when we join
  socket.on('history', (msgs) => {
    if (!Array.isArray(msgs)) return;
    messagesEl.innerHTML = '';
    msgs.forEach(m => {
      const node = renderMessage(m);
      messagesEl.appendChild(node);
      if (m.id) {
        ensureObserver().observe(node);
        // render reactions if present
        if (m.reactions) {
          socket.emit('noop'); // no-op, reactions will be pushed via reaction-update when joining (or we could render here)
        }
      }
    });
    messagesEl.scrollTop = messagesEl.scrollHeight;
  });

  // seen updates from server
  socket.on('seen-update', (p) => {
    // p: { messageId, seen: [ {id, name, group, avatar} ] }
    const mid = p.messageId;
    const seen = p.seen || [];
    // only show seen avatars on the most recent message YOU sent (messenger style)
    if (mid !== lastSentMessageId) return;
    const msgEl = messagesEl.querySelector(`.message[data-id="${mid}"]`);
    if (!msgEl) return;
    const seenInner = msgEl.querySelector('.seen-inner');
    if (!seenInner) return;
    seenInner.innerHTML = '';
    // show up to 6 small avatars
    seen.slice(0,6).forEach(s => {
      const sp = document.createElement('span'); sp.className = 'seen-avatar';
      sp.style.background = s.avatar && s.avatar.color ? s.avatar.color : '#555';
      sp.textContent = s.avatar && s.avatar.initials ? s.avatar.initials : (s.name||'A').charAt(0).toUpperCase();
      sp.title = s.name;
      seenInner.appendChild(sp);
    });
    if (seen.length > 6) {
      const more = document.createElement('span'); more.className = 'seen-more'; more.textContent = `+${seen.length-6}`;
      seenInner.appendChild(more);
    }
  });

  socket.on('typing', (t) => {
    if (t.typing) {
      typingEl.textContent = `${t.name} is typing...`;
    } else {
      typingEl.textContent = '';
    }
  });

  // server-side message errors (e.g., empty message rejected)
  socket.on('message-error', (p) => {
    if (!p) return;
    if (p.reason === 'empty') {
      alert('Your message was empty and was not sent. Please type a message or attach a file.');
    }
  });

  // reaction updates
  socket.on('reaction-update', (p) => {
    // p: { messageId, reactions: { emoji: [ {id,name,group,avatar}, ... ] } }
    const mid = p.messageId;
    const reactions = p.reactions || {};
    const msgEl = messagesEl.querySelector(`.message[data-id="${mid}"]`);
    if (!msgEl) return;
    const reactionsInner = msgEl.querySelector('.reactions-inner');
    if (!reactionsInner) return;
    reactionsInner.innerHTML = '';
    Object.keys(reactions).forEach(em => {
      const arr = reactions[em] || [];
      const btn = document.createElement('button'); btn.className = 'reaction-btn'; btn.textContent = `${em} ${arr.length}`;
      // highlight if me reacted
      const reacted = arr.find(a => a.id === socket.id);
      if (reacted) btn.classList.add('reacted');
      btn.addEventListener('click', () => {
        socket.emit('react', { messageId: mid, emoji: em });
      });
      reactionsInner.appendChild(btn);
    });
    // allow adding a new reaction quickly
    const picker = document.createElement('div'); picker.className = 'reaction-picker';
    ['👍','❤️','😂','😮','😢','👏'].forEach(em => {
      const pbtn = document.createElement('button'); pbtn.className = 'reaction-mini'; pbtn.textContent = em;
      pbtn.addEventListener('click', () => socket.emit('react', { messageId: mid, emoji: em }));
      picker.appendChild(pbtn);
    });
    reactionsInner.appendChild(picker);
  });

  // message send + upload flow
  messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!me) return alert('Please join first');
    const text = messageInput.value.trim();
    const file = fileInput.files[0];
    let fileInfo = null;
    if (file) {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) { alert('Upload failed'); return; }
      const j = await res.json();
      fileInfo = { url: j.url, mime: j.mime, originalName: j.originalName };
    }

    // prevent sending an empty message (no text and no file)
    if (!text && !fileInfo) {
      // small inline feedback
      alert('Please enter a message or attach a file before sending.');
      return;
    }

    socket.emit('message', { text, file: fileInfo });
    messageInput.value = '';
    fileInput.value = '';
    socket.emit('typing', false);
  });

  // typing indicator
  messageInput.addEventListener('input', () => {
    socket.emit('typing', true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { socket.emit('typing', false); }, 1200);
  });

  // Paste-to-upload support: allow users to paste images/videos/audio from clipboard
  async function handlePasteEvent(e) {
    try {
      if (!me) return; // require joined
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file') {
          const file = it.getAsFile();
          if (!file) continue;
          // only accept image/audio/video types
          if (!file.type || !(file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/'))) continue;
          e.preventDefault();
          const fd = new FormData();
          fd.append('file', file, file.name || 'pasted');
          const res = await fetch('/upload', { method: 'POST', body: fd });
          if (!res.ok) { console.warn('Paste upload failed'); continue; }
          const j = await res.json();
          const fileInfo = { url: j.url, mime: j.mime, originalName: j.originalName };
          socket.emit('message', { text: '', file: fileInfo });
        }
      }
    } catch (err) {
      console.error('Paste upload error', err);
    }
  }

  document.addEventListener('paste', (e) => { handlePasteEvent(e); });

  // Lightbox open/close helpers
  function openLightbox(url, mime, name) {
    if (!lightbox || !lbMedia) { window.open(url, '_blank', 'noopener'); return; }
    // clear existing
    lbMedia.innerHTML = '';
    let el = null;
    if (mime && mime.startsWith('image/')) {
      el = document.createElement('img'); el.src = url; el.alt = name || 'image';
    } else if (mime && mime.startsWith('video/')) {
      el = document.createElement('video'); el.src = url; el.controls = true; el.preload = 'metadata'; el.playsInline = true;
    } else if (mime && mime.startsWith('audio/')) {
      el = document.createElement('audio'); el.src = url; el.controls = true; el.preload = 'metadata';
    } else {
      // fallback - open in new tab
      window.open(url, '_blank', 'noopener'); return;
    }
    el.className = 'lb-inner-media';
    lbMedia.appendChild(el);
    // set download link
    if (lbDownload) { lbDownload.href = url; lbDownload.setAttribute('download', name || 'file'); }
    lightbox.classList.remove('hidden'); lightbox.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.add('hidden'); lightbox.setAttribute('aria-hidden', 'true');
    if (lbMedia) lbMedia.innerHTML = '';
    document.body.style.overflow = '';
  }

  if (lightbox) {
    const closeBtn = lightbox.querySelector('.lb-close');
    if (closeBtn) closeBtn.addEventListener('click', closeLightbox);
    if (lbBackdrop) lbBackdrop.addEventListener('click', closeLightbox);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLightbox(); });
  }

})();

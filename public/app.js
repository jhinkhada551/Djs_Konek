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
  const attachmentPreviewEl = document.getElementById('attachmentPreview');
  const profanityWarningEl = document.getElementById('profanityWarning');
  const emojiBtn = document.getElementById('emojiBtn');
  const gifBtn = document.getElementById('gifBtn');
  const lightbox = document.getElementById('lightbox');
  const lbMedia = lightbox ? lightbox.querySelector('[data-role="media"]') : null;
  const lbDownload = lightbox ? lightbox.querySelector('[data-role="download"]') : null;
  const lbBackdrop = lightbox ? lightbox.querySelector('[data-role="backdrop"]') : null;

  let me = null;
  let typingTimeout = null;
  const seenLocal = new Set();
  let observer = null;
  let lastSentMessageId = null;
  // Jump-to-latest button
  const jumpBtn = document.createElement('button');
  jumpBtn.className = 'jump-latest hidden';
  jumpBtn.textContent = 'Latest';
  jumpBtn.title = 'Jump to latest message';
  // append to chatArea
  const chatArea = document.getElementById('chatArea');
  if (chatArea) chatArea.appendChild(jumpBtn);

  // Attachment state (queued until user presses Send)
  let pendingAttachment = null; // { file, url, mime, originalName, isGif }

  // Emoji & GIF data (small curated set)
  const EMOJIS = ['😊','😂','❤️','👍','🔥','😮','😢','🎉','👏','🙌','😉','😎'];
  const GIFS = [
    '/uploads/sample-gif-1.gif','/uploads/sample-gif-2.gif','/uploads/sample-gif-3.gif',
    'https://media.giphy.com/media/3oEjI6SIIHBdRxXI40/giphy.gif','https://media.giphy.com/media/l0HlQ7LRalQw1zT7W/giphy.gif'
  ];

  // Profanity lists (simple, extendable) - English and Filipino (examples)
  const PROFANITY = [
    'fuck','shit','bitch','asshole','damn',
    'tangina','putangina','gago','ulol','tanginamo'
  ];

  function detectProfanity(text) {
    if (!text) return [];
    const found = new Set();
    const lower = text.toLowerCase();
    PROFANITY.forEach(word => {
      const re = new RegExp('\\b'+word.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+'\\b','i');
      if (re.test(lower)) found.add(word);
    });
    return Array.from(found);
  }

  function censorText(text) {
    let out = text;
    PROFANITY.forEach(word => {
      const re = new RegExp('\\b('+word.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+')\\b','ig');
      out = out.replace(re, (m) => {
        if (m.length <= 2) return '*'.repeat(m.length);
        const head = m[0]; const tail = m[m.length-1];
        return head + '*'.repeat(m.length-2) + tail;
      });
    });
    return out;
  }

  // Emoji & GIF picker UI (simple floating panels)
  const emojiPicker = document.createElement('div'); emojiPicker.className = 'emoji-picker';
  const emojiGrid = document.createElement('div'); emojiGrid.className = 'emoji-grid';
  EMOJIS.forEach(em => { const b = document.createElement('button'); b.type='button'; b.className='emoji-btn'; b.textContent = em; b.addEventListener('click', () => {
    insertAtCursor(messageInput, em); emojiPicker.style.display='none';
  }); emojiGrid.appendChild(b); });
  emojiPicker.appendChild(emojiGrid); document.body.appendChild(emojiPicker);

  const gifPicker = document.createElement('div'); gifPicker.className='gif-picker';
  const gifGrid = document.createElement('div'); gifGrid.className='gif-grid';
  GIFS.forEach(url => { const img = document.createElement('img'); img.src = url; img.addEventListener('click', () => {
    // set pendingAttachment as gif (no upload)
    pendingAttachment = { file: null, url, mime: 'image/gif', originalName: 'gif.gif', isGif: true };
    showAttachmentPreview(pendingAttachment);
    gifPicker.style.display='none';
  }); gifGrid.appendChild(img); });
  gifPicker.appendChild(gifGrid); document.body.appendChild(gifPicker);

  // helper to insert emoji at cursor
  function insertAtCursor(el, text) {
    const start = el.selectionStart || 0; const end = el.selectionEnd || 0;
    const v = el.value || '';
    el.value = v.slice(0,start) + text + v.slice(end);
    const pos = start + text.length; el.setSelectionRange(pos,pos); el.focus();
  }

  // show/hide pickers
  emojiBtn.addEventListener('click', (e)=>{
    const r = emojiBtn.getBoundingClientRect(); emojiPicker.style.left = (r.left)+'px'; emojiPicker.style.top = (r.bottom+6)+'px'; emojiPicker.style.display = emojiPicker.style.display === 'block' ? 'none':'block';
    gifPicker.style.display='none';
  });
  gifBtn.addEventListener('click', ()=>{ const r = gifBtn.getBoundingClientRect(); gifPicker.style.left=(r.left)+'px'; gifPicker.style.top=(r.bottom+6)+'px'; gifPicker.style.display = gifPicker.style.display === 'block' ? 'none':'block'; emojiPicker.style.display='none'; });

  // show attachment preview
  function showAttachmentPreview(att) {
    if (!attachmentPreviewEl) return;
    attachmentPreviewEl.innerHTML = '';
    if (!att) { attachmentPreviewEl.classList.add('hidden'); return; }
    const thumb = document.createElement(att.mime && att.mime.startsWith('image/') ? 'img' : (att.mime && att.mime.startsWith('video/') ? 'video':'div'));
    if (thumb.tagName === 'IMG' || thumb.tagName === 'VIDEO') {
      if (att.url) {
        thumb.src = att.url;
      } else if (att.file) {
        // create object URL for preview and remember to revoke it later
        const obj = URL.createObjectURL(att.file);
        thumb.src = obj;
        att._objectUrl = obj;
      } else {
        thumb.src = '';
      }
      thumb.alt = att.originalName || '';
      if (thumb.tagName === 'VIDEO') { thumb.controls = true; thumb.preload='none'; }
      thumb.className = 'attachment-thumb';
      attachmentPreviewEl.appendChild(thumb);
    } else {
      const meta = document.createElement('div'); meta.className='attachment-meta'; meta.textContent = att.originalName || 'attachment'; attachmentPreviewEl.appendChild(meta);
    }
    const meta = document.createElement('div'); meta.className='attachment-meta'; meta.innerHTML = `<div>${att.originalName || ''}</div><div style="color:var(--muted);font-size:12px">${att.mime||''}</div>`;
    const rem = document.createElement('button'); rem.className='attachment-remove'; rem.textContent='Remove'; rem.addEventListener('click', ()=>{ pendingAttachment = null; clearAttachmentPreview(); if (fileInput) fileInput.value = ''; });
    attachmentPreviewEl.appendChild(meta); attachmentPreviewEl.appendChild(rem); attachmentPreviewEl.classList.remove('hidden');
  }
  function clearAttachmentPreview(){ if (!attachmentPreviewEl) return; try {
      if (pendingAttachment && pendingAttachment._objectUrl) { try { URL.revokeObjectURL(pendingAttachment._objectUrl); } catch(e){} }
    } catch(e){}
    attachmentPreviewEl.innerHTML=''; attachmentPreviewEl.classList.add('hidden'); }

  // file input change: queue file for send and preview
  fileInput.addEventListener('change', (e)=>{
    const f = fileInput.files && fileInput.files[0];
    if (!f) return; pendingAttachment = { file: f, url: null, mime: f.type, originalName: f.name, isGif:false }; showAttachmentPreview(pendingAttachment);
  });

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
    // scroll to latest message on history load
    messagesEl.scrollTop = messagesEl.scrollHeight;
    // briefly highlight the latest message
    const lastMsg = messagesEl.querySelector('.message:last-child');
    if (lastMsg) {
      lastMsg.classList.add('highlight');
      setTimeout(() => lastMsg.classList.remove('highlight'), 2200);
    }
  });

  // Show/hide jump-to-latest button depending on scroll position
  function updateJumpButton() {
    const threshold = 160; // px from bottom
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= threshold;
    if (!atBottom) jumpBtn.classList.remove('hidden'); else jumpBtn.classList.add('hidden');
  }

  messagesEl.addEventListener('scroll', () => {
    updateJumpButton();
  });

  jumpBtn.addEventListener('click', () => {
    messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpBtn.classList.add('hidden');
    // mark visible messages as seen will happen via intersection observer
  });

  // Listen for message deletions from the server
  socket.on('message-delete', (p) => {
    try {
      const ids = (p && p.ids) || [];
      ids.forEach(id => {
        const el = messagesEl.querySelector(`.message[data-id="${id}"]`);
        if (el) el.remove();
      });
    } catch (e) { console.error('message-delete handling error', e); }
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
    let text = messageInput.value.trim();
    // profanity detection
    const bad = detectProfanity(text);
    if (bad.length > 0) {
      // show warning and censor on confirm
      const censored = censorText(text);
      const ok = confirm('Profanity detected (' + bad.join(', ') + '). The message will be censored. Continue?');
      if (!ok) return;
      text = censored;
    }

    // determine attachment to send: pendingAttachment (from paste/file/gif) or none
    let fileInfo = null;
    if (pendingAttachment) {
      if (pendingAttachment.file) {
        // upload file
        const fd = new FormData(); fd.append('file', pendingAttachment.file, pendingAttachment.originalName || 'upload');
        const res = await fetch('/upload', { method: 'POST', body: fd });
        if (!res.ok) { alert('Upload failed'); return; }
        const j = await res.json(); fileInfo = { url: j.url, mime: j.mime, originalName: j.originalName };
      } else if (pendingAttachment.url) {
        // GIF or remote URL - send as-is
        fileInfo = { url: pendingAttachment.url, mime: pendingAttachment.mime || 'image/gif', originalName: pendingAttachment.originalName || 'gif' };
      }
    } else if (fileInput.files && fileInput.files[0]) {
      // fallback if fileInput used directly
      const f = fileInput.files[0]; const fd = new FormData(); fd.append('file', f);
      const res = await fetch('/upload', { method: 'POST', body: fd });
      if (!res.ok) { alert('Upload failed'); return; }
      const j = await res.json(); fileInfo = { url: j.url, mime: j.mime, originalName: j.originalName };
    }

    if (!text && !fileInfo) { alert('Please enter a message or attach a file before sending.'); return; }

    socket.emit('message', { text, file: fileInfo });
    messageInput.value = '';
    // clear pending and input
    pendingAttachment = null; clearAttachmentPreview(); if (fileInput) fileInput.value = '';
    socket.emit('typing', false);
  });

  // typing indicator
  messageInput.addEventListener('input', () => {
    socket.emit('typing', true);
    if (typingTimeout) clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { socket.emit('typing', false); }, 1200);
  });

  // show inline profanity warning while typing
  messageInput.addEventListener('input', () => {
    const txt = messageInput.value || '';
    const bad = detectProfanity(txt);
    if (bad.length > 0) {
      if (profanityWarningEl) { profanityWarningEl.textContent = 'Warning: profane words detected: ' + bad.join(', '); profanityWarningEl.classList.remove('hidden'); }
    } else { if (profanityWarningEl) profanityWarningEl.classList.add('hidden'); }
  });

  // click outside to close pickers
  document.addEventListener('click', (e) => {
    if (emojiPicker && !emojiPicker.contains(e.target) && e.target !== emojiBtn) emojiPicker.style.display='none';
    if (gifPicker && !gifPicker.contains(e.target) && e.target !== gifBtn) gifPicker.style.display='none';
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
          // queue attachment and show preview instead of auto-sending
          pendingAttachment = { file, url: null, mime: file.type, originalName: file.name || 'pasted', isGif: false };
          showAttachmentPreview(pendingAttachment);
          // focus message input so user can add text before sending
          if (messageInput) messageInput.focus();
          return;
        }
      }
    } catch (err) {
      console.error('Paste handling error', err);
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

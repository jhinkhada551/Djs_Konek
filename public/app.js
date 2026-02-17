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
  const logoutBtn = document.getElementById('logoutBtn');
  const lightbox = document.getElementById('lightbox');
  const lbMedia = lightbox ? lightbox.querySelector('[data-role="media"]') : null;
  const lbDownload = lightbox ? lightbox.querySelector('[data-role="download"]') : null;
  const lbBackdrop = lightbox ? lightbox.querySelector('[data-role="backdrop"]') : null;

  let me = null;
  // try to restore saved user from localStorage
  let _savedUser = null;
  try { _savedUser = JSON.parse(localStorage.getItem('dj_user') || 'null'); } catch (e) { _savedUser = null; }
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

  // quick reaction emoji set
  const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','👏','🔥'];

  // single floating reaction picker reused for all messages
  const reactionPicker = document.createElement('div'); reactionPicker.className = 'reaction-picker-pop';
  REACTION_EMOJIS.forEach(em => { const b = document.createElement('button'); b.type='button'; b.className='reaction-mini'; b.textContent = em; b.addEventListener('click', () => {
    const targetMid = reactionPicker.dataset.mid;
    if (targetMid) {
      // optimistic UI update: reflect user's new reaction immediately
      optimisticUpdateReaction(targetMid, em);
      socket.emit('react', { messageId: targetMid, emoji: em });
    }
    reactionPicker.style.display='none';
  }); reactionPicker.appendChild(b); });
  reactionPicker.style.position='absolute'; reactionPicker.style.display='none'; reactionPicker.style.zIndex='220'; document.body.appendChild(reactionPicker);

  // reusable tooltip/popover to show who reacted
  const reactionTooltip = document.createElement('div'); reactionTooltip.className = 'reaction-tooltip hidden';
  reactionTooltip.style.position = 'absolute'; reactionTooltip.style.zIndex = 10050; reactionTooltip.style.display = 'none';
  document.body.appendChild(reactionTooltip);

  function showReactionTooltip(arr, anchorEl) {
    if (!reactionTooltip || !anchorEl) return;
    reactionTooltip.innerHTML = '';
    if (!Array.isArray(arr) || arr.length === 0) {
      const p = document.createElement('div'); p.className = 'rt-empty'; p.textContent = 'No reactions'; reactionTooltip.appendChild(p);
    } else {
      arr.forEach(u => {
        const item = document.createElement('div'); item.className = 'rt-item';
        const av = document.createElement('span'); av.className = 'rt-avatar'; av.textContent = (u.avatar && u.avatar.initials) ? u.avatar.initials : (u.name||'A').charAt(0).toUpperCase(); av.style.background = (u.avatar && u.avatar.color) ? u.avatar.color : '#666';
        const name = document.createElement('span'); name.className = 'rt-name'; name.textContent = u.name + (u.group ? ' ('+u.group+')' : '');
        item.appendChild(av); item.appendChild(name); reactionTooltip.appendChild(item);
      });
    }
    // position near anchor
    const r = anchorEl.getBoundingClientRect();
    reactionTooltip.style.left = (Math.max(8, r.left)) + 'px';
    reactionTooltip.style.top = (r.bottom + 8) + 'px';
    reactionTooltip.style.display = 'block'; reactionTooltip.classList.remove('hidden');
  }

  function hideReactionTooltip() { if (!reactionTooltip) return; reactionTooltip.style.display='none'; reactionTooltip.classList.add('hidden'); }

  function showReactionPickerForMessage(mid, anchorEl) {
    if (!anchorEl) return;
    const r = anchorEl.getBoundingClientRect();
    reactionPicker.style.left = (r.left) + 'px'; reactionPicker.style.top = (r.bottom + 6) + 'px';
    reactionPicker.dataset.mid = mid; reactionPicker.style.display = 'block';
  }

  // Optimistically update reaction UI for a message (client-side only) before server confirmation
  function optimisticUpdateReaction(mid, emoji) {
    const msgEl = messagesEl.querySelector(`.message[data-id="${mid}"]`) || messagesEl.querySelector(`.message[data-temp-id="${mid}"]`);
    if (!msgEl) return;
    const reactionsInner = msgEl.querySelector('.reactions-inner');
    if (!reactionsInner) return;
    // find previous reacted emoji by this user
    let prevEm = null;
    reactionsInner.querySelectorAll('.reaction-btn').forEach(b => {
      if (b.classList.contains('reacted')) prevEm = b.dataset.emoji;
    });
    // if clicking same emoji => toggle off
    if (prevEm === emoji) {
      // decrement count and remove reacted
      const prevBtn = reactionsInner.querySelector(`.reaction-btn[data-emoji="${emoji}"]`);
      if (prevBtn) {
        const parts = prevBtn.textContent.trim().split(' ');
        const count = parseInt(parts[parts.length-1]) || 1;
        const newCount = Math.max(0, count - 1);
        prevBtn.textContent = `${emoji} ${newCount}`;
        prevBtn.classList.remove('reacted');
        if (newCount === 0) prevBtn.remove();
      }
      unlockReactionsUI(mid);
      return;
    }
    // remove previous reaction visually
    if (prevEm) {
      const prevBtn = reactionsInner.querySelector(`.reaction-btn[data-emoji="${prevEm}"]`);
      if (prevBtn) {
        const parts = prevBtn.textContent.trim().split(' ');
        const count = parseInt(parts[parts.length-1]) || 1;
        const newCount = Math.max(0, count - 1);
        if (newCount === 0) prevBtn.remove(); else prevBtn.textContent = `${prevEm} ${newCount}`;
        prevBtn.classList.remove('reacted');
      }
    }
    // add/increment new emoji button
    let newBtn = reactionsInner.querySelector(`.reaction-btn[data-emoji="${emoji}"]`);
    if (newBtn) {
      const parts = newBtn.textContent.trim().split(' ');
      const count = parseInt(parts[parts.length-1]) || 0;
      newBtn.textContent = `${emoji} ${count + 1}`;
    } else {
      newBtn = document.createElement('button'); newBtn.className = 'reaction-btn reacted'; newBtn.dataset.emoji = emoji; newBtn.textContent = `${emoji} 1`;
      newBtn.addEventListener('click', () => {
        try { newBtn.disabled = true; setTimeout(() => newBtn.disabled = false, 700); } catch (e) {}
        socket.emit('react', { messageId: mid, emoji });
      });
      reactionsInner.insertBefore(newBtn, reactionsInner.firstChild);
    }
    newBtn.classList.add('reacted');
    lockReactionsUI(mid);
  }

  // helper to lock reactions UI for a message and show a Change button
  function lockReactionsUI(mid) {
    const msgEl = messagesEl.querySelector(`.message[data-id="${mid}"]`);
    if (!msgEl) {
      // If we don't have the message element locally (race or missed history), request the message from server so
      // we can render it and show the reactions without requiring a full page refresh.
      try { socket.emit('request-message', { id: mid }); } catch (e) {}
      return;
    }
    const reactionsInner = msgEl.querySelector('.reactions-inner');
    if (!reactionsInner) return;
    // disable existing reaction buttons
    reactionsInner.querySelectorAll('.reaction-btn').forEach(b => { try { b.disabled = true; } catch (e) {} });
    // hide inline mini-picker if present (we'll use the floating picker)
    const inlinePicker = reactionsInner.querySelector('.reaction-picker'); if (inlinePicker) inlinePicker.style.display = 'none';

    // if a "current reaction" button already exists, don't add another
    if (reactionsInner.querySelector('.reaction-current')) return;

    // find which emoji the current user reacted with (server-marked .reacted)
    const reactedBtn = reactionsInner.querySelector('.reaction-btn.reacted');
    const myEmoji = reactedBtn ? reactedBtn.dataset.emoji : null;
    // create a compact current-reaction button (shows the emoji you reacted with). Clicking it opens the picker
    const currentBtn = document.createElement('button'); currentBtn.className = 'reaction-current'; currentBtn.type = 'button';
    currentBtn.textContent = myEmoji || '●';
    currentBtn.title = myEmoji ? `You reacted ${myEmoji}. Click to change.` : 'You reacted. Click to change.';
    currentBtn.addEventListener('click', (ev) => { ev.stopPropagation(); showReactionPickerForMessage(mid, currentBtn); });
    reactionsInner.appendChild(currentBtn);
  }

  function unlockReactionsUI(mid) {
    const msgEl = messagesEl.querySelector(`.message[data-id="${mid}"]`);
    if (!msgEl) return;
    const reactionsInner = msgEl.querySelector('.reactions-inner');
    if (!reactionsInner) return;
    reactionsInner.querySelectorAll('.reaction-btn').forEach(b => { try { b.disabled = false; } catch (e) {} });
    // restore inline picker visibility
    const inlinePicker = reactionsInner.querySelector('.reaction-picker'); if (inlinePicker) inlinePicker.style.display = '';
    const cb = reactionsInner.querySelector('.reaction-current'); if (cb) cb.remove();
  }

  // Emoji data (small curated set)
  const EMOJIS = ['😊','😂','❤️','👍','🔥','😮','😢','🎉','👏','🙌','😉','😎'];

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

  // GIF picker removed per user request. GIFs can still be attached via file input or remote URLs if needed.

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
  });

  // logout button handler: clear saved user and reload/disconnect
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      try { localStorage.removeItem('dj_user'); } catch (e) {}
      try { socket.disconnect(); } catch (e) {}
      // reload to show join screen
      window.location.reload();
    });
  }

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

  // populate existing reactions if present on the message object (from history or server)
  try {
    const existing = m.reactions || {};
    Object.keys(existing).forEach(em => {
      const arr = existing[em] || [];
      const btn = document.createElement('button'); btn.className = 'reaction-btn'; btn.textContent = `${em} ${arr.length}`;
      // highlight if me reacted (we only know my socket id later; use socket.id)
      const reacted = arr.find(a => a.id === socket.id);
      if (reacted) btn.classList.add('reacted');
      btn.addEventListener('click', () => {
        socket.emit('react', { messageId: m.id, emoji: em });
      });
      reactionsInner.appendChild(btn);
    });
  } catch (e) {}

  // add a quick reaction picker trigger
  const addReact = document.createElement('button'); addReact.type = 'button'; addReact.className = 'reaction-add'; addReact.textContent = '+';
  addReact.title = 'Add reaction';
  addReact.addEventListener('click', (ev) => {
    ev.stopPropagation();
    showReactionPickerForMessage(m.id, addReact);
  });
  reactionsInner.appendChild(addReact);

  // seen receipts container (shown only for your most recent sent message)
  const seenWrap = document.createElement('div'); seenWrap.className = 'seen-wrap';
  const seenInner = document.createElement('div'); seenInner.className = 'seen-inner';
  seenWrap.appendChild(seenInner);
  box.appendChild(seenWrap);

  // status element (for optimistic UI)
  const statusEl = document.createElement('div'); statusEl.className = 'status';
  box.appendChild(statusEl);

    return box;
  }

  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = nameInput.value.trim() || 'Anonymous';
    const group = groupInput.value.trim();
    const avatar = makeAvatar(name);
    me = { name, group, avatar };
    socket.emit('join', { name, group, avatar });
    // persist user locally so refresh keeps them logged in
    try { localStorage.setItem('dj_user', JSON.stringify(me)); } catch (e) {}
    showSection(true);
    if (logoutBtn) logoutBtn.style.display = 'inline-block';
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

  // Auto-join if we have a saved user in localStorage (use socket connect to ensure socket id is ready)
  socket.on('connect', () => {
    if (_savedUser && !me) {
      me = _savedUser;
      try { socket.emit('join', { name: me.name, group: me.group, avatar: me.avatar }); } catch (e) {}
      showSection(true);
      const hdr = document.getElementById('siteHeader'); if (hdr) hdr.classList.remove('hidden');
      if (logoutBtn) logoutBtn.style.display = 'inline-block';
      setTimeout(() => { if (messageInput) messageInput.focus(); }, 250);
      socket.emit('request-history', { limit: 300 });
    }
  });

  socket.on('message', (m) => {
    // If this message corresponds to a clientTempId (optimistic), try to find the temp node and reconcile.
    // If no temp node exists (other clients), still append the message so broadcasts aren't dropped.
    if (m.clientTempId) {
      const tempEl = messagesEl.querySelector(`.message[data-temp-id="${m.clientTempId}"]`);
      if (tempEl) {
        // update dataset id
        tempEl.dataset.id = m.id || '';
        tempEl.removeAttribute('data-temp-id');
        tempEl.classList.remove('sending');
        // update media src if present (replace objectURL with real URL)
        try {
          const img = tempEl.querySelector('img');
          const vid = tempEl.querySelector('video');
          if (m.file && m.file.url) {
            if (img) img.src = m.file.url;
            if (vid) vid.src = m.file.url;
          }
        } catch (e) {}
        // clear per-message status area (spinner / sending text)
        try { const st = tempEl.querySelector('.status'); if (st) st.innerHTML = ''; } catch (e) {}
        // observe for seen events
        try { if (m.id) ensureObserver().observe(tempEl); } catch (e) {}
      } else {
        // no temp element found (this client didn't create the optimistic message) -> append normally
        const node = renderMessage(m);
        messagesEl.appendChild(node);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        if (m.id) ensureObserver().observe(node);
      }
    } else {
      const node = renderMessage(m);
      messagesEl.appendChild(node);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // Do not immediately mark as seen; observe and emit when visible
      if (m.id) ensureObserver().observe(node);
    }

    // set lastSentMessageId when a message from me arrives (server id)
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
    // Replace the reactions area with server-authoritative state
    reactionsInner.innerHTML = '';

    // helper to detect if a server user object represents the current local user
    function isSameUserObj(u) {
      if (!u) return false;
      try {
        if (me && me.name) {
          // match by name, group, and avatar fingerprint (safe best-effort for reconnects)
          const a1 = (u.avatar && JSON.stringify(u.avatar)) || '';
          const a2 = (me.avatar && JSON.stringify(me.avatar)) || '';
          return u.name === me.name && (u.group || '') === (me.group || '') && a1 === a2;
        }
      } catch (e) {}
      // fallback: if no saved `me`, try matching by socket id
      return u.id === socket.id;
    }

    Object.keys(reactions).forEach(em => {
      const arr = reactions[em] || [];
      const btn = document.createElement('button'); btn.className = 'reaction-btn'; btn.textContent = `${em} ${arr.length}`;
      btn.dataset.emoji = em;
      // highlight if current user is present in the server list (match by saved user info when possible)
      const reacted = arr.find(a => isSameUserObj(a));
      if (reacted) btn.classList.add('reacted');
      // clicking or tapping a reaction shows who reacted (do not use it to toggle reaction)
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        // toggle tooltip visibility on click (useful for mobile)
        if (reactionTooltip && reactionTooltip.style.display === 'block') { hideReactionTooltip(); return; }
        showReactionTooltip(arr, btn);
      });
      // also show on hover for desktop
      btn.addEventListener('pointerenter', () => { try { showReactionTooltip(arr, btn); } catch (e) {} });
      btn.addEventListener('pointerleave', () => { try { hideReactionTooltip(); } catch (e) {} });
      reactionsInner.appendChild(btn);
    });

    // allow adding a new reaction quickly (mini picker)
    const picker = document.createElement('div'); picker.className = 'reaction-picker';
    ['👍','❤️','😂','😮','😢','👏'].forEach(em => {
      const pbtn = document.createElement('button'); pbtn.className = 'reaction-mini'; pbtn.textContent = em;
      pbtn.addEventListener('click', (ev) => { ev.stopPropagation(); // don't bubble
        // disable mini buttons briefly
        try { pbtn.disabled = true; setTimeout(() => pbtn.disabled = false, 700); } catch (e) {}
        optimisticUpdateReaction(mid, em); // optimistic local update
        socket.emit('react', { messageId: mid, emoji: em });
      });
      picker.appendChild(pbtn);
    });
    reactionsInner.appendChild(picker);

    // If current user already reacted to this message (according to server), lock reactions UI and show Change button
    try {
      const myEmoji = Object.keys(reactions).find(em => (reactions[em]||[]).some(u => isSameUserObj(u)));
      if (myEmoji) {
        lockReactionsUI(mid);
      } else {
        unlockReactionsUI(mid);
      }
    } catch (e) {}
  });

  // message send + upload flow
  messageForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!me) return alert('Please join first');
    let text = messageInput.value.trim();
    // profanity detection
    const bad = detectProfanity(text);
    if (bad.length > 0) {
      const censored = censorText(text);
      const ok = confirm('Profanity detected (' + bad.join(', ') + '). The message will be censored. Continue?');
      if (!ok) return;
      text = censored;
    }

    // require something to send
    if (!text && !pendingAttachment && !(fileInput.files && fileInput.files[0])) {
      alert('Please enter a message or attach a file before sending.');
      return;
    }

    // create optimistic temp message and render immediately
    const tempId = 'tmp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2,8);
    const tempMsg = {
      id: tempId,
      from: { id: socket.id, name: me.name, group: me.group, avatar: me.avatar },
      text: text,
      file: null,
      ts: Date.now(),
      reactions: {}
    };
    // if there's a pendingAttachment with preview URL, attach preview for optimistic display
    if (pendingAttachment && pendingAttachment._objectUrl) {
      tempMsg.file = { url: pendingAttachment._objectUrl, mime: pendingAttachment.mime, originalName: pendingAttachment.originalName };
    } else if (fileInput.files && fileInput.files[0]) {
      const f = fileInput.files[0]; const obj = URL.createObjectURL(f); tempMsg.file = { url: obj, mime: f.type, originalName: f.name }; tempMsg._localFile = f;
    }

    const node = renderMessage(tempMsg);
    // mark as temp/sending
    node.dataset.tempId = tempId; node.classList.add('sending');
    const st = node.querySelector('.status'); if (st) st.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="status-text">Sending</span>';
    messagesEl.appendChild(node); messagesEl.scrollTop = messagesEl.scrollHeight;

    // perform upload if necessary
    let fileInfo = null;
    try {
      if (pendingAttachment && pendingAttachment.file) {
        // show global loader
        if (document.getElementById('globalLoader')) document.getElementById('globalLoader').classList.remove('hidden');
        const fd = new FormData(); fd.append('file', pendingAttachment.file, pendingAttachment.originalName || 'upload');
        const res = await fetch('/upload', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('upload-failed');
        const j = await res.json(); fileInfo = { url: j.url, mime: j.mime, originalName: j.originalName };
        if (document.getElementById('globalLoader')) document.getElementById('globalLoader').classList.add('hidden');
      } else if (fileInput.files && fileInput.files[0]) {
        if (document.getElementById('globalLoader')) document.getElementById('globalLoader').classList.remove('hidden');
        const f = fileInput.files[0]; const fd = new FormData(); fd.append('file', f);
        const res = await fetch('/upload', { method: 'POST', body: fd });
        if (!res.ok) throw new Error('upload-failed');
        const j = await res.json(); fileInfo = { url: j.url, mime: j.mime, originalName: j.originalName };
        if (document.getElementById('globalLoader')) document.getElementById('globalLoader').classList.add('hidden');
      }
    } catch (err) {
      // mark node as failed
      // hide global loader if visible
      if (document.getElementById('globalLoader')) document.getElementById('globalLoader').classList.add('hidden');
      node.classList.add('failed'); node.classList.remove('sending');
      const st2 = node.querySelector('.status'); if (st2) st2.innerHTML = '<span class="status-text">Upload failed</span><button class="retry">Retry</button>';
      const retryBtn = node.querySelector('.retry'); if (retryBtn) retryBtn.addEventListener('click', () => {
        // simple approach: reload page to retry or user can try sending again
        window.location.reload();
      });
      // clear pending attachment but leave preview so user can re-attach
      return;
    }

    // now send the message via socket with clientTempId so server can reconcile
    const sendPayload = { text: text, file: fileInfo, clientTempId: tempId };
    socket.emit('message', sendPayload, (ack) => {
      try {
        // hide global loader if it was shown
        if (document.getElementById('globalLoader')) document.getElementById('globalLoader').classList.add('hidden');
      } catch (e) {}
      if (!ack || !ack.ok) {
        // mark failed
        node.classList.add('failed'); node.classList.remove('sending');
        const st3 = node.querySelector('.status'); if (st3) st3.innerHTML = '<span class="status-text">Send failed</span>';
      } else {
        // server acknowledged quickly — remove spinner immediately for perceived speed
        try { node.classList.remove('sending'); const st4 = node.querySelector('.status'); if (st4) st4.innerHTML = ''; } catch (e) {}
        // optimistic reconciliation will still occur when the server emits the canonical message
      }
    });

    // reset UI inputs
    messageInput.value = '';
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
    if (reactionPicker && !reactionPicker.contains(e.target) && !e.target.classList.contains('reaction-add')) reactionPicker.style.display='none';
  });

  // Paste-to-upload support: allow users to paste images/videos/audio from clipboard
  async function handlePasteEvent(e) {
    try {
      if (!me) return; // require joined
      // First, check for HTML clipboard content which may contain an <img src="..."> with a GIF URL
      try {
        const html = (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text/html')) || '';
        if (html) {
          // look for src attributes containing .gif or common gif hosts
          const re = /<img[^>]+src=["']?([^"'\s>]+)["']?/i;
          const m = html.match(re);
          if (m && m[1]) {
            const src = m[1];
            // prefer GIFs (by extension or known hosts)
            if (/\.gif($|\?|#)/i.test(src) || /giphy\.com|media\.giphy\.com|tenor\.com|cdn\.tenor\.com/i.test(src)) {
              e.preventDefault();
              pendingAttachment = { file: null, url: src, mime: 'image/gif', originalName: 'pasted.gif', isGif: true };
              showAttachmentPreview(pendingAttachment);
              if (messageInput) messageInput.focus();
              return;
            }
          }
        }
      } catch (errHtml) {
        // ignore
      }

      // Next, check for plain clipboard items (files or plain gif URLs)
      const items = (e.clipboardData && e.clipboardData.items) || [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (it.kind === 'file') {
          const file = it.getAsFile();
          if (!file) continue;
          // only accept image/audio/video types
          if (!file.type || !(file.type.startsWith('image/') || file.type.startsWith('video/') || file.type.startsWith('audio/'))) continue;
          e.preventDefault();
          // If the file is an image/gif, preserve that
          const isGifFile = file.type === 'image/gif' || /\.gif($|\?|#)/i.test(file.name || '');
          pendingAttachment = { file, url: null, mime: file.type, originalName: file.name || 'pasted', isGif: !!isGifFile };
          showAttachmentPreview(pendingAttachment);
          // focus message input so user can add text before sending
          if (messageInput) messageInput.focus();
          return;
        }
      }

      // Finally, if clipboard contains a plain text URL to a GIF, accept that
      try {
        const txt = (e.clipboardData && e.clipboardData.getData && e.clipboardData.getData('text/plain')) || '';
        if (txt && /https?:\/\/.+\.gif(\?|#|$)/i.test(txt.trim())) {
          const url = txt.trim();
          e.preventDefault();
          pendingAttachment = { file: null, url, mime: 'image/gif', originalName: 'pasted.gif', isGif: true };
          showAttachmentPreview(pendingAttachment);
          if (messageInput) messageInput.focus();
          return;
        }
      } catch (errTxt) {}
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
    // if in fullscreen, exit fullscreen first so the close action works in fullscreen video mode
    try {
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
      if (fsEl) {
        if (document.exitFullscreen) {
          document.exitFullscreen().catch(() => {});
        } else if (document.webkitExitFullscreen) {
          document.webkitExitFullscreen();
        }
      }
    } catch (e) {}
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

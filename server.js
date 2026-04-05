const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 3000;
const ADMIN_PIN = process.env.ADMIN_PIN || '1234';
const PRESENTER_PIN = process.env.PRESENTER_PIN || '5678';

// ── Diretório de dados persistentes ──────────────────────────────────────────
const DATA_DIR = fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const QUESTIONS_FILE = path.join(DATA_DIR, 'questions.json');
const CONFIG_FILE    = path.join(DATA_DIR, 'config.json');
const SESSION_FILE   = path.join(DATA_DIR, 'session.json');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Persistência de sessão ────────────────────────────────────────────────────
function loadSession() {
  try {
    if (fs.existsSync(SESSION_FILE)) {
      const raw = fs.readFileSync(SESSION_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) { console.error('Erro ao carregar session.json:', e.message); }
  return null;
}

let _saveSessionTimer = null;
function saveSession() {
  // Debounce: agrupa gravações em rajadas (ex: muitas respostas chegando de uma vez)
  clearTimeout(_saveSessionTimer);
  _saveSessionTimer = setTimeout(() => {
    try {
      const data = {
        activeQuiz:  state.activeQuiz,
        phase:       state.phase,
        currentIndex: state.currentIndex,
        openPage:    state.openPage,
        questionStartedAt: state.questionStartedAt,
        answers:     state.answers,
        reactions:   state.reactions,
        participants: state.participants,
      };
      fs.writeFileSync(SESSION_FILE, JSON.stringify(data), 'utf8');
    } catch (e) { console.error('Erro ao salvar session.json:', e.message); }
  }, 300);
}

function clearSession() {
  clearTimeout(_saveSessionTimer);
  try { if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE); } catch (e) {}
}

const DEFAULT_CONFIG = {
  eventName: 'Quiz Interativo',
  logoUrl: null,   // URL relativa do logo exibido no presenter (/uploads/logo_xxx.png)
  font: 'Inter',   // Fonte principal
  quizNames: { 1: 'Quiz 1', 2: 'Quiz 2', 3: 'Quiz 3', 4: 'Quiz 4', 5: 'Quiz 5' },
  colors: {
    // Geral
    bg:          '#0d1520',
    card:        '#101c30',
    text:        '#f0f0f0',
    accent:      '#c8a84b',
    // Pergunta
    promptBg:    '#101c30',
    promptText:  '#f0f0f0',
    // Opções (bg e borda)
    opt0Bg:      '#1a3a7a', opt0Border: '#2a5abf',
    opt1Bg:      '#7a1a1a', opt1Border: '#bf2a2a',
    opt2Bg:      '#1a5a2a', opt2Border: '#2abf5a',
    opt3Bg:      '#5a4a1a', opt3Border: '#bfa02a',
    optText:     '#ffffff',
    // Acerto / Erro / Sem resposta
    correctBg:   '#145214', correctBorder: '#4caf50', correctText: '#4caf50',
    wrongBg:     '#521414', wrongBorder:   '#f44336', wrongText:   '#f44336',
    missedBg:    '#3a3a1a', missedText:    '#ffc107',
    // Botão de entrar
    btnBg:       '#1e5dbf', btnText:       '#ffffff',
  }
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
      const saved = JSON.parse(raw);
      // Merge com defaults para garantir que todos os campos existem
      return {
        ...DEFAULT_CONFIG, ...saved,
        quizNames: { ...DEFAULT_CONFIG.quizNames, ...(saved.quizNames || {}) },
        colors: { ...DEFAULT_CONFIG.colors, ...(saved.colors || {}) }
      };
      // logoUrl e font ficam no spread acima
    }
  } catch (e) { console.error('Erro ao carregar config.json:', e.message); }
  return { ...DEFAULT_CONFIG, quizNames: { ...DEFAULT_CONFIG.quizNames } };
}

function saveConfig(cfg) {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8'); }
  catch (e) { console.error('Erro ao salvar config.json:', e.message); }
}

function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
      const qs = JSON.parse(raw);
      // Migração: questões antigas sem quizId explícito vão pro banco (null)
      return qs.map(q => q.hasOwnProperty('quizId') ? q : { ...q, quizId: null });
    }
  } catch (e) { console.error('Erro ao carregar questions.json:', e.message); }
  return [];
}

function saveQuestions(questions) {
  try { fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2), 'utf8'); }
  catch (e) { console.error('Erro ao salvar questions.json:', e.message); }
}

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, `q_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage, limits: { fileSize: 150 * 1024 * 1024 } });
const uploadFields = upload.fields([{ name: 'media', maxCount: 1 }, { name: 'revealMedia', maxCount: 1 }]);

// ── Estado global ─────────────────────────────────────────────────────────────
const _session = loadSession();
const state = {
  questions:    loadQuestions(),
  config:       loadConfig(),
  // Sessão restaurada do disco (ou defaults)
  activeQuiz:   _session?.activeQuiz   ?? null,
  phase:        _session?.phase        ?? 'selectQuiz',
  currentIndex: _session?.currentIndex ?? -1,
  openPage:     _session?.openPage     ?? 0,
  questionStartedAt: _session?.questionStartedAt ?? null,
  answers:      _session?.answers      ?? {},
  reactions:    _session?.reactions    ?? {},
  participants: _session?.participants ?? {},
  // activeQuestions é derivado — reconstruído abaixo
  activeQuestions: [],
};

// Reconstrói activeQuestions a partir de activeQuiz salvo
if (state.activeQuiz) {
  state.activeQuestions = state.questions.filter(q => q.quizId === state.activeQuiz);
}

console.log(`Questões carregadas: ${state.questions.length}`);
if (_session) console.log(`Sessão restaurada: fase=${state.phase}, quiz=${state.activeQuiz}, respostas=${Object.keys(state.answers).length}`);

// ── Static ────────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/presenter', (req, res) => res.sendFile(path.join(__dirname, 'public', 'presenter.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));

// ── Admin API ─────────────────────────────────────────────────────────────────

app.post('/api/auth', (req, res) => {
  const { pin, role } = req.body;
  if (role === 'admin' && pin === ADMIN_PIN) return res.json({ ok: true });
  if (role === 'presenter' && pin === PRESENTER_PIN) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

// Ler configuração (público — necessário para celulares e presenter)
app.get('/api/config', (req, res) => res.json(state.config));

// Salvar configuração (somente admin)
app.post('/api/config', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const { eventName, quizNames, colors, font } = req.body;
  if (eventName !== undefined) state.config.eventName = String(eventName).trim() || DEFAULT_CONFIG.eventName;
  if (font !== undefined) {
    const allowed = ['Inter','Roboto','Montserrat','Oswald','Nunito','Lato','Poppins','Raleway','Ubuntu','Barlow'];
    if (allowed.includes(font)) state.config.font = font;
  }
  if (quizNames) {
    for (let i = 1; i <= 5; i++) {
      if (quizNames[i] !== undefined) state.config.quizNames[i] = String(quizNames[i]).trim() || DEFAULT_CONFIG.quizNames[i];
    }
  }
  if (colors) {
    const validKeys = Object.keys(DEFAULT_CONFIG.colors);
    for (const k of validKeys) {
      if (colors[k] !== undefined) {
        const val = String(colors[k]).trim();
        // Aceita só hex válido (#xxx ou #xxxxxx)
        if (/^#[0-9a-fA-F]{3,8}$/.test(val)) state.config.colors[k] = val;
      }
    }
  }
  saveConfig(state.config);
  // Notifica todos com a nova config
  io.emit('config', state.config);
  io.to('presenter').emit('presenterState', presenterFullState());
  res.json({ ok: true, config: state.config });
});

app.post('/api/questions', uploadFields, (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const { prompt, options, correctIndex, quizId, type } = req.body;
  const mediaFile = req.files?.media?.[0];
  const revealFile = req.files?.revealMedia?.[0];
  const qType = type === 'open' ? 'open' : 'multiple';
  const rawFields = req.body.fields;
  const parsedFields = rawFields ? (Array.isArray(rawFields) ? rawFields : JSON.parse(rawFields)) : ['Resposta'];
  const q = {
    id: Date.now().toString(),
    type: qType,
    fields: qType === 'open' ? parsedFields.filter(Boolean).map(f => String(f).trim()).slice(0, 5) : [],
    quizId: (quizId === '0' || quizId === undefined || quizId === null || quizId === '') ? null : parseInt(quizId, 10),
    mediaType: mediaFile ? (mediaFile.mimetype.startsWith('video') ? 'video' : 'image') : null,
    mediaUrl: mediaFile ? `/uploads/${mediaFile.filename}` : null,
    revealMediaType: revealFile ? (revealFile.mimetype.startsWith('video') ? 'video' : 'image') : null,
    revealMediaUrl: revealFile ? `/uploads/${revealFile.filename}` : null,
    prompt,
    options: qType === 'open' ? [] : JSON.parse(options || '[]').map((label, i) => ({ label, correct: i === parseInt(correctIndex, 10) })),
  };
  state.questions.push(q);
  saveQuestions(state.questions);
  res.json({ ok: true, question: q });
});

app.get('/api/questions', (req, res) => {
  if (req.query.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  res.json(state.questions);
});

// Alterar quizId de uma questão
app.patch('/api/questions/:id/quiz', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const q = state.questions.find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'Não encontrado' });
  q.quizId = req.body.quizId;
  saveQuestions(state.questions);
  res.json({ ok: true, quizId: q.quizId });
});

app.delete('/api/questions/:id', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const idx = state.questions.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Não encontrado' });
  const [removed] = state.questions.splice(idx, 1);
  if (removed.mediaUrl) {
    const fp = path.join(UPLOADS_DIR, path.basename(removed.mediaUrl));
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  saveQuestions(state.questions);
  res.json({ ok: true });
});

// Upload de logo
app.post('/api/config/logo', upload.single('logo'), (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });
  // Remove logo anterior se existir
  if (state.config.logoUrl) {
    const old = path.join(UPLOADS_DIR, path.basename(state.config.logoUrl));
    if (fs.existsSync(old)) try { fs.unlinkSync(old); } catch(e) {}
  }
  state.config.logoUrl = `/uploads/${req.file.filename}`;
  saveConfig(state.config);
  io.emit('config', state.config);
  io.to('presenter').emit('presenterState', presenterFullState());
  res.json({ ok: true, logoUrl: state.config.logoUrl });
});

// Remover logo
app.delete('/api/config/logo', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  if (state.config.logoUrl) {
    const fp = path.join(UPLOADS_DIR, path.basename(state.config.logoUrl));
    if (fs.existsSync(fp)) try { fs.unlinkSync(fp); } catch(e) {}
    state.config.logoUrl = null;
    saveConfig(state.config);
    io.emit('config', state.config);
  }
  res.json({ ok: true });
});

app.post('/api/questions/reorder', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  state.questions = req.body.ids.map(id => state.questions.find(q => q.id === id)).filter(Boolean);
  saveQuestions(state.questions);
  res.json({ ok: true });
});

// Reset total — apaga participantes e volta à seleção de quiz
app.post('/api/reset', (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  state.activeQuiz = null;
  state.activeQuestions = [];
  state.phase = 'selectQuiz';
  state.currentIndex = -1;
  state.answers = {};
  state.reactions = {};
  state.openPage = 0;
  state.questionStartedAt = null;
  state.participants = {};
  clearSession();
  io.emit('kicked');
  io.emit('state', buildPublicState());
  res.json({ ok: true });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildPublicState() {
  const q = state.currentIndex >= 0 ? state.activeQuestions[state.currentIndex] : null;
  return {
    phase: state.phase,
    activeQuiz: state.activeQuiz,
    config: state.config,
    currentIndex: state.currentIndex,
    totalQuestions: state.activeQuestions.length,
    question: q ? {
      id: q.id,
      type: q.type || 'multiple',
      fields: q.fields || ['Resposta'],
      mediaType: q.mediaType,
      mediaUrl: q.mediaUrl,
      revealMediaType: state.phase === 'reveal' ? (q.revealMediaType || null) : null,
      revealMediaUrl: state.phase === 'reveal' ? (q.revealMediaUrl || null) : null,
      prompt: q.prompt,
      optionLabels: (q.type === 'open') ? [] : q.options.map(o => o.label),
      correctIndex: (q.type === 'open' || state.phase !== 'reveal') ? null : q.options.findIndex(o => o.correct),
    } : null,
    openPage: state.openPage,
    participantCount: Object.keys(state.participants).length,
  };
}

function getScore(p, quizId) {
  return p.scores?.[quizId] || { score: 0, totalMs: 0 };
}

function buildRanking() {
  const qid = state.activeQuiz || 1;
  return Object.values(state.participants)
    .map(p => { const s = getScore(p, qid); return { name: p.name, score: s.score, totalMs: s.totalMs }; })
    .sort((a, b) => b.score - a.score || a.totalMs - b.totalMs)
    .map((p, i) => ({ ...p, rank: i + 1 }));
}

function buildPresenterExtra() {
  if (state.currentIndex < 0 || !state.activeQuestions[state.currentIndex]) return {};
  const q = state.activeQuestions[state.currentIndex];
  const participantCount = Object.keys(state.participants).length;

  if (q.type === 'open') {
    // Para questão aberta: retornar lista de respostas com nomes
    const openAnswers = [];
    const qid = state.activeQuiz || 1;
    const qReactions = state.reactions[state.currentIndex] || {};
    Object.entries(state.answers).forEach(([key, ans]) => {
      if (key.endsWith(`_${state.currentIndex}`) && ans.fields !== undefined) {
        const playerId = key.replace(`_${state.currentIndex}`, '');
        const p = state.participants[playerId];
        if (p) {
          const score = p.scores?.[qid]?.score || 0;
          // Calcular totais de reações recebidas por esse participante
          const rxMap = qReactions[playerId] || {};
          const rxCounts = { '-1': 0, '0': 0, '1': 0, '2': 0 };
          let rxTotal = 0;
          Object.values(rxMap).forEach(v => { rxCounts[String(v)] = (rxCounts[String(v)] || 0) + 1; rxTotal += v; });
          openAnswers.push({ playerId, name: p.name, fields: ans.fields, ms: ans.ms, score, rxCounts, rxTotal });
        }
      }
    });
    openAnswers.sort((a, b) => a.ms - b.ms);
    return { openAnswers, answerTotal: openAnswers.length, participantCount, isOpen: true, openPage: state.openPage };
  }

  const counts = q.options.map(() => 0);
  let total = 0;
  Object.keys(state.answers).forEach(key => {
    if (key.endsWith(`_${state.currentIndex}`)) {
      const { optionIndex } = state.answers[key];
      if (optionIndex != null) { counts[optionIndex]++; total++; }
    }
  });
  return { answerCounts: counts, answerTotal: total, participantCount };
}

function presenterFullState() {
  return { ...buildPublicState(), ...buildPresenterExtra(), ranking: buildRanking(), questions: state.questions };
}

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  socket.on('join', ({ name, playerId }) => {
    if (!name || name.trim().length < 2 || !playerId) return;
    if (state.participants[playerId]) {
      state.participants[playerId].socketId = socket.id;
    } else {
      state.participants[playerId] = {
        name: name.trim(), socketId: socket.id,
        scores: { 1: { score: 0, totalMs: 0 }, 2: { score: 0, totalMs: 0 },
                  3: { score: 0, totalMs: 0 }, 4: { score: 0, totalMs: 0 }, 5: { score: 0, totalMs: 0 } }
      };
    }
    socket._playerId = playerId;
    saveSession();
    socket.emit('joined', buildPublicState());
    io.to('presenter').emit('presenterState', presenterFullState());
  });

  socket.on('answer', ({ optionIndex }) => {
    const playerId = socket._playerId;
    const p = playerId && state.participants[playerId];
    if (!p || state.phase !== 'question' || state.currentIndex < 0) return;
    const key = `${playerId}_${state.currentIndex}`;
    if (state.answers[key]) return;

    const ms = Date.now() - state.questionStartedAt;
    const q = state.activeQuestions[state.currentIndex];
    const correct = q.options[optionIndex]?.correct || false;

    state.answers[key] = { optionIndex, ms, correct };
    if (correct) {
      const qid = state.activeQuiz;
      if (!p.scores[qid]) p.scores[qid] = { score: 0, totalMs: 0 };
      p.scores[qid].score++;
      p.scores[qid].totalMs += ms;
    }
    saveSession();

    socket.emit('answerAck', { correct: null });
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });

  // Resposta aberta
  socket.on('answerOpen', ({ fields }) => {
    const playerId = socket._playerId;
    const p = playerId && state.participants[playerId];
    if (!p || state.phase !== 'question' || state.currentIndex < 0) return;
    const q = state.activeQuestions[state.currentIndex];
    if (q.type !== 'open') return;
    const key = `${playerId}_${state.currentIndex}`;
    if (state.answers[key]) return;

    const ms = Date.now() - state.questionStartedAt;
    const cleanFields = (Array.isArray(fields) ? fields : [fields])
      .map(f => String(f || '').trim().slice(0, 300));
    if (cleanFields.every(f => !f)) return;
    state.answers[key] = { fields: cleanFields, ms };
    saveSession();

    socket.emit('answerAck', { correct: null });
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });

  // Reação de participante a resposta aberta de outro
  socket.on('react', ({ targetPlayerId, value }) => {
    const reactorId = socket._playerId;
    if (!reactorId || state.phase !== 'reveal' || state.currentIndex < 0) return;
    if (reactorId === targetPlayerId) return; // não reage à própria resposta
    const q = state.activeQuestions[state.currentIndex];
    if (q?.type !== 'open') return;
    if (![-1, 0, 1, 2].includes(value)) return;

    if (!state.reactions[state.currentIndex]) state.reactions[state.currentIndex] = {};
    if (!state.reactions[state.currentIndex][targetPlayerId]) state.reactions[state.currentIndex][targetPlayerId] = {};
    // Só uma reação por alvo — bloqueado após escolher
    if (state.reactions[state.currentIndex][targetPlayerId][reactorId] !== undefined) return;

    state.reactions[state.currentIndex][targetPlayerId][reactorId] = value;
    saveSession();
    socket.emit('reactAck', { targetPlayerId, value });
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });

  // Navegação de página das respostas abertas (controlada pelo presenter)
  socket.on('openPageChange', ({ pin, page }) => {
    if (pin !== PRESENTER_PIN) return;
    state.openPage = page;
    const extra = buildPresenterExtra();
    io.emit('openPageSync', { page, openAnswers: extra.openAnswers || [] });
    io.to('presenter').emit('presenterExtra', extra);
  });

  // Presenter atribui/retira ponto em questão aberta
  socket.on('awardPoint', ({ pin, playerId, delta }) => {
    if (pin !== PRESENTER_PIN) return;
    const p = state.participants[playerId];
    if (!p) return;
    const qid = state.activeQuiz;
    if (!p.scores[qid]) p.scores[qid] = { score: 0, totalMs: 0 };
    p.scores[qid].score = Math.max(0, p.scores[qid].score + delta);
    saveSession();
    io.to('presenter').emit('presenterExtra', { ...buildPresenterExtra(), ranking: buildRanking() });
  });

  // Ranking de reações
  socket.on('reactionRanking', ({ pin }) => {
    if (pin !== PRESENTER_PIN) return;
    const qid = state.activeQuiz || 1;
    const qIdx = state.currentIndex;
    const qReactions = state.reactions[qIdx] || {};
    // Para cada participante que respondeu, calcular pontuação de reações
    const ranking = Object.entries(state.answers)
      .filter(([key, ans]) => key.endsWith(`_${qIdx}`) && ans.fields)
      .map(([key, ans]) => {
        const playerId = key.replace(`_${qIdx}`, '');
        const p = state.participants[playerId];
        if (!p) return null;
        const rxMap = qReactions[playerId] || {};
        const rxCounts = { '-1': 0, '0': 0, '1': 0, '2': 0 };
        let rxTotal = 0;
        Object.values(rxMap).forEach(v => { rxCounts[String(v)] = (rxCounts[String(v)] || 0) + 1; rxTotal += v; });
        return { playerId, name: p.name, fields: ans.fields, rxCounts, rxTotal };
      })
      .filter(Boolean)
      .sort((a, b) => b.rxTotal - a.rxTotal)
      .map((r, i) => ({ ...r, rank: i + 1 }));
    socket.emit('reactionRankingData', ranking);
  });

  socket.on('presenterJoin', ({ pin }) => {
    if (pin !== PRESENTER_PIN) return socket.emit('presenterError', 'PIN inválido');
    socket.join('presenter');
    socket.emit('presenterState', presenterFullState());
  });

  socket.on('cmd', ({ pin, action, quizId }) => {
    if (pin !== PRESENTER_PIN) return;

    // ── Selecionar quiz ───────────────────────────────────────────────────────
    if (action === 'selectQuiz') {
      state.activeQuiz = quizId;
      state.activeQuestions = state.questions.filter(q => q.quizId === quizId);
      state.phase = 'lobby';
      state.currentIndex = -1;
      state.answers = {};
      state.reactions = {};
      state.openPage = 0;
      state.questionStartedAt = null;
      // Não kicks participantes — eles continuam conectados entre quizes
      saveSession();
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', presenterFullState());
    }

    if (action === 'next') {
      if (state.activeQuestions.length === 0) return;
      const nextIndex = state.currentIndex + 1;
      if (nextIndex >= state.activeQuestions.length) {
        state.phase = 'finished';
        state.currentIndex = state.activeQuestions.length - 1;
        io.emit('state', buildPublicState());
        io.to('presenter').emit('presenterState', presenterFullState());
        return;
      }
      state.currentIndex = nextIndex;
      state.phase = 'question';
      state.openPage = 0;
      state.questionStartedAt = Date.now();
      saveSession();
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', presenterFullState());
    }

    if (action === 'ranking') {
      if (state.phase !== 'finished') return;
      state.phase = 'ranking';
      saveSession();
      const ranking = buildRanking();
      io.emit('state', { ...buildPublicState(), ranking });
      io.to('presenter').emit('presenterState', { ...presenterFullState(), ranking });
    }

    if (action === 'reveal') {
      if (state.phase !== 'question') return;
      state.phase = 'reveal';
      state.openPage = 0;
      saveSession();
      const publicState = buildPublicState();
      io.emit('state', publicState);
      const extra = buildPresenterExtra();
      io.to('presenter').emit('presenterState', { ...publicState, ...extra, ranking: buildRanking(), questions: state.questions });
      // Para questão aberta: emite a página 0 para os celulares reagem imediatamente
      if (state.activeQuestions[state.currentIndex]?.type === 'open') {
        const pageAnswers = (extra.openAnswers || []).slice(0, 3);
        io.emit('openPageSync', { page: 0, openAnswers: pageAnswers });
      }
    }

    // Volta à tela de seleção de quiz (mantém participantes)
    if (action === 'backToSelect') {
      state.activeQuiz = null;
      state.activeQuestions = [];
      state.phase = 'selectQuiz';
      state.currentIndex = -1;
      state.answers = {};
      state.questionStartedAt = null;
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', presenterFullState());
    }

    // Reset total (kicks todos)
    if (action === 'lobby') {
      state.activeQuiz = null;
      state.activeQuestions = [];
      state.phase = 'selectQuiz';
      state.currentIndex = -1;
      state.answers = {};
      state.reactions = {};
      state.openPage = 0;
      state.questionStartedAt = null;
      state.participants = {};
      clearSession();
      io.emit('kicked');
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', presenterFullState());
    }
  });

  socket.on('disconnect', () => {
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
  });
});

server.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
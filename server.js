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
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

function loadQuestions() {
  try {
    if (fs.existsSync(QUESTIONS_FILE)) {
      const raw = fs.readFileSync(QUESTIONS_FILE, 'utf8');
      const qs = JSON.parse(raw);
      // Migração: questões antigas sem quizId recebem quizId 1
      return qs.map(q => ({ quizId: 1, ...q }));
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
const state = {
  questions: loadQuestions(),
  activeQuiz: null,          // null = nenhum quiz selecionado ainda | 1 | 2
  activeQuestions: [],       // subconjunto filtrado de questions pelo activeQuiz
  phase: 'selectQuiz',       // 'selectQuiz' | 'lobby' | 'question' | 'reveal' | 'finished' | 'ranking'
  currentIndex: -1,          // índice dentro de activeQuestions
  participants: {},          // playerId → { name, socketId, scores: {1:{score,totalMs}, 2:{score,totalMs}} }
  answers: {},               // `${playerId}_${currentIndex}` → { optionIndex, ms, correct }
  questionStartedAt: null,
};

console.log(`Questões carregadas: ${state.questions.length}`);

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

app.post('/api/questions', uploadFields, (req, res) => {
  if (req.body.pin !== ADMIN_PIN) return res.status(401).json({ error: 'Não autorizado' });
  const { prompt, options, correctIndex, quizId } = req.body;
  const mediaFile = req.files?.media?.[0];
  const revealFile = req.files?.revealMedia?.[0];
  const q = {
    id: Date.now().toString(),
    quizId: parseInt(quizId || '1', 10),
    mediaType: mediaFile ? (mediaFile.mimetype.startsWith('video') ? 'video' : 'image') : null,
    mediaUrl: mediaFile ? `/uploads/${mediaFile.filename}` : null,
    revealMediaType: revealFile ? (revealFile.mimetype.startsWith('video') ? 'video' : 'image') : null,
    revealMediaUrl: revealFile ? `/uploads/${revealFile.filename}` : null,
    prompt,
    options: JSON.parse(options).map((label, i) => ({ label, correct: i === parseInt(correctIndex, 10) })),
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
  state.questionStartedAt = null;
  state.participants = {};
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
    currentIndex: state.currentIndex,
    totalQuestions: state.activeQuestions.length,
    question: q ? {
      id: q.id,
      mediaType: q.mediaType,
      mediaUrl: q.mediaUrl,
      revealMediaType: state.phase === 'reveal' ? (q.revealMediaType || null) : null,
      revealMediaUrl: state.phase === 'reveal' ? (q.revealMediaUrl || null) : null,
      prompt: q.prompt,
      optionLabels: q.options.map(o => o.label),
      correctIndex: state.phase === 'reveal' ? q.options.findIndex(o => o.correct) : null,
    } : null,
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
  const counts = q.options.map(() => 0);
  let total = 0;
  Object.keys(state.answers).forEach(key => {
    if (key.endsWith(`_${state.currentIndex}`)) {
      const { optionIndex } = state.answers[key];
      if (optionIndex != null) { counts[optionIndex]++; total++; }
    }
  });
  return { answerCounts: counts, answerTotal: total, participantCount: Object.keys(state.participants).length };
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
        scores: { 1: { score: 0, totalMs: 0 }, 2: { score: 0, totalMs: 0 } }
      };
    }
    socket._playerId = playerId;
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

    socket.emit('answerAck', { correct: null });
    io.to('presenter').emit('presenterExtra', buildPresenterExtra());
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
      state.questionStartedAt = null;
      // Não kicks participantes — eles continuam conectados entre quizes
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
      state.questionStartedAt = Date.now();
      io.emit('state', buildPublicState());
      io.to('presenter').emit('presenterState', presenterFullState());
    }

    if (action === 'ranking') {
      if (state.phase !== 'finished') return;
      state.phase = 'ranking';
      const ranking = buildRanking();
      io.emit('state', { ...buildPublicState(), ranking });
      io.to('presenter').emit('presenterState', { ...presenterFullState(), ranking });
    }

    if (action === 'reveal') {
      if (state.phase !== 'question') return;
      state.phase = 'reveal';
      const publicState = buildPublicState();
      io.emit('state', publicState);
      io.to('presenter').emit('presenterState', { ...publicState, ...buildPresenterExtra(), ranking: buildRanking(), questions: state.questions });
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
      state.questionStartedAt = null;
      state.participants = {};
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